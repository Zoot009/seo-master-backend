/**
 * SEO Analyzer Backend - Core Service
 * 
 * This is the main backend server that handles all SEO analysis.
 * It runs independently on a VPS and is called by the Next.js frontend.
 * 
 * Architecture:
 * - Express.js server with API key authentication
 * - Puppeteer for web scraping and screenshots
 * - Cheerio for HTML parsing and analysis
 * - CORS enabled for frontend access
 * 
 * Endpoints:
 * - GET  /health         - Health check (no auth required)
 * - POST /api/analyze    - SEO analysis (requires X-API-Key header)
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { analyzeSEO } from './seo-analyzer.js';
import { validateSchema } from './schema-validator.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY;

// Security middleware
app.use(helmet());

// CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'];
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// API Key authentication middleware
const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
  }
  
  next();
};

// Health check endpoint (no auth required)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'SEO Analyzer Backend',
    timestamp: new Date().toISOString()
  });
});

// SEO Analysis endpoint (auth required)
app.post('/api/analyze', authenticateApiKey, async (req, res) => {
  try {
    const { url, reportId } = req.body;

    // Validate URL
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required and must be a string' });
    }

    console.log(`[BACKEND] Starting SEO analysis for: ${url} (Report ID: ${reportId || 'N/A'})`);

    // Perform SEO analysis
    const result = await analyzeSEO(url);

    console.log(`[BACKEND] Analysis completed for: ${url}`);

    res.json({
      success: true,
      data: result,
      reportId
    });

  } catch (error) {
    console.error('[BACKEND] Analysis error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to analyze website',
      reportId: req.body.reportId
    });
  }
});

// Schema Markup Validation endpoint (auth required)
app.post('/api/validate-schema', authenticateApiKey, async (req, res) => {
  try {
    const { url } = req.body;

    // Validate URL
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'URL is required and must be a string' });
    }

    console.log(`[BACKEND] Starting schema validation for: ${url}`);

    // Validate schema markup
    const result = await validateSchema(url);

    console.log(`[BACKEND] Schema validation completed for: ${url}`);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('[BACKEND] Schema validation error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to validate schema markup'
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`SEO Analyzer Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
});
