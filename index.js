const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());

// --- Environment Variables ---
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!APIFY_TOKEN) {
  console.warn("WARNING: APIFY_TOKEN not set. Scraping may fail.");
}
if (!OPENAI_API_KEY) {
  console.error("FATAL: OPENAI_API_KEY not set.");
}

// --- CORS Configuration ---
const extensionOrigin = "chrome-extension://cddlnbjaagmmldhnkccjmnhmdkfngoji";
app.use(cors({
  origin: extensionOrigin,
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 200,
}));

// --- Helper Function: Construct OpenAI Prompt ---
function constructOpenAIPrompt(generationParams, scrapedProfileData) {
  const escape = (str) => str ? String(str).replace(/`/g, "'").replace(/\n/g, " ").replace(/"/g, "'") : "";

  const {
    firstName, fullName, jobTitle, companyName, companyIndustry,
    addressWithoutCountry, addressWithCountry, about, updates,
    companySize, companyWebsite,
  } = scrapedProfileData;

  const leadFirstName = escape(firstName) || "Prospect";
  const leadFullName = escape(fullName) || leadFirstName;
  const leadJobTitle = escape(jobTitle) || "N/A";
  const leadCompany = escape(companyName) || "N/A";
  const leadIndustry = escape(companyIndustry) || "N/A";
  const leadLocation = escape(addressWithoutCountry || addressWithCountry) || "N/A";
  const leadAbout = escape(about || "");
  const leadRecentPostSnippet = updates?.[0]?.postText
    ? escape(updates[0].postText.substring(0, 150)) + (updates[0].postText.length > 150 ? "..." : "")
    : "";
  const leadCompanySize = escape(companySize) || "N/A";
  const leadCompanyWebsite = escape(companyWebsite || "");

  const prompt = `
You are an expert B2B SDR writing a highly personalized cold email sequence using LinkedIn profile data.

Your Goal: Write a ${generationParams.sequenceLength}-email sequence to initiate contact and achieve the goal: "${escape(generationParams.goal)}".

Your Identity:
- Name: ${escape(generationParams.fullName) || "Jake"}
- Role: ${escape(generationParams.roleTitle) || "Founder"}
- Website: ${escape(generationParams.website) || "yourcompany.com"}
- Offer: ${escape(generationParams.offer) || "We provide valuable solutions."}
- Industry: ${escape(generationParams.industry)}
${generationParams.caseStudy ? `- Case Study: ${escape(generationParams.caseStudy)}` : ""}
${generationParams.businessDescription ? `- Business Description: ${escape(generationParams.businessDescription)}` : ""}

Prospect Info (from LinkedIn):
- First Name: ${leadFirstName}
- Full Name: ${leadFullName}
- Job Title: ${leadJobTitle}
- Company: ${leadCompany}
- Company Size: ${leadCompanySize}
- Industry: ${leadIndustry}
${leadCompanyWebsite ? `- Website: ${leadCompanyWebsite}` : ""}
- Location: ${leadLocation}
${leadAbout ? `- About Snippet: ${leadAbout.substring(0, 300)}${leadAbout.length > 300 ? "..." : ""}` : ""}
${leadRecentPostSnippet ? `- Recent Post Snippet: ${leadRecentPostSnippet}` : ""}

Sequence Requirements:
- Length: Exactly ${generationParams.sequenceLength} emails
- Personalization: Subtly weave in the above details
- Tone: ${escape(generationParams.tone) || "Professional and helpful"}

STRICT FORMAT:
For each email:
- Start with ***EMAIL [Step Number]***
- Subject line first: "Subject: ..."
- Body follows immediately
- Start body with "Hi ${leadFirstName},"
- End with your name (${escape(generationParams.fullName) || "Jake"})

Begin generation now.
`;
  return prompt;
}

// --- Helper Function: Parse OpenAI Response ---
function parseOpenAIResponse(rawContent, expectedCount) {
  if (!rawContent) return [];

  const emails = [];
  const parts = rawContent.split(/\*\*\*EMAIL\s+\d+\*\*\*/i).slice(1);
  for (let i = 0; i < parts.length && emails.length < expectedCount; i++) {
    const part = parts[i].trim();
    const subjectMatch = part.match(/^Subject:\s*(.*)/i);
    const subject = subjectMatch ? subjectMatch[1].trim() : `Email ${i + 1}`;
    const body = subjectMatch ? part.slice(subjectMatch.index + subjectMatch[0].length).trim() : part;
    emails.push({ subject, body });
  }
  return emails;
}

// --- Main Endpoint ---
app.post("/scrape-linkedin", async (req, res) => {
  const { generationParams } = req.body;

  if (!generationParams || !Array.isArray(generationParams.linkedinUrls) || !generationParams.linkedinUrls.length) {
    return res.status(400).json({ error: "linkedinUrls missing or empty" });
  }

  const profileUrls = generationParams.linkedinUrls;
  const sequenceLength = generationParams.sequenceLength || 3;
  const scrapedData = [];
  const generatedSequences = [];

  // Scrape via Apify
  if (APIFY_TOKEN) {
    try {
      const apifyUrl = `https://api.apify.com/v2/acts/dev_fusion~linkedin-profile-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
      const { data } = await axios.post(apifyUrl, { profileUrls }, {
        headers: { "Content-Type": "application/json" },
        timeout: 180000,
      });
      scrapedData.push(...data);
    } catch (error) {
      console.error("Apify Error:", error.message);
      return res.status(500).json({ error: "Failed to scrape profiles." });
    }
  } else {
    return res.status(500).json({ error: "APIFY_TOKEN not set on server." });
  }

  // Generate emails for each scraped profile
  for (const profile of scrapedData) {
    const prompt = constructOpenAIPrompt(generationParams, profile);

    try {
      const openaiResponse = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
      }, {
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      });

      const rawContent = openaiResponse.data.choices[0].message.content;
      const parsed = parseOpenAIResponse(rawContent, sequenceLength);
      generatedSequences.push({
        profileUrl: profile.url || "Unknown",
        emails: parsed,
      });

    } catch (err) {
      console.error("OpenAI API error:", err.response?.data || err.message);
      return res.status(500).json({ error: "OpenAI API call failed." });
    }
  }

  res.json({ success: true, data: generatedSequences });
});

// --- Server Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
