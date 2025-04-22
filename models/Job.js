// models/Job.js
const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  status: {
    type: String,
    required: true,
    enum: ['PENDING_SCRAPE', 'SCRAPING_STARTED', 'SCRAPING_RUNNING', 'GENERATING_EMAILS', 'COMPLETED', 'FAILED', 'APIFY_FAILED'],
    default: 'PENDING_SCRAPE'
  },
  apifyRunId: { type: String, index: true },
  apifyDatasetId: { type: String },
  requestParams: { type: Object, required: true },
  results: {
    sequences: { type: Array },
    warnings: { type: Array }
  },
  error: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update 'updatedAt' timestamp before saving
jobSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});
// Add index for faster status checks per user
jobSchema.index({ userId: 1, status: 1 });

// Compile and export the model ONLY if it doesn't already exist
// This prevents the OverwriteModelError during hot-reloads or complex require scenarios
module.exports = mongoose.models.Job || mongoose.model('Job', jobSchema);