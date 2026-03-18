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
import rateLimit from 'express-rate-limit';
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
// URL sanitizer — ensures only valid public http(s) URLs reach Puppeteer/Axios.
// Blocks private / loopback addresses to prevent SSRF.
// ---------------------------------------------------------------------------
function validateHttpUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  // Block loopback, link-local, and private RFC-1918 ranges
  if (
    host === 'localhost' ||
    /^127\./.test(host) ||
    /^0\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host === '::1' ||
    host === '0.0.0.0'
  ) return null;
  return parsed.href;
}

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

const analysisSemaphore  = new Semaphore(MAX_CONCURRENT_ANALYSES);
const crawlSemaphore     = new Semaphore(Math.max(1, MAX_CONCURRENT_ANALYSES - 1));
// Lighthouse uses global performance.mark() — concurrent runs corrupt each other's marks.
// Use a mutex (max=1) to serialize all Lighthouse audits.
const lighthouseSemaphore = new Semaphore(1);

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

// ---------------------------------------------------------------------------
// Rate limiting
// General: 60 req/min per IP on all /api/* routes.
// Heavy:   10 req/min on CPU/browser-intensive endpoints.
// ---------------------------------------------------------------------------
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again in a minute.' },
});
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests for this endpoint — please slow down.' },
});
app.use('/api/', generalLimiter);
['/api/analyze', '/api/crawl-site', '/api/lighthouse', '/api/crawl-backlinks', '/api/generate-pdf'].forEach(
  (path) => app.use(path, heavyLimiter)
);

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
  const { url: rawUrl, reportId } = req.body;
  const url = validateHttpUrl(rawUrl);

  if (!url) {
    return res.status(400).json({ error: 'A valid public http:// or https:// URL is required' });
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
    const url = validateHttpUrl(req.body.url);

    if (!url) {
      return res.status(400).json({ error: 'A valid public http:// or https:// URL is required' });
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
  const url = validateHttpUrl(req.body.url);
  const { concurrency, maxPages } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'A valid public http:// or https:// URL is required' });
  }

  console.log(`[BACKEND] Queuing site crawl for: ${url} (active=${crawlSemaphore.active}, queued=${crawlSemaphore.queued})`);

  try {
    await crawlSemaphore.acquire();
  } catch (queueErr) {
    return res.status(503).json({ success: false, error: queueErr.message });
  }

  const CRAWL_TIMEOUT_MS = parseInt(process.env.CRAWL_TIMEOUT_MS || "1200000", 10); // 20 min (crawl + lighthouse)

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
      concurrency: typeof concurrency === 'number' && concurrency > 0 ? concurrency : 15,
      maxPages: Math.min(typeof maxPages === 'number' && maxPages > 0 ? maxPages : 500, 500),
    };

    console.log(`[BACKEND] Starting site crawl for: ${url}`);
    const result = await crawlSite(url, options);
    console.log(`[BACKEND] Site crawl completed: ${result.pages.length} pages — running Lighthouse...`);

    // Run Lighthouse BEFORE releasing the crawl semaphore so no new crawl
    // can start while Lighthouse is consuming CPU on this same job.
    let psi = null;
    try {
      await lighthouseSemaphore.acquire();
      try {
        console.log(`[LIGHTHOUSE] Starting audit for: ${url}`);
        const { desktop, mobile } = await runLighthouseAudit(url);
        psi = { desktop, mobile };
        console.log(`[LIGHTHOUSE] Audit completed for: ${url}`);
      } finally {
        lighthouseSemaphore.release();
      }
    } catch (lhErr) {
      console.warn(`[LIGHTHOUSE] Audit skipped (non-fatal): ${lhErr.message}`);
    }

    clearTimeout(timeoutHandle);
    release();

    if (!res.headersSent) {
      res.json({ success: true, data: { ...result, psi } });
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

// ---------------------------------------------------------------------------
// Shared Lighthouse helper — serialized via lighthouseSemaphore
// ---------------------------------------------------------------------------
async function runLighthouseAudit(url) {
  const { launch } = await import('chrome-launcher');
  const { default: lighthouse } = await import('lighthouse');

  const CHROME_FLAGS = [
    '--headless', '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', '--disable-extensions',
    '--disable-background-networking', '--disable-default-apps',
  ];

  const runAudit = async (strategy, chrome) => {
    const cfg = {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance'],
        formFactor: strategy,
        screenEmulation: strategy === 'desktop'
          ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
          : { mobile: true, width: 375, height: 667, deviceScaleFactor: 2, disabled: false },
        throttlingMethod: 'simulate',
        maxWaitForFcp: 30000,
        maxWaitForLoad: 45000,
      },
    };
    const result = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error' }, cfg);
    return result.lhr;
  };

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

  // Lighthouse uses global process-level performance marks — parallel runs on
  // the same Node.js process corrupt each other even with separate Chrome instances.
  // Launch one Chrome, run both audits sequentially on it.
  const chrome = await launch({ chromeFlags: CHROME_FLAGS });
  try {
    const desktopLhr = await runAudit('desktop', chrome);
    const mobileLhr  = await runAudit('mobile', chrome);
    return { desktop: extractMetrics(desktopLhr), mobile: extractMetrics(mobileLhr) };
  } finally {
    await chrome.kill().catch(() => {});
  }
}

