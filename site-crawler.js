/**
 * Site Crawler - Multi-page website audit
 *
 * Full recursive BFS crawler: seeds from sitemaps, then follows every internal
 * link found on every crawled page — discovers all pages automatically.
 *
 * Proxy support: set PROXY_URL=http://user:pass@host:port in .env
 * Proxy is only used as a fallback when direct requests are blocked (403/CF).
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { parseStringPromise } from "xml2js";
import puppeteer from "puppeteer";
import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteerExtra.use(StealthPlugin());

// ---------------------------------------------------------------------------
// User-Agent rotation — reduces bot fingerprinting
// ---------------------------------------------------------------------------
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
];
function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ---------------------------------------------------------------------------
// Proxy support
// ---------------------------------------------------------------------------
function getProxyConfig() {
  const raw = process.env.PROXY_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const cfg = { protocol: u.protocol.replace(":", ""), host: u.hostname, port: parseInt(u.port, 10) };
    if (u.username) cfg.auth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    return cfg;
  } catch {
    console.warn("[CRAWLER] Invalid PROXY_URL — proxy disabled");
    return null;
  }
}

function isBlocked(status, headers, body) {
  // Status-independent CF check — catches JS challenges that return 200
  if (typeof body === "string") {
    const b = body.toLowerCase();
    if (
      b.includes("just a moment") ||
      b.includes("checking your browser") ||
      b.includes("cf-browser-verification") ||
      b.includes("performing security verification") ||
      b.includes("ddos-guard") ||
      (b.includes("enable javascript") && b.includes("cloudflare"))
    ) return true;
  }
  if (![403, 503, 429].includes(status)) return false;
  if (headers?.["cf-ray"] || headers?.server?.toLowerCase().includes("cloudflare")) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Stealth browser pool — shared across all pages in one crawl
// Launched lazily only when Cloudflare blocks axios + proxy
// ---------------------------------------------------------------------------
class StealthBrowserPool {
  constructor(concurrency, proxyConfig) {
    this.concurrency = concurrency;
    this.proxyConfig = proxyConfig;
    this.browser = null;
    this.available = [];  // idle Page objects
    this.pending = [];    // queued resolve callbacks waiting for a page
    this.total = 0;
  }

  async launch() {
    if (this.browser) return;
    const args = [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
    ];
    if (this.proxyConfig) {
      args.push(`--proxy-server=${this.proxyConfig.protocol}://${this.proxyConfig.host}:${this.proxyConfig.port}`);
    }
    this.browser = await puppeteerExtra.launch({ headless: true, args });
    console.log("[CRAWLER] Stealth browser launched for Cloudflare bypass");
    // Pre-warm a pool of tabs
    for (let i = 0; i < this.concurrency; i++) {
      const page = await this.browser.newPage();
      if (this.proxyConfig?.auth) {
        await page.authenticate({ username: this.proxyConfig.auth.username, password: this.proxyConfig.auth.password });
      }
      await page.setUserAgent(randomUA());
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
      this.available.push(page);
    }
    this.total = this.concurrency;
  }

  acquire() {
    return new Promise((resolve) => {
      if (this.available.length > 0) {
        resolve(this.available.pop());
      } else {
        this.pending.push(resolve);
      }
    });
  }

  release(page) {
    if (this.pending.length > 0) {
      const next = this.pending.shift();
      next(page);
    } else {
      this.available.push(page);
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }
}

/** Fetch a single URL using the stealth browser pool */
async function fetchPageStealth(url, pool) {
  const page = await pool.acquire();
  try {
    const start = Date.now();
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    // Wait a moment for CF challenge to resolve
    await new Promise(r => setTimeout(r, 1500));
    const html = await page.content();
    const loadTime = ((Date.now() - start) / 1000).toFixed(2);
    const status = response?.status() ?? 200;
    const headers = response?.headers() ?? {};
    pool.release(page);
    return { response: { status, headers }, loadTime, html };
  } catch (err) {
    pool.release(page);
    return { response: null, loadTime: 0, html: "", error: err };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizeUrl(raw) {
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return "https://" + raw;
  return raw;
}

function getDomain(url) {
  const u = new URL(url);
  return u.protocol + "//" + u.host;
}

/** Strip URL fragment and normalize for deduplication */
function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.href;
  } catch {
    return url;
  }
}

