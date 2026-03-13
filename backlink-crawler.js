
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';
import pkg from 'pg';
const { Client } = pkg;

const DATABASE_URL = process.env.DATABASE_URL || 'YOUR_DATABASE_URL_HERE';
const START_URL = process.env.START_URL || 'https://example.com';
const MAX_DEPTH = parseInt(process.env.CRAWL_DEPTH || '2', 10); // You can set CRAWL_DEPTH=3 in env
const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || '100', 10); // Limit total pages to crawl

const client = new Client({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : false,
});

const visited = new Set();
const backlinkSet = new Set(); // For deduplication
let pagesCrawled = 0;

async function saveBacklink(source_url, target_url, target_domain) {
  const key = `${source_url}=>${target_url}`;
  if (backlinkSet.has(key)) return; // Deduplicate
  backlinkSet.add(key);
  await client.query(
    'INSERT INTO backlinks (source_url, target_url, target_domain) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [source_url, target_url, target_domain]
  );
}

async function crawl(url, depth = 1) {
  if (visited.has(url) || depth > MAX_DEPTH || pagesCrawled >= MAX_PAGES) return;
  visited.add(url);
  pagesCrawled++;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const $ = cheerio.load(data);
    const sourceDomain = new URL(url).hostname;
// ...existing code...
const links = [];
$('a[href]').each((_, el) => {
  const href = $(el).attr('href');
  try {
    const linkUrl = new URL(href, url);
    const targetDomain = linkUrl.hostname;
    // Only save external backlinks
    if (sourceDomain !== targetDomain) {
      links.push({ source: url, target: linkUrl.href, domain: targetDomain });
    }
    // Only follow links within the same domain (optional: follow all domains)
    if (!visited.has(linkUrl.href) && linkUrl.protocol.startsWith('http')) {
      links.push({ follow: linkUrl.href });
    }
  } catch {}
});

// Save backlinks sequentially
for (const link of links) {
  if (link.source) {
    await saveBacklink(link.source, link.target, link.domain);
  }
}

// Recursively crawl discovered links (breadth-first)
for (const link of links) {
  if (link.follow && pagesCrawled < MAX_PAGES) {
    await crawl(link.follow, depth + 1);
  }
}
  } catch (e) {
    console.log(`Failed to crawl ${url}: ${e.message}`);
  }
}

(async () => {
  await client.connect();
  console.log(`Starting crawl at ${START_URL} (max depth: ${MAX_DEPTH}, max pages: ${MAX_PAGES})`);
  await crawl(START_URL);
  await client.end();
  console.log('Crawling complete!');
})();