// Lighthouse Performance endpoint — runs real Lighthouse audit on any URL
app.post('/api/lighthouse', authenticateApiKey, async (req, res) => {
  const url = validateHttpUrl(req.body.url);
  if (!url) {
    return res.status(400).json({ error: 'A valid public http:// or https:// URL is required' });
  }

  try {
    await lighthouseSemaphore.acquire();
  } catch (queueErr) {
    return res.status(503).json({ success: false, error: queueErr.message });
  }

  try {
    console.log(`[LIGHTHOUSE] Starting audit for: ${url}`);
    const { desktop, mobile } = await runLighthouseAudit(url);
    console.log(`[LIGHTHOUSE] Audit completed for: ${url}`);
    res.json({ success: true, desktop, mobile });
  } catch (error) {
    console.error('[LIGHTHOUSE] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    lighthouseSemaphore.release();
  }
});

// Backlink Crawler endpoint — crawls a site and discovers all internal + external links
app.post('/api/crawl-backlinks', authenticateApiKey, async (req, res) => {
  const safeUrl = validateHttpUrl(req.body.url);
  // Clamp maxPages (1–200) and maxDepth (1–10) to prevent resource abuse
  const maxPages = Math.min(Math.max(1, parseInt(req.body.maxPages, 10) || 40), 200);
  const maxDepth = Math.min(Math.max(1, parseInt(req.body.maxDepth, 10) || 2), 10);

  if (!safeUrl) {
    return res.status(400).json({ error: 'A valid public http:// or https:// URL is required' });
  }

  const startUrl = new URL(safeUrl);
  const baseDomain = startUrl.hostname;
  console.log(`[BACKLINK] Starting crawl for: ${baseDomain} (max ${maxPages} pages, maxDepth ${maxDepth})`);

  try {
    // History is preserved — ON CONFLICT DO NOTHING avoids duplicates without wiping prior crawls
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
const server = app.listen(PORT, () => {
  console.log(`SEO Analyzer Backend running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — on SIGTERM/SIGINT, stop accepting new connections, wait
// for in-flight requests to finish (or force-exit after grace period), then
// close the DB pool so Postgres connections are released cleanly.
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  console.log(`[SHUTDOWN] Received ${signal}, shutting down gracefully…`);
  server.close(() => console.log('[SHUTDOWN] HTTP server closed.'));
  try {
    await dbPool.end();
    console.log('[SHUTDOWN] DB pool closed.');
  } catch (_) {}
  const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS || '10000', 10);
  setTimeout(() => {
    console.log('[SHUTDOWN] Force exit after grace period.');
    process.exit(0);
  }, graceMs).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