/** Returns false for images, fonts, documents, scripts, stylesheets, etc. */
function isPageUrl(url) {
  const assetExtensions = [
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".ico",
    ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".mkv",
    ".mp3", ".wav", ".ogg", ".m4a",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".zip", ".rar", ".tar", ".gz",
    ".ttf", ".woff", ".woff2", ".eot",
    ".js", ".css", ".xml", ".json", ".txt",
  ];
  const assetDirs = [
    "/wp-content/uploads/", "/assets/", "/static/", "/images/",
    "/img/", "/media/", "/files/", "/css/", "/js/",
  ];
  const lower = url.toLowerCase().split("?")[0];
  for (const ext of assetExtensions) {
    if (lower.endsWith(ext)) return false;
  }
  for (const dir of assetDirs) {
    if (lower.includes(dir)) return false;
  }
  return true;
}

function isSitemapEntry(url) {
  const lower = url.toLowerCase();
  return lower.includes("sitemap") || lower.endsWith(".xml") || lower.endsWith(".xml.gz");
}

// ---------------------------------------------------------------------------
// Sitemap discovery — seeds the BFS queue
// ---------------------------------------------------------------------------

async function getSitemapsFromRobots(domain) {
  const sitemaps = [];
  try {
    console.log("[CRAWLER] Checking robots.txt...");
    const res = await axios.get(`${domain}/robots.txt`, {
      timeout: 10000,
      headers: { "User-Agent": randomUA() },
    });
    for (const line of res.data.split("\n")) {
      if (line.toLowerCase().startsWith("sitemap:")) {
        const sm = line.split(":").slice(1).join(":").trim();
        if (sm) sitemaps.push(sm);
      }
    }
    console.log(`[CRAWLER] Found ${sitemaps.length} sitemap(s) in robots.txt`);
  } catch {
    console.log("[CRAWLER] robots.txt not accessible or not found");
  }
  return sitemaps;
}

/** Recursively resolves a sitemap or sitemap index, returns all page URLs */
async function resolveSitemap(sitemapUrl, visited = new Set()) {
  if (visited.has(sitemapUrl)) return [];
  visited.add(sitemapUrl);

  const urls = [];
  try {
    console.log(`[CRAWLER]  → Fetching sitemap: ${sitemapUrl}`);
    const res = await axios.get(sitemapUrl, {
      timeout: 15000,
      headers: { "User-Agent": randomUA() },
      responseType: "text",
    });

    const xml = await parseStringPromise(res.data, { explicitArray: true });

    // Sitemap index — recurse into each child sitemap
    if (xml.sitemapindex) {
      const children = xml.sitemapindex.sitemap || [];
      for (const child of children) {
        const loc = child.loc?.[0];
        if (loc) {
          const nested = await resolveSitemap(loc, visited);
          urls.push(...nested);
        }
      }
    }

    // Regular URL set
    if (xml.urlset) {
      const entries = xml.urlset.url || [];
      for (const entry of entries) {
        const loc = entry.loc?.[0];
        if (loc && !isSitemapEntry(loc)) {
          urls.push(loc);
        }
      }
    }

    console.log(`[CRAWLER]  ✓ ${urls.length} URLs from ${sitemapUrl}`);
  } catch {
    console.log(`[CRAWLER]  ✗ Failed to fetch/parse: ${sitemapUrl}`);
  }
  return urls;
}

/** Collect seed URLs from all sitemaps — these prime the BFS queue */
async function getSeedUrls(baseUrl) {
  const domain = getDomain(baseUrl);
  const seed = new Set();

  const robotsSitemaps = await getSitemapsFromRobots(domain);
  if (!robotsSitemaps.some(s => s.includes("sitemap.xml"))) {
    robotsSitemaps.push(`${domain}/sitemap.xml`);
  }

  const visited = new Set();
  for (const sm of robotsSitemaps) {
    const urls = await resolveSitemap(sm, visited);
    urls
      .filter(u => isPageUrl(u) && u.startsWith(domain))
      .forEach(u => seed.add(cleanUrl(u)));
  }

  // Always seed with homepage
  seed.add(cleanUrl(domain + "/"));
  seed.add(cleanUrl(baseUrl));

  console.log(`[CRAWLER] Seeded ${seed.size} URLs from sitemaps`);
  return [...seed];
}

