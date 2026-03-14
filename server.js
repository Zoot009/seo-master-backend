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
import puppeteer from 'puppeteer';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'pg';
import { analyzeSEO } from './seo-analyzer.js';
import { validateSchema } from './schema-validator.js';
import { generatePDF } from './pdf-generator.js';
import { crawlSite } from './site-crawler.js';

const { Pool } = pkg;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY;

// ---------------------------------------------------------------------------
// Concurrency limiter — prevents the server from spawning too many Chrome
// instances simultaneously.  When the limit is reached, new requests wait
// in a queue (up to QUEUE_TIMEOUT ms) before being rejected with 503.
// ---------------------------------------------------------------------------
const MAX_CONCURRENT_ANALYSES = parseInt(process.env.MAX_CONCURRENT_ANALYSES || "3", 10);
const QUEUE_TIMEOUT_MS        = parseInt(process.env.QUEUE_TIMEOUT_MS        || "120000", 10); // 2 min

class Semaphore {
  constructor(max) {
    this.max   = max;
    this.count = 0;
    this.queue = [];
  }
  acquire() {
    if (this.count < this.max) {
      this.count++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex(q => q.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error("Server is busy — too many concurrent analyses. Please try again in a moment."));
      }, QUEUE_TIMEOUT_MS);
      this.queue.push({ resolve, timer });
    });
  }
  release() {
    this.count = Math.max(0, this.count - 1);
    const next = this.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      this.count++;
      next.resolve();
    }
  }
  get queued() { return this.queue.length; }
  get active() { return this.count; }
}

const analysisSemaphore = new Semaphore(MAX_CONCURRENT_ANALYSES);
const crawlSemaphore    = new Semaphore(Math.max(1, MAX_CONCURRENT_ANALYSES - 1));

// DB pool for backlink storage
const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase') ? { rejectUnauthorized: false } : false,
});

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

// Increase body size limit for large reports with screenshots
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

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
    timestamp: new Date().toISOString(),
    queue: {
      analysis: { active: analysisSemaphore.active, queued: analysisSemaphore.queued, max: analysisSemaphore.max },
      crawl:    { active: crawlSemaphore.active,    queued: crawlSemaphore.queued,    max: crawlSemaphore.max },
    },
  });
});

// SEO Analysis endpoint (auth required)
app.post('/api/analyze', authenticateApiKey, async (req, res) => {
  const { url, reportId } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required and must be a string' });
  }

  console.log(`[BACKEND] Queuing SEO analysis for: ${url} (active=${analysisSemaphore.active}, queued=${analysisSemaphore.queued})`);

  try {
    await analysisSemaphore.acquire();
  } catch (queueErr) {
    console.warn(`[BACKEND] Queue rejected: ${queueErr.message}`);
    return res.status(503).json({ success: false, error: queueErr.message, reportId });
  }

  // Hard cap: 90s per analysis — prevents one hung Chrome from blocking the queue forever
  const ANALYSIS_TIMEOUT_MS = parseInt(process.env.ANALYSIS_TIMEOUT_MS || "90000", 10);

  let released = false;
  const release = () => { if (!released) { released = true; analysisSemaphore.release(); } };

  const timeoutHandle = setTimeout(() => {
    release();
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        error: 'Analysis timed out — the target website took too long to respond.',
        reportId,
      });
    }
  }, ANALYSIS_TIMEOUT_MS);

  try {
    console.log(`[BACKEND] Starting SEO analysis for: ${url} (Report ID: ${reportId || 'N/A'})`);
    const result = await analyzeSEO(url);
    clearTimeout(timeoutHandle);
    release();
    console.log(`[BACKEND] Analysis completed for: ${url}`);

    if (!res.headersSent) {
      res.json({ success: true, data: result, reportId });
    }
  } catch (error) {
    clearTimeout(timeoutHandle);
    release();
    console.error('[BACKEND] Analysis error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message || 'Failed to analyze website',
        reportId,
      });
    }
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

