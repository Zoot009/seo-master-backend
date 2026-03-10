/**
 * Site Crawler - Multi-page website audit
 *
 * Discovers every page on a website via sitemap + homepage link crawl,
 * then fast-crawls each one using axios + cheerio.
 *
 * This is intentionally separate from seo-analyzer.js which does a deep
 * single-page Puppeteer analysis. This module trades depth for breadth.
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { parseStringPromise } from "xml2js";
import puppeteer from "puppeteer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) {
    return "https://" + raw;
  }
  return raw;
}

function getDomain(url) {
  const u = new URL(url);
  return u.protocol + "//" + u.host;
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
    "/wp-content/", "/assets/", "/static/", "/images/",
    "/img/", "/media/", "/files/", "/uploads/", "/css/", "/js/",
  ];

  const lower = url.toLowerCase();

  for (const ext of assetExtensions) {
    if (lower.endsWith(ext) || lower.includes(ext + "?")) return false;
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
// URL Discovery
// ---------------------------------------------------------------------------

/** Reads robots.txt and pulls out any Sitemap: directives */
async function getSitemapsFromRobots(domain) {
  const sitemaps = [];
  try {
    console.log("[CRAWLER] Checking robots.txt...");
    const res = await axios.get(`${domain}/robots.txt`, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0" },
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
      headers: { "User-Agent": "Mozilla/5.0" },
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

/** Scrapes internal links from the homepage */
async function getHomepageLinks(domain) {
  const urls = [];
  try {
    console.log("[CRAWLER] Crawling homepage for links...");
    const res = await axios.get(domain, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const $ = cheerio.load(res.data);
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      try {
        const absolute = new URL(href, domain).href;
        if (absolute.startsWith(domain) && isPageUrl(absolute)) {
          urls.push(absolute);
        }
      } catch {}
    });
    console.log(`[CRAWLER] Found ${urls.length} links on homepage`);
  } catch {
    console.log("[CRAWLER] Could not crawl homepage for links");
  }
  return urls;
}

/**
 * Discovers all page URLs on the site.
 * Combines: robots.txt sitemaps + /sitemap.xml fallback + homepage links.
 */
async function discoverUrls(baseUrl) {
  const domain = getDomain(baseUrl);
  const allUrls = new Set();

  // 1. Sitemaps from robots.txt
  const robotsSitemaps = await getSitemapsFromRobots(domain);

  // 2. Always include the default sitemap location as a fallback
  if (!robotsSitemaps.some(s => s.includes("sitemap.xml"))) {
    robotsSitemaps.push(`${domain}/sitemap.xml`);
  }

  // 3. Resolve all discovered sitemaps
  const visited = new Set();
  for (const sm of robotsSitemaps) {
    const urls = await resolveSitemap(sm, visited);
    urls.filter(isPageUrl).forEach(u => allUrls.add(u));
  }

  // 4. Also grab homepage links (catches sites with no sitemap)
  const homepageLinks = await getHomepageLinks(domain);
  homepageLinks.forEach(u => allUrls.add(u));

  // Always include the homepage itself
  allUrls.add(domain + "/");
  allUrls.add(domain);

  return Array.from(allUrls);
}

// ---------------------------------------------------------------------------
// Per-page analysis (axios + cheerio — no browser)
// ---------------------------------------------------------------------------

function analyzePageHtml(html, url, status, loadTime, pageSizeKb) {
  const $ = cheerio.load(html);

  // Title
  const title = $("title").first().text().trim() || null;
  const titleLength = title ? title.length : 0;

  // Meta description
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || null;
  const metaLength = metaDescription ? metaDescription.length : 0;

  // Canonical
  const canonical = $('link[rel="canonical"]').attr("href") || null;

  // Robots meta
  const robotsMeta = $('meta[name="robots"]').attr("content")?.toLowerCase() || "";
  const isNoindex = robotsMeta.includes("noindex");
  const isNofollow = robotsMeta.includes("nofollow");

  // Headings
  const h1Count = $("h1").length;
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;
  const h1Text = $("h1").first().text().trim() || null;

  // Images
  const images = $("img");
  let missingAlt = 0;
  images.each((_, img) => {
    const alt = $(img).attr("alt");
    if (!alt || alt.trim().length === 0) missingAlt++;
  });

  // Links
  const urlObj = new URL(url);
  let internalLinks = 0;
  let externalLinks = 0;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href.startsWith("/") || href.includes(urlObj.hostname)) {
      internalLinks++;
    } else if (href.startsWith("http")) {
      externalLinks++;
    }
  });

  // Word count
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText.split(/\s+/).filter(w => w.length > 0).length;

  // Open Graph
  const hasOgTitle = $('meta[property="og:title"]').length > 0;
  const hasOgDescription = $('meta[property="og:description"]').length > 0;
  const hasOgImage = $('meta[property="og:image"]').length > 0;

  // Schema markup
  const hasSchema = $('script[type="application/ld+json"]').length > 0;

  // Classify HTTP status
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

  // Issues detected for this page
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
    url,
    status,
    statusClass: classifyStatus(status),
    loadTime: Number(loadTime),
    pageSizeKb: Number(pageSizeKb),
    title,
    titleLength,
    metaDescription,
    metaLength,
    canonical,
    isNoindex,
    isNofollow,
    h1Count,
    h2Count,
    h3Count,
    h1Text,
    wordCount,
    totalImages: images.length,
    missingAlt,
    internalLinks,
    externalLinks,
    hasOgTitle,
    hasOgDescription,
    hasOgImage,
    hasSchema,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Fast HTTP crawler (axios-based, no browser)