// ---------------------------------------------------------------------------
// Per-page fetch with proxy fallback
// ---------------------------------------------------------------------------
async function fetchPage(url) {
  const proxyConfig = getProxyConfig();

  const attempt = async (useProxy) => {
    const config = {
      timeout: 12000,
      headers: {
        "User-Agent": randomUA(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      validateStatus: () => true,
      maxRedirects: 5,
    };
    if (useProxy && proxyConfig) config.proxy = proxyConfig;
    const start = Date.now();
    const response = await axios.get(url, config);
    const loadTime = ((Date.now() - start) / 1000).toFixed(2);
    const html = typeof response.data === "string" ? response.data : String(response.data);
    return { response, loadTime, html };
  };

  try {
    let result = await attempt(false);
    // If blocked (CF/WAF), retry through proxy
    if (proxyConfig && isBlocked(result.response?.status, result.response?.headers, result.html)) {
      console.log(`[CRAWLER] Blocked at ${url} — retrying via proxy`);
      try { result = await attempt(true); } catch {}
    }
    // If still blocked even via proxy, stealth browser pool will handle it
    // (handled in crawlPage — pool passed as argument)
    return result;
  } catch (err) {
    return { response: null, loadTime: 0, html: "", error: err };
  }
}

// ---------------------------------------------------------------------------
// Per-page analysis — returns page SEO data + discovered internal links
// ---------------------------------------------------------------------------
function analyzePageHtml(html, url, domain, status, loadTime, pageSizeKb) {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim() || null;
  const titleLength = title ? title.length : 0;
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || null;
  const metaLength = metaDescription ? metaDescription.length : 0;
  const canonical = $('link[rel="canonical"]').attr("href") || null;
  const robotsMeta = $('meta[name="robots"]').attr("content")?.toLowerCase() || "";
  const isNoindex = robotsMeta.includes("noindex");
  const isNofollow = robotsMeta.includes("nofollow");
  const h1Count = $("h1").length;
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;
  const h1Text = $("h1").first().text().trim() || null;

  const images = $("img");
  let missingAlt = 0;
  images.each((_, img) => {
    const alt = $(img).attr("alt");
    if (!alt || alt.trim().length === 0) missingAlt++;
  });

  let internalLinks = 0;
  let externalLinks = 0;
  const discoveredLinks = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    try {
      const abs = new URL(href, url).href;
      const clean = cleanUrl(abs);
      if (clean.startsWith(domain)) {
        internalLinks++;
        // Follow links unless page declares nofollow
        if (!isNofollow && isPageUrl(clean)) discoveredLinks.add(clean);
      } else if (href.startsWith("http")) {
        externalLinks++;
      }
    } catch {}
  });

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText.split(/\s+/).filter(w => w.length > 0).length;
  const hasOgTitle = $('meta[property="og:title"]').length > 0;
  const hasOgDescription = $('meta[property="og:description"]').length > 0;
  const hasOgImage = $('meta[property="og:image"]').length > 0;
  const hasSchema = $('script[type="application/ld+json"]').length > 0;

  function classifyStatus(s) {
    if (s >= 200 && s < 300) return "ok";
    if (s >= 300 && s < 400) return "redirect";
    if (s === 404) return "not_found";
    if (s === 403) return "forbidden";
    if (s === 401) return "auth_required";
    if (s === 429) return "rate_limited";
    if (s >= 500) return "server_error";
    if (s >= 400) return "client_error";
    return "error";
  }

  const issues = [];
  if (!title) issues.push("missing_title");
  else if (titleLength < 30) issues.push("title_too_short");
  else if (titleLength > 60) issues.push("title_too_long");
  if (!metaDescription) issues.push("missing_meta_description");
  else if (metaLength < 70) issues.push("meta_description_too_short");
  else if (metaLength > 160) issues.push("meta_description_too_long");
  if (h1Count === 0) issues.push("missing_h1");
  if (h1Count > 1) issues.push("multiple_h1");
  if (missingAlt > 0) issues.push("images_missing_alt");
  if (isNoindex) issues.push("noindex");
  if (!canonical) issues.push("missing_canonical");
  if (wordCount < 300) issues.push("thin_content");

  return {
    page: {
      url, status, statusClass: classifyStatus(status),
      loadTime: Number(loadTime), pageSizeKb: Number(pageSizeKb),
      title, titleLength, metaDescription, metaLength, canonical,
      isNoindex, isNofollow, h1Count, h2Count, h3Count, h1Text,
      wordCount, totalImages: images.length, missingAlt,
      internalLinks, externalLinks,
      hasOgTitle, hasOgDescription, hasOgImage, hasSchema, issues,
    },
    links: [...discoveredLinks],
  };
}

