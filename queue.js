// queue.js
const { Queue, Worker } = require('bullmq'); // Removed Job import as it's not directly used here
const IORedis = require('ioredis');
const axios = require('axios');
const mongoose = require('mongoose'); // Need mongoose to access models

// --- Configuration ---
// ... (Keep Redis, OpenAI, Apify config) ...
const REDIS_URL = process.env.REDIS_URL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
/* ... Check ENV VARS ... */ if (!REDIS_URL || !OPENAI_API_KEY) { console.error("FATAL: Missing REDIS_URL or OPENAI_API_KEY in worker!"); process.exit(1); }

// --- Redis Connection ---
// ... (Keep connection setup) ...
const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
connection.on('error', err => { console.error('Redis Worker Connection Error:', err); });
connection.on('connect', () => { console.log('Worker connected to Redis.'); });


// --- Queue Definition ---
const queueName = 'email-generation';
const emailGenerationQueue = new Queue(queueName, { connection });
console.log(`Email Generation Queue '${queueName}' initialized.`);

// --- Helper Functions (Could be shared) ---
function constructOpenAIPrompt(generationParams, scrapedProfileData) { /* ... same as previous ... */ }
function parseOpenAIResponse(rawContent, expectedCount) { /* ... same as previous ... */ }

// --- Worker Definition ---
console.log(`Starting Worker for queue '${queueName}'...`);
const worker = new Worker(queueName, async (job) => {
  console.log(`\n--- Processing Job ID: ${job.id} (DB ID: ${job.data.mongoJobId}) ---`);
  const { mongoJobId, scrapedData, originalParams } = job.data;
  // *** Access model via mongoose.models ***
  const JobModel = mongoose.models.Job;

  if (!JobModel) {
      console.error(`Job model not found for job ${job.id}. Mongoose connection/init issue?`);
      throw new Error("Job model unavailable in worker."); // Fail job
  }

  const sequenceLength = originalParams.sequenceLength;
  const allGeneratedSequences = [];
  const allWarnings = [];

  try {
    console.log(`Job ${job.id}: Starting OpenAI loop for ${originalParams.linkedinUrls.length} URLs...`);
    // *** Process URLs in Parallel ***
    const promises = originalParams.linkedinUrls.map(async (url) => { /* ... OpenAI call logic inside map ... */
        const profileData = scrapedData.find(p => p.linkedinUrl === url) || { linkedinUrl: url }; const leadFirstName = profileData.firstName || "VP"; let sequenceResult = { leadUrl: url, leadName: leadFirstName, emails: Array(sequenceLength).fill({ subject: "Proc Error", body: "Unknown error." }) }; try { const prompt = constructOpenAIPrompt(originalParams, profileData); const openaiResponse = await axios.post( OPENAI_CHAT_COMPLETIONS_URL, { model: "gpt-4o", messages: [{ role: "user", content: prompt }], max_tokens: 1500, temperature: 0.7 }, { headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` }, timeout: 60000 } ); const generatedText = openaiResponse.data?.choices?.[0]?.message?.content; if (!generatedText) { console.warn(`Job ${job.id}: OpenAI empty for ${leadFirstName}.`); allWarnings.push(`OpenAI empty ${leadFirstName}.`); sequenceResult.emails = Array(sequenceLength).fill({ subject: "Gen Error", body: "Failed (empty AI)." }); } else { const parsedEmails = parseOpenAIResponse(generatedText, sequenceLength); if (parsedEmails.length < sequenceLength) { console.warn(`Job ${job.id}: Parse mismatch ${leadFirstName}: ${parsedEmails.length}/${sequenceLength}.`); allWarnings.push(`Parse fail ${leadFirstName} (${parsedEmails.length}/${sequenceLength}).`); while (parsedEmails.length < sequenceLength) { parsedEmails.push({ subject: "Parse Error", body: `Parse step ${parsedEmails.length + 1} fail.` }); } sequenceResult.emails = parsedEmails.slice(0, sequenceLength); } else if (parsedEmails.length > sequenceLength) { console.warn(`Job ${job.id}: Parsing >${sequenceLength} for ${leadFirstName}. Truncating.`); allWarnings.push(`Parsing >${sequenceLength} ${leadFirstName}. Truncate.`); sequenceResult.emails = parsedEmails.slice(0, sequenceLength); } else { sequenceResult.emails = parsedEmails; } } } catch (openaiError) { const errorDetail = openaiError.response?.data?.error?.message || openaiError.message; console.error(`Job ${job.id}: OpenAI Error ${leadFirstName}:`, errorDetail); allWarnings.push(`OpenAI fail ${leadFirstName}: ${errorDetail}`); sequenceResult.emails = Array(sequenceLength).fill({ subject: "OpenAI API Error", body: `Failed: ${errorDetail}` }); } return sequenceResult;
    }); // End map

    const resultsForAllUrls = await Promise.all(promises);
    allGeneratedSequences.push(...resultsForAllUrls);

    // Update DB Job Status
    console.log(`Job ${job.id}: OpenAI finished. Updating DB status to COMPLETED.`);
    await JobModel.findByIdAndUpdate(mongoJobId, {
        status: 'COMPLETED',
        results: { sequences: allGeneratedSequences, warnings: allWarnings },
        error: null, updatedAt: Date.now()
    });
    console.log(`Job ${job.id} (DB ${mongoJobId}) marked COMPLETED.`);
    return { finalStatus: 'COMPLETED', sequencesGenerated: allGeneratedSequences.length };

  } catch (processingError) {
      console.error(`Job ${job.id}: FATAL worker processing error:`, processingError);
       try { await JobModel.findByIdAndUpdate(mongoJobId, { status: 'FAILED', error: `Worker fail: ${processingError.message}`, updatedAt: Date.now() }); console.log(`Job ${job.id} (DB ${mongoJobId}) marked FAILED.`); }
       catch (dbError) { console.error(`Job ${job.id}: Failed update DB status to FAILED:`, dbError); }
      throw processingError; // Re-throw for BullMQ
  }
}, { connection, concurrency: 5 }); // Adjust concurrency as needed

// --- Worker Event Listeners ---
worker.on('completed', (job, returnValue) => { console.log(`Job ${job.id} completed. Result:`, returnValue); });
worker.on('failed', (job, err) => { console.error(`Job ${job.id} failed: ${err.message}`); });
worker.on('error', err => { console.error('BullMQ Worker Error:', err); });

console.log('Email Generation Worker setup complete.');

// Export the queue for index.js
module.exports = { emailGenerationQueue };