// ---------------------------------------------------------------------------

async function crawlPage(url) {
  try {
    const start = Date.now();
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SEOMasterBot/1.0)" },
      validateStatus: () => true, // don't throw on 4xx/5xx
      maxRedirects: 5,
    });

    const loadTime = ((Date.now() - start) / 1000).toFixed(2);
    const html = typeof response.data === "string" ? response.data : String(response.data);
    const pageSizeKb = (Buffer.byteLength(html) / 1024).toFixed(1);

    return analyzePageHtml(html, url, response.status, loadTime, pageSizeKb);
  } catch (err) {
    const isTimeout = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT";
    return {
      url,
      status: isTimeout ? 408 : 0,
      statusClass: isTimeout ? "timeout" : "error",
      loadTime: isTimeout ? 10 : 0,
      pageSizeKb: 0,
      title: null,
      titleLength: 0,
      metaDescription: null,
      metaLength: 0,
      canonical: null,
      isNoindex: false,
      isNofollow: false,
      h1Count: 0,
      h2Count: 0,
      h3Count: 0,
      h1Text: null,
      wordCount: 0,
      totalImages: 0,
      missingAlt: 0,
      internalLinks: 0,
      externalLinks: 0,
      hasOgTitle: false,
      hasOgDescription: false,
      hasOgImage: false,
      hasSchema: false,
      issues: ["crawl_error"],
      error: err.message?.slice(0, 120) || "Unknown error",
    };
  }
}

/** Simple batch-concurrency runner — processes `maxConcurrent` pages at once */
async function crawlBatch(urls, maxConcurrent = 10, onProgress = null) {
  const results = [];
  for (let i = 0; i < urls.length; i += maxConcurrent) {
    const batch = urls.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(batch.map(url => crawlPage(url)));
    results.push(...batchResults);
    if (onProgress) {
      onProgress(Math.min(i + maxConcurrent, urls.length), urls.length);
    }
  }
  return results;
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

/**
 * crawlSite(baseUrl, options) — Main exported function
 *
 * @param {string} baseUrl  - Full URL of the website to audit
 * @param {object} options
 *   @param {number} [options.concurrency=10]     - Parallel requests
 *   @param {function} [options.onProgress]       - (done, total) callback
 * @returns {{ pages, summary, discoveredUrls, crawledAt }}
 */
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

export async function crawlSite(baseUrl, options = {}) {
  const {
    concurrency = 10,
    onProgress = null,
  } = options;

  baseUrl = normalizeUrl(baseUrl);
  console.log(`[CRAWLER] Starting site crawl: ${baseUrl}`);

  // Step 0: Take homepage screenshot
  console.log("[CRAWLER] Taking homepage screenshot...");
  const { screenshot, screenshotMobile } = await takeHomepageScreenshots(baseUrl);

  // Step 1: Discover URLs
  console.log("[CRAWLER] Discovering URLs...");
  const allDiscovered = await discoverUrls(baseUrl);
  console.log(`[CRAWLER] Discovered ${allDiscovered.length} URLs`);

  // Step 2: Deduplicate
  const uniqueUrls = [...new Set(allDiscovered)];
  console.log(`[CRAWLER] Crawling ${uniqueUrls.length} pages`);

  // Step 3: Crawl all pages
  const pages = await crawlBatch(uniqueUrls, concurrency, (done, total) => {
    console.log(`[CRAWLER] Progress: ${done}/${total}`);
    if (onProgress) onProgress(done, total);
  });

  // Step 4: Build summary
  const summary = buildSummary(pages);

  console.log(`[CRAWLER] Done. ${pages.length} pages crawled.`);

  return {
    pages,
    summary,
    discoveredUrls: allDiscovered.length,
    crawledAt: new Date().toISOString(),
    screenshot,
    screenshotMobile,
  };
}