// PDF Generation endpoint (auth required)
app.post('/api/generate-pdf', authenticateApiKey, async (req, res) => {
  try {
    const { reportData } = req.body;

    // Validate report data
    if (!reportData || typeof reportData !== 'object') {
      return res.status(400).json({ error: 'Report data is required' });
    }

    console.log(`[BACKEND] Starting PDF generation for: ${reportData.url || 'Unknown URL'}`);
    console.log(`[BACKEND] Report data size: ${JSON.stringify(reportData).length} bytes`);

    // Generate PDF
    let pdfBuffer = await generatePDF(reportData);

    // Ensure it's a Buffer (convert from Uint8Array if needed)
    if (!Buffer.isBuffer(pdfBuffer)) {
      pdfBuffer = Buffer.from(pdfBuffer);
    }

    console.log(`[BACKEND] PDF generation completed, buffer size: ${pdfBuffer.length} bytes`);

    // Validate PDF buffer
    if (pdfBuffer.length === 0) {
      throw new Error('Invalid PDF buffer generated - empty buffer');
    }

    // Set headers for PDF download
    const hostname = reportData.url ? reportData.url.replace(/^https?:\/\//, '').replace(/\//g, '-') : 'report';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="seo-report-${hostname}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    // Send PDF
    res.send(pdfBuffer);

  } catch (error) {
    console.error('[BACKEND] PDF generation error:', error);
    console.error('[BACKEND] Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to generate PDF'
    });
  }
});

// Site Crawl endpoint — discovers and audits every page on a website
app.post('/api/crawl-site', authenticateApiKey, async (req, res) => {
  const { url, concurrency } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required and must be a string' });
  }

  console.log(`[BACKEND] Queuing site crawl for: ${url} (active=${crawlSemaphore.active}, queued=${crawlSemaphore.queued})`);

  try {
    await crawlSemaphore.acquire();
  } catch (queueErr) {
    return res.status(503).json({ success: false, error: queueErr.message });
  }

  const CRAWL_TIMEOUT_MS = parseInt(process.env.CRAWL_TIMEOUT_MS || "300000", 10); // 5 min

  let released = false;
  const release = () => { if (!released) { released = true; crawlSemaphore.release(); } };

  const timeoutHandle = setTimeout(() => {
    release();
    if (!res.headersSent) {
      res.status(504).json({ success: false, error: 'Site crawl timed out.' });
    }
  }, CRAWL_TIMEOUT_MS);

  try {
    const options = {
      concurrency: typeof concurrency === 'number' && concurrency > 0 ? concurrency : 10,
    };

    console.log(`[BACKEND] Starting site crawl for: ${url}`);
    const result = await crawlSite(url, options);
    clearTimeout(timeoutHandle);
    release();
    console.log(`[BACKEND] Site crawl completed: ${result.pages.length} pages`);

    if (!res.headersSent) {
      res.json({ success: true, data: result });
    }
  } catch (error) {
    clearTimeout(timeoutHandle);
    release();
    console.error('[BACKEND] Site crawl error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message || 'Failed to crawl site' });
    }
  }
});

// Lighthouse Performance endpoint — runs real Lighthouse audit on any URL
app.post('/api/lighthouse', authenticateApiKey, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  let chrome;
  try {
    console.log(`[LIGHTHOUSE] Starting audit for: ${url}`);

    const { launch } = await import('chrome-launcher');
    const { default: lighthouse } = await import('lighthouse');

    chrome = await launch({ chromeFlags: ['--headless', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });

    const runAudit = async (strategy) => {
      const cfg = {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: ['performance'],
          formFactor: strategy,
          screenEmulation: strategy === 'desktop'
            ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
            : { mobile: true, width: 375, height: 667, deviceScaleFactor: 2, disabled: false },
          throttlingMethod: 'simulate',
        },
      };
      const result = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' }, cfg);
      return result.lhr;
    };

    // Must run sequentially — Lighthouse cannot handle concurrent audits on the same Chrome instance
    const desktopLhr = await runAudit('desktop');
    const mobileLhr  = await runAudit('mobile');

    const extractMetrics = (lhr) => {
      const a = lhr.audits;
      const score = Math.round((lhr.categories?.performance?.score ?? 0) * 100);
      const fmt = (key) => a[key]?.displayValue ?? 'N/A';
      const num = (key) => a[key]?.numericValue ?? 0;
      return {
        score,
        lcp: fmt('largest-contentful-paint'),  lcpVal: num('largest-contentful-paint'),
        tbt: fmt('total-blocking-time'),        tbtVal: num('total-blocking-time'),
        cls: fmt('cumulative-layout-shift'),    clsVal: num('cumulative-layout-shift'),
        fcp: fmt('first-contentful-paint'),
        si:  fmt('speed-index'),
      };
    };

    console.log(`[LIGHTHOUSE] Audit completed for: ${url}`);
    res.json({ success: true, desktop: extractMetrics(desktopLhr), mobile: extractMetrics(mobileLhr) });

  } catch (error) {
    console.error('[LIGHTHOUSE] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    if (chrome) {
      try { await chrome.kill(); } catch (_) {}
    }
  }
});

// Backlink Crawler endpoint — crawls a site and discovers all internal + external links
app.post('/api/crawl-backlinks', authenticateApiKey, async (req, res) => {
  const { url, maxPages = 40, maxDepth = 2 } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  let startUrl;
  try {
    startUrl = new URL(url.startsWith('http') ? url : 'https://' + url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL provided' });
  }

  const baseDomain = startUrl.hostname;
  console.log(`[BACKLINK] Starting crawl for: ${baseDomain} (max ${maxPages} pages)`);

  try {
    // Clear old data for this domain so results are always fresh
    await dbPool.query('DELETE FROM backlinks WHERE target_domain = $1', [baseDomain]);

    const visited = new Set();
    const queue = [startUrl.href];
    const allLinks = [];
    let pagesCrawled = 0;

    while (queue.length > 0 && pagesCrawled < maxPages) {
      const pageUrl = queue.shift();
      if (visited.has(pageUrl)) continue;
      visited.add(pageUrl);
      pagesCrawled++;

      try {
        const { data: html } = await axios.get(pageUrl, {
          timeout: 12000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEOmaster-Crawler/1.0)' },
          maxRedirects: 3,
        });

        const $ = cheerio.load(html);

        $('a[href]').each((_, el) => {
          const href = $(el).attr('href');
          if (!href || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#') || href.startsWith('javascript:')) return;

          try {
            const linkUrl = new URL(href, pageUrl);
            if (!linkUrl.protocol.startsWith('http')) return;

            const relAttr = ($(el).attr('rel') || '').toLowerCase().split(/\s+/);
            const isNoFollow = relAttr.includes('nofollow') || relAttr.includes('ugc') || relAttr.includes('sponsored');
            const anchorText = $(el).text().trim().replace(/\s+/g, ' ').slice(0, 200) || '[No Anchor Text]';

            allLinks.push({
              source_url: pageUrl,
              target_url: linkUrl.href,
              target_domain: baseDomain,
              anchor_text: anchorText,
              is_nofollow: isNoFollow,
              link_domain: linkUrl.hostname,
            });

            // Only follow links within the same domain to build the crawl
            if (linkUrl.hostname === baseDomain && !visited.has(linkUrl.href) && queue.length < maxPages * 2) {
              queue.push(linkUrl.href);
            }
          } catch {}
        });

        console.log(`[BACKLINK] Crawled (${pagesCrawled}/${maxPages}): ${pageUrl}`);
      } catch (err) {
        console.log(`[BACKLINK] Skipped ${pageUrl}: ${err.message}`);
      }
    }

    // Deduplicate by source+target
    const unique = new Map();
    for (const link of allLinks) {
      const key = `${link.source_url}=>${link.target_url}`;
      unique.set(key, link);
    }
    const toSave = Array.from(unique.values());

    // Batch insert
    for (const link of toSave) {
      await dbPool.query(
        'INSERT INTO backlinks (source_url, target_url, target_domain) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [link.source_url, link.target_url, link.target_domain]
      );
    }

    console.log(`[BACKLINK] Done: ${pagesCrawled} pages crawled, ${toSave.length} links saved for ${baseDomain}`);

    res.json({
      success: true,
      domain: baseDomain,
      pagesCrawled,
      totalLinks: toSave.length,
      links: toSave,
    });
  } catch (error) {
    console.error('[BACKLINK] Error:', error);
    res.status(500).json({ success: false, error: error.message });
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
