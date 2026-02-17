/**
 * Schema Markup Validator
 * 
 * Extracts and validates structured data (Schema.org markup) from websites
 * Supports: JSON-LD, Microdata, and RDFa formats
 */

import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';

/**
 * Extract all schema markup from a webpage
 */
export async function validateSchema(url) {
  let browser;
  try {
    console.log(`[SCHEMA] ========================================`);
    console.log(`[SCHEMA] Starting schema validation for: ${url}`);
    console.log(`[SCHEMA] ========================================`);

    // Ensure URL has protocol
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = "https://" + url;
      console.log(`[SCHEMA] Added protocol: ${url}`);
    }

    // Launch Puppeteer browser
    console.log(`[SCHEMA] Launching Puppeteer browser...`);
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    console.log(`[SCHEMA] Browser launched successfully`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to the page
    console.log(`[SCHEMA] Navigating to page: ${url}`);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    console.log(`[SCHEMA] Page loaded successfully`);

    // Get HTML content after JavaScript execution
    const html = await page.content();
    console.log(`[SCHEMA] Webpage content captured (${html.length} bytes)`);
    
    // Close browser
    await browser.close();
    console.log(`[SCHEMA] Browser closed`);

    const $ = cheerio.load(html);

    // Results object
    const results = {
      url,
      timestamp: new Date().toISOString(),
      schemas: {
        jsonLd: [],
        microdata: [],
        rdfa: []
      },
      summary: {
        totalSchemas: 0,
        types: [],
        hasSchema: false
      }
    };

    // 1. Extract JSON-LD (most common and recommended)
    const jsonLdSchemas = extractJsonLd($);
    results.schemas.jsonLd = jsonLdSchemas;

    // 2. Extract Microdata
    const microdataSchemas = extractMicrodata($);
    results.schemas.microdata = microdataSchemas;

    // 3. Extract RDFa (less common but still used)
    const rdfaSchemas = extractRdfa($);
    results.schemas.rdfa = rdfaSchemas;

    // Calculate summary
    const allTypes = new Set();
    
    jsonLdSchemas.forEach(schema => {
      if (schema['@type']) {
        const types = Array.isArray(schema['@type']) ? schema['@type'] : [schema['@type']];
        types.forEach(type => allTypes.add(type));
      }
    });

    microdataSchemas.forEach(schema => {
      if (schema.type) allTypes.add(schema.type);
    });

    rdfaSchemas.forEach(schema => {
      if (schema.type) allTypes.add(schema.type);
    });

    results.summary.totalSchemas = jsonLdSchemas.length + microdataSchemas.length + rdfaSchemas.length;
    results.summary.types = Array.from(allTypes);
    results.summary.hasSchema = results.summary.totalSchemas > 0;

    console.log(`[SCHEMA] ========================================`);
    console.log(`[SCHEMA] SUMMARY for ${url}`);
    console.log(`[SCHEMA] Total schemas found: ${results.summary.totalSchemas}`);
    console.log(`[SCHEMA] JSON-LD: ${jsonLdSchemas.length}`);
    console.log(`[SCHEMA] Microdata: ${microdataSchemas.length}`);
    console.log(`[SCHEMA] RDFa: ${rdfaSchemas.length}`);
    console.log(`[SCHEMA] Schema types: ${results.summary.types.join(', ') || 'None'}`);
    console.log(`[SCHEMA] ========================================`);

    return results;

  } catch (error) {
    console.error('[SCHEMA] Validation error:', error.message);
    if (browser) {
      console.log(`[SCHEMA] Closing browser after error...`);
      await browser.close();
    }
    throw new Error(`Failed to validate schema: ${error.message}`);
  }
}

/**
 * Extract JSON-LD schema markup
 */
function extractJsonLd($) {
  const schemas = [];
  
  console.log(`[SCHEMA] Looking for JSON-LD scripts...`);
  const jsonLdScripts = $('script[type="application/ld+json"]');
  console.log(`[SCHEMA] Found ${jsonLdScripts.length} JSON-LD script(s)`);
  
  jsonLdScripts.each((index, element) => {
    try {
      const content = $(element).html();
      console.log(`[SCHEMA] JSON-LD #${index + 1} content length: ${content?.length || 0} chars`);
      
      if (!content || content.trim() === '') {
        console.log(`[SCHEMA] JSON-LD #${index + 1} is empty, skipping`);
        return;
      }
      
      const parsed = JSON.parse(content);
      console.log(`[SCHEMA] JSON-LD #${index + 1} parsed successfully`);
      console.log(`[SCHEMA] JSON-LD #${index + 1} type:`, parsed['@type'] || 'No @type');
      
      // Handle @graph arrays
      if (parsed['@graph']) {
        console.log(`[SCHEMA] JSON-LD #${index + 1} contains @graph with ${parsed['@graph'].length} items`);
        schemas.push(...parsed['@graph']);
      } else if (Array.isArray(parsed)) {
        console.log(`[SCHEMA] JSON-LD #${index + 1} is an array with ${parsed.length} items`);
        schemas.push(...parsed);
      } else {
        console.log(`[SCHEMA] JSON-LD #${index + 1} is a single object`);
        schemas.push(parsed);
      }
    } catch (error) {
      console.error(`[SCHEMA] Error parsing JSON-LD #${index + 1}:`, error.message);
    }
  });

  console.log(`[SCHEMA] Total JSON-LD schemas extracted: ${schemas.length}`);
  return schemas;
}

/**
 * Extract Microdata schema markup
 */
function extractMicrodata($) {
  const schemas = [];
  
  $('[itemscope]').each((index, element) => {
    const $elem = $(element);
    const schema = {
      type: $elem.attr('itemtype') || 'Unknown',
      properties: {}
    };

    // Extract properties
    $elem.find('[itemprop]').each((i, prop) => {
      const $prop = $(prop);
      const name = $prop.attr('itemprop');
      let value;

      // Get value based on element type
      if ($prop.attr('content')) {
        value = $prop.attr('content');
      } else if ($prop.attr('href')) {
        value = $prop.attr('href');
      } else if ($prop.attr('src')) {
        value = $prop.attr('src');
      } else {
        value = $prop.text().trim();
      }

      schema.properties[name] = value;
    });

    if (Object.keys(schema.properties).length > 0) {
      schemas.push(schema);
    }
  });

  return schemas;
}

/**
 * Extract RDFa schema markup
 */
function extractRdfa($) {
  const schemas = [];
  
  $('[typeof]').each((index, element) => {
    const $elem = $(element);
    const schema = {
      type: $elem.attr('typeof') || 'Unknown',
      properties: {}
    };

    // Extract properties
    $elem.find('[property]').each((i, prop) => {
      const $prop = $(prop);
      const name = $prop.attr('property');
      let value;

      // Get value
      if ($prop.attr('content')) {
        value = $prop.attr('content');
      } else if ($prop.attr('href')) {
        value = $prop.attr('href');
      } else {
        value = $prop.text().trim();
      }

      schema.properties[name] = value;
    });

    if (Object.keys(schema.properties).length > 0) {
      schemas.push(schema);
    }
  });

  return schemas;
}

/**
 * Validate if schema is properly structured
 */
export function validateSchemaStructure(schema) {
  const issues = [];

  // Check for required @context in JSON-LD
  if (schema['@type'] && !schema['@context']) {
    issues.push('Missing @context property');
  }

  // Check for @type
  if (!schema['@type'] && !schema.type) {
    issues.push('Missing @type or type property');
  }

  return {
    isValid: issues.length === 0,
    issues
  };
}