/** Fetch + analyze a single page, returns { page, links } */
async function crawlPage(url, domain, stealthPool = null) {
  let { response, loadTime, html, error } = await fetchPage(url);

  // If axios (direct + proxy) both returned a CF block, try stealth browser
  if (stealthPool && (!error) && response && isBlocked(response.status, response.headers, html)) {
    console.log(`[CRAWLER] CF block persists — using stealth browser for ${url}`);
    await stealthPool.launch();
    const stealthResult = await fetchPageStealth(url, stealthPool);
    if (!stealthResult.error && stealthResult.html) {
      response = stealthResult.response;
      loadTime = stealthResult.loadTime;
      html = stealthResult.html;
      error = null;
    }
  }

  if (error || !response) {
    const isTimeout = error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT";
    return {
      page: {
        url, status: isTimeout ? 408 : 0, statusClass: isTimeout ? "timeout" : "error",
        loadTime: isTimeout ? 12 : 0, pageSizeKb: 0, title: null, titleLength: 0,
        metaDescription: null, metaLength: 0, canonical: null, isNoindex: false,
        isNofollow: false, h1Count: 0, h2Count: 0, h3Count: 0, h1Text: null,
        wordCount: 0, totalImages: 0, missingAlt: 0, internalLinks: 0, externalLinks: 0,
        hasOgTitle: false, hasOgDescription: false, hasOgImage: false, hasSchema: false,
        issues: ["crawl_error"], error: error?.message?.slice(0, 120) || "Unknown error",
      },
      links: [],
    };
  }

  const pageSizeKb = (Buffer.byteLength(html) / 1024).toFixed(1);
  return analyzePageHtml(html, url, domain, response.status, loadTime, pageSizeKb);
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(results) {
  const total = results.length;
  const byStatus = { ok: 0, redirect: 0, not_found: 0, client_error: 0, server_error: 0, auth_required: 0, forbidden: 0, rate_limited: 0, timeout: 0, error: 0 };

  let missingTitle = 0;
  let missingMeta = 0;
  let missingH1 = 0;
  let multipleH1 = 0;
  let missingAltPages = 0;
  let noindexPages = 0;
  let missingCanonical = 0;
  let thinContent = 0;

  let totalLoadTime = 0;
  let totalWordCount = 0;

  for (const page of results) {
    byStatus[page.statusClass] = (byStatus[page.statusClass] || 0) + 1;
    totalLoadTime += page.loadTime || 0;
    totalWordCount += page.wordCount || 0;

    if (page.issues?.includes("missing_title") || page.issues?.includes("title_too_short")) missingTitle++;
    if (page.issues?.includes("missing_meta_description")) missingMeta++;
    if (page.issues?.includes("missing_h1")) missingH1++;
    if (page.issues?.includes("multiple_h1")) multipleH1++;
    if (page.issues?.includes("images_missing_alt")) missingAltPages++;
    if (page.issues?.includes("noindex")) noindexPages++;
    if (page.issues?.includes("missing_canonical")) missingCanonical++;
    if (page.issues?.includes("thin_content")) thinContent++;
  }

  return {
    totalPages: total,
    statusBreakdown: byStatus,
    avgLoadTime: total > 0 ? Number((totalLoadTime / total).toFixed(2)) : 0,
    avgWordCount: total > 0 ? Math.round(totalWordCount / total) : 0,
    issues: {
      missingTitle,
      missingMetaDescription: missingMeta,
      missingH1,
      multipleH1,
      pagesWithMissingAlt: missingAltPages,
      noindexPages,
      missingCanonical,
      thinContent,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
async function takeHomepageScreenshots(url) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    const desktop = await page.screenshot({ encoding: "base64", fullPage: false });
    await page.setViewport({ width: 390, height: 844 });
    const mobile = await page.screenshot({ encoding: "base64", fullPage: false });
    await browser.close();
    return {
      screenshot: `data:image/png;base64,${desktop}`,
      screenshotMobile: `data:image/png;base64,${mobile}`,
    };
  } catch (err) {
    console.error("[CRAWLER] Screenshot failed:", err.message);
    if (browser) await browser.close().catch(() => {});
    return { screenshot: null, screenshotMobile: null };
  }
}

// ---------------------------------------------------------------------------
// Main export — BFS recursive crawler
// ---------------------------------------------------------------------------

/**
 * crawlSite(baseUrl, options)
 *
 * Seeds from sitemaps, then follows every internal link found on every crawled
 * page (BFS). Discovers all pages automatically regardless of sitemap coverage.
 *
 * @param {string} baseUrl
 * @param {object} options
 *   @param {number} [options.concurrency=15]  Parallel workers
 *   @param {number} [options.maxPages=2000]   Hard cap — prevents runaway on huge sites
 *   @param {function} [options.onProgress]    (crawled, total) callback
 */
export async function crawlSite(baseUrl, options = {}) {
  const {
    concurrency = 15,
    maxPages = 2000,
    onProgress = null,
  } = options;

  baseUrl = normalizeUrl(baseUrl);
  const domain = getDomain(baseUrl);
  console.log(`[CRAWLER] Starting BFS crawl: ${baseUrl} (concurrency=${concurrency}, maxPages=${maxPages})`);

  // Stealth pool — launched lazily only if CF blocks axios + proxy
  const stealthPool = new StealthBrowserPool(Math.min(concurrency, 5), getProxyConfig());

  // Step 0: Homepage screenshot
  console.log("[CRAWLER] Taking homepage screenshot...");
  const { screenshot, screenshotMobile } = await takeHomepageScreenshots(baseUrl);

  // Step 1: Seed queue from sitemaps
  const seedUrls = await getSeedUrls(baseUrl);

  // BFS state — shared mutable queue (JS is single-threaded; shift() is atomic)
  const queue = [...seedUrls];
  const seen  = new Set(queue);   // all URLs ever enqueued (prevents duplicates)
  const results = [];             // completed page analyses

  console.log(`[CRAWLER] BFS starting with ${queue.length} seed URLs...`);

  // Step 2: N workers drain the queue; new links found are pushed to the back
  const worker = async () => {
    while (true) {
      if (results.length >= maxPages) break;
      const url = queue.shift();
      if (url === undefined) break; // queue drained

      const { page, links } = await crawlPage(url, domain, stealthPool);
      results.push(page);

      // Enqueue newly discovered internal links
      for (const link of links) {
        if (!seen.has(link) && results.length + queue.length < maxPages) {
          seen.add(link);
          queue.push(link);
        }
      }

      const total = results.length + queue.length;
      console.log(`[CRAWLER] Progress: ${results.length}/${total}`);
      if (onProgress) onProgress(results.length, total);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Clean up stealth browser if it was used
  await stealthPool.close();

  const summary = buildSummary(results);
  console.log(`[CRAWLER] Done. ${results.length} pages crawled, ${seen.size} total discovered.`);

  return {
    pages: results,
    summary,
    discoveredUrls: seen.size,
    crawledAt: new Date().toISOString(),
    screenshot,
    screenshotMobile,
  };
}
