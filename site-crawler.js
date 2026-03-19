/**
 * Site Crawler - Multi-page website audit
 *
 * Full recursive BFS crawler: seeds from sitemaps, then follows every internal
 * link found on every crawled page — discovers all pages automatically.
 *
 * Proxy support: set PROXY_URL=http://user:pass@host:port in .env
 * Proxy is only used as a fallback when direct requests are blocked (403/CF).
 * Stealth browser (puppeteer-extra-stealth) is the final fallback for Cloudflare-protected sites.
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
  const b = typeof body === "string" ? body.toLowerCase() : "";

  // Cloudflare JS challenge — can return 200, 403, or 503
  if (
    b.includes("just a moment") ||
    b.includes("checking your browser") ||
    b.includes("cf-browser-verification") ||
    b.includes("performing security verification") ||
    b.includes("_cf_chl") ||
    b.includes("cf.challenge") ||
    b.includes("ddos-guard") ||
    b.includes("ray id") ||
    (b.includes("enable javascript") && b.includes("cloudflare")) ||
    // Cloudflare returns tiny body when challenging
    (b.length < 2000 && (headers?.["cf-ray"] || headers?.server?.toLowerCase()?.includes("cloudflare")))
  ) return true;

  // Standard block status codes with CF headers
  if ([403, 503, 429].includes(status)) {
    if (headers?.["cf-ray"] || headers?.server?.toLowerCase()?.includes("cloudflare")) return true;
  }

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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Check if CF challenge is still showing.
    // If page.evaluate throws "Execution context destroyed", CF already redirected
    // us to the real page — no extra wait needed.
    const isCFChallenge = await page.evaluate(() => {
      const t = document.body?.innerText?.slice(0, 300)?.toLowerCase() ?? "";
      return t.includes("just a moment") || t.includes("checking your browser") || t.includes("security verification");
    }).catch(() => false);

    if (isCFChallenge) {
      // CF JS challenge is still running — wait for it to redirect to the real page
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
    }

    const html = await page.content();
    const loadTime = ((Date.now() - start) / 1000).toFixed(2);
    pool.release(page);
    return { response: { status: 200, headers: {} }, loadTime, html };
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

/**
 * Returns true if the URL belongs to the same site as domain.
 * Treats www.example.com and example.com as the same site.
 */
function isSameSite(url, domain) {
  if (url.startsWith(domain)) return true;
  const altDomain = domain.includes("://www.")
    ? domain.replace("://www.", "://")
    : domain.replace("://", "://www.");
  return url.startsWith(altDomain);
}

// ---------------------------------------------------------------------------
// Sitemap discovery — seeds the BFS queue
// ---------------------------------------------------------------------------

/**
 * Fetch raw text content (robots.txt, XML sitemaps).
 * Uses a direct axios request.
 */
async function fetchTextContent(url) {
  const res = await axios.get(url, {
    timeout: 15000,
    headers: {
      "User-Agent": randomUA(),
      "Accept": "text/xml,application/xml,text/html,*/*;q=0.8",
    },
    responseType: "text",
    validateStatus: () => true,
  });
  const text = typeof res.data === "string" ? res.data : String(res.data);
  if (res.status < 400 && text.trim().length > 64) {
    console.log(`[CRAWLER]    direct fetch OK for ${url} (${res.status}, ${text.length} bytes)`);
    return text;
  }
  throw new Error(`Could not fetch ${url} — status ${res.status} or empty body`);
}

async function getSitemapsFromRobots(domain) {
  const sitemaps = [];
  try {
    console.log("[CRAWLER] Checking robots.txt...");
    const text = await fetchTextContent(`${domain}/robots.txt`);
    for (const line of text.split("\n")) {
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
    const text = await fetchTextContent(sitemapUrl);

    const xml = await parseStringPromise(text, { explicitArray: true });

    // Sitemap index — recurse into each child sitemap
    if (xml.sitemapindex) {
      const children = xml.sitemapindex.sitemap || [];
      for (const child of children) {
        const loc = child.loc?.[0];
        // Skip .xml.gz — we can't decompress them; they'd fail anyway
        if (loc && !loc.toLowerCase().endsWith(".xml.gz")) {
          const nested = await resolveSitemap(loc, visited);
          urls.push(...nested);
        } else if (loc) {
          console.log(`[CRAWLER]  → Skipping compressed sitemap: ${loc}`);
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
async function getSeedUrls(baseUrl, maxPages = 500) {
  const domain = getDomain(baseUrl);
  const seed = new Set();

  const robotsSitemaps = await getSitemapsFromRobots(domain);
  // Always try common sitemap paths as fallbacks
  const commonSitemaps = [
    `${domain}/sitemap.xml`,
    `${domain}/sitemap_index.xml`,
    `${domain}/wp-sitemap.xml`,
  ];
  for (const sm of commonSitemaps) {
    if (!robotsSitemaps.some(r => r === sm || r.includes(new URL(sm).pathname))) {
      robotsSitemaps.push(sm);
    }
  }

  const visited = new Set();
  for (const sm of robotsSitemaps) {
    if (seed.size >= maxPages) break;
    const urls = await resolveSitemap(sm, visited);
    for (const u of urls) {
      if (seed.size >= maxPages) break;
      // Accept both www and non-www variants of the domain
      if (isPageUrl(u) && isSameSite(u, domain)) seed.add(cleanUrl(u));
    }
  }

  // Always seed with homepage
  seed.add(cleanUrl(domain + "/"));
  seed.add(cleanUrl(baseUrl));

  console.log(`[CRAWLER] Seeded ${seed.size} URLs from sitemaps (capped at ${maxPages})`);
  return [...seed];
}

// ---------------------------------------------------------------------------
// Per-page fetch — direct axios with proxy fallback, then stealth browser
// for Cloudflare-protected sites.
// ---------------------------------------------------------------------------
async function fetchPage(url, blockedHosts = null) {
  // Fast-path: if this host is already known to be CF-blocked, skip direct+proxy
  if (blockedHosts) {
    const host = new URL(url).hostname;
    if (blockedHosts.has(host)) {
      return { response: null, loadTime: 0, html: "", wasBlocked: true };
    }
  }

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
    let wasBlocked = isBlocked(result.response?.status, result.response?.headers, result.html);

    // If blocked (CF/WAF), retry through proxy
    if (proxyConfig && wasBlocked) {
      console.log(`[CRAWLER] Blocked at ${url} — retrying via proxy`);
      try {
        result = await attempt(true);
        wasBlocked = isBlocked(result.response?.status, result.response?.headers, result.html);
        if (wasBlocked) {
          console.log(`[CRAWLER] Still blocked via proxy at ${url} — status=${result.response?.status}, body-len=${result.html?.length}`);
        }
      } catch (proxyErr) {
        console.log(`[CRAWLER] Proxy attempt threw: ${proxyErr.message}`);
        // wasBlocked stays true — stealth will take over
      }
    } else if (wasBlocked) {
      console.log(`[CRAWLER] Blocked at ${url} (no proxy configured) — status=${result.response?.status}`);
    }

    return { ...result, wasBlocked };
  } catch (err) {
    return { response: null, loadTime: 0, html: "", error: err, wasBlocked: false };
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
  const linkDetails = []; // { href, text, type: 'internal' | 'external' }
  const altDomain = domain.includes("://www.")
    ? domain.replace("://www.", "://")
    : domain.replace("://", "://www.");

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const anchorText = $(el).text().replace(/\s+/g, " ").trim().slice(0, 150) || "";
    try {
      const abs = new URL(href, url).href;
      const clean = cleanUrl(abs);
      const isInternal = clean.startsWith(domain) || clean.startsWith(altDomain);
      if (isInternal) {
        internalLinks++;
        // Follow links unless page declares nofollow
        if (!isNofollow && isPageUrl(clean)) discoveredLinks.add(clean);
        if (linkDetails.length < 100) {
          linkDetails.push({ href: clean, text: anchorText, type: "internal" });
        }
      } else if (href.startsWith("http")) {
        externalLinks++;
        if (linkDetails.length < 100) {
          linkDetails.push({ href: abs, text: anchorText, type: "external" });
        }
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
      internalLinks, externalLinks, linkDetails,
      hasOgTitle, hasOgDescription, hasOgImage, hasSchema, issues,
    },
    links: [...discoveredLinks],
  };
}

/** Fetch + analyze a single page, returns { page, links } */
async function crawlPage(url, domain, stealthPool = null, blockedHosts = null) {
  let { response, loadTime, html, error, wasBlocked } = await fetchPage(url, blockedHosts);

  // If direct + proxy both blocked/failed, use stealth browser (handles CF JS challenges)
  if (stealthPool && wasBlocked) {
    // Mark this host so all future pages skip the failed direct+proxy attempts
    if (blockedHosts) blockedHosts.add(new URL(url).hostname);
    console.log(`[CRAWLER] CF block persists — using stealth browser for ${url}`);
    await stealthPool.launch();
    const stealthResult = await fetchPageStealth(url, stealthPool);
    if (!stealthResult.error && stealthResult.html) {
      response = stealthResult.response;
      loadTime = stealthResult.loadTime;
      html = stealthResult.html;
      error = null;
    } else if (stealthResult.error) {
      error = stealthResult.error; // propagate for accurate error messages
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
        linkDetails: [],
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
    // Use stealth browser to bypass Cloudflare on screenshot
    browser = await puppeteerExtra.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(randomUA());
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Give JS-rendered / CF-challenge pages time to resolve
    await page.waitForNetworkIdle({ timeout: 8000, idleTime: 800 }).catch(() => {});
    // If still on CF challenge, wait for navigation
    const isCF = await page.evaluate(() => {
      const t = document.body?.innerText?.slice(0, 400)?.toLowerCase() ?? "";
      return t.includes("just a moment") || t.includes("checking your browser") ||
             t.includes("security verification") || t.includes("performing security");
    }).catch(() => false);
    if (isCF) {
      console.log("[CRAWLER] CF challenge on screenshot — waiting for redirect...");
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForNetworkIdle({ timeout: 6000, idleTime: 800 }).catch(() => {});
    }
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
// Main export — Sitemap + Homepage strategy (no BFS)
// ---------------------------------------------------------------------------

/**
 * crawlSite(baseUrl, options)
 *
 * 1. Pulls page URLs from sitemaps (up to maxPages)
 * 2. Fetches the homepage and extracts internal links to fill any gaps
 * 3. Fetches every collected URL in parallel batches (concurrency=5)
 * 4. No recursive link-following — saves Scrape.do credits
 *
 * @param {string} baseUrl
 * @param {object} options
 *   @param {number} [options.concurrency=5]   Parallel fetch workers
 *   @param {number} [options.maxPages=500]    Hard cap on pages to crawl
 *   @param {function} [options.onProgress]   (crawled, total) callback
 */
export async function crawlSite(baseUrl, options = {}) {
  const {
    concurrency = 5,
    maxPages = 500,
    onProgress = null,
  } = options;

  baseUrl = normalizeUrl(baseUrl);
  const domain = getDomain(baseUrl);
  const usingScrapeDo = !!process.env.SCRAPE_DO_TOKEN;
  console.log(`[CRAWLER] Starting crawl: ${baseUrl} (concurrency=${concurrency}, maxPages=${maxPages}, via=${usingScrapeDo ? 'scrape.do' : 'direct'})`);

  // Stealth pool only needed when NOT using Scrape.do
  const stealthPool = usingScrapeDo ? null : new StealthBrowserPool(Math.min(concurrency, 10), getProxyConfig());
  const blockedHosts = usingScrapeDo ? null : new Set();

  // Step 0: Screenshot runs in parallel with URL discovery
  const screenshotPromise = takeHomepageScreenshots(baseUrl);

  // Step 1: Collect URLs from sitemaps
  let urlSet = new Set(await getSeedUrls(baseUrl, maxPages));
  console.log(`[CRAWLER] ${urlSet.size} URLs from sitemaps`);

  // Step 2: Fetch homepage and extract internal links to fill gaps
  if (urlSet.size < maxPages) {
    console.log(`[CRAWLER] Fetching homepage to discover additional links...`);
    const homeFetch = await fetchPage(baseUrl, blockedHosts);
    if (homeFetch.html) {
      const $ = cheerio.load(homeFetch.html);
      $('a[href]').each((_, el) => {
        if (urlSet.size >= maxPages) return false;
        const href = $(el).attr('href') || '';
        try {
          const abs = cleanUrl(new URL(href, baseUrl).href);
          if (isPageUrl(abs) && isSameSite(abs, domain)) urlSet.add(abs);
        } catch {}
      });
      console.log(`[CRAWLER] ${urlSet.size} URLs after homepage link extraction`);
    }
  }

  // Finalise the ordered list, capped at maxPages
  const totalDiscoveredUrls = urlSet.size;
  const allUrls = [...urlSet].slice(0, maxPages);
  const uncrawledUrls = totalDiscoveredUrls > maxPages ? [...urlSet].slice(maxPages) : [];
  const wasCapped = totalDiscoveredUrls > maxPages;
  const total = allUrls.length;
  console.log(`[CRAWLER] Crawling ${total}/${totalDiscoveredUrls} pages with concurrency ${concurrency}${wasCapped ? ` (capped at ${maxPages})` : ''}...`);

  // Step 3: Fetch + analyse all pages in concurrent batches — no BFS
  const results = [];
  let cursor = 0;
  // Small inter-request delay per worker to avoid hammering Scrape.do
  const INTER_REQUEST_DELAY_MS = process.env.SCRAPE_DO_TOKEN ? 150 : 0;

  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= allUrls.length) break;
      const url = allUrls[idx];
      const { page } = await crawlPage(url, domain, stealthPool, blockedHosts);
      results.push(page);
      const done = results.length;
      console.log(`[CRAWLER] Progress: ${done}/${total}`);
      if (onProgress) onProgress(done, total);
      if (INTER_REQUEST_DELAY_MS > 0) await new Promise(r => setTimeout(r, INTER_REQUEST_DELAY_MS));
    }
  };

  // Wait for all workers and screenshot in parallel
  const [, { screenshot, screenshotMobile }] = await Promise.all([
    Promise.all(Array.from({ length: concurrency }, () => worker())),
    screenshotPromise,
  ]);

  // Clean up stealth browser if it was used
  if (stealthPool) await stealthPool.close();

  const summary = buildSummary(results);
  console.log(`[CRAWLER] Done. ${results.length} pages crawled.`);

  return {
    pages: results,
    summary,
    crawledPages: results.length,
    totalDiscoveredUrls,
    wasCapped,
    uncrawledUrls,
    discoveredUrls: total,
    crawledAt: new Date().toISOString(),
    screenshot,
    screenshotMobile,
  };
}
