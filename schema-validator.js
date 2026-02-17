/**
 * Schema Markup Validator
 * 
 * Extracts and validates structured data (Schema.org markup) from websites
 * Supports: JSON-LD, Microdata, and RDFa formats
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Extract all schema markup from a webpage
 */
export async function validateSchema(url) {
  try {
    console.log(`[SCHEMA] Starting schema validation for: ${url}`);

    // Fetch the webpage
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      timeout: 15000,
      maxRedirects: 5,
    });

    const html = response.data;
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

    console.log(`[SCHEMA] Found ${results.summary.totalSchemas} schemas on ${url}`);
    console.log(`[SCHEMA] Types: ${results.summary.types.join(', ')}`);

    return results;

  } catch (error) {
    console.error('[SCHEMA] Validation error:', error.message);
    throw new Error(`Failed to validate schema: ${error.message}`);
  }
}

/**
 * Extract JSON-LD schema markup
 */
function extractJsonLd($) {
  const schemas = [];
  
  $('script[type="application/ld+json"]').each((index, element) => {
    try {
      const content = $(element).html();
      const parsed = JSON.parse(content);
      
      // Handle @graph arrays
      if (parsed['@graph']) {
        schemas.push(...parsed['@graph']);
      } else if (Array.isArray(parsed)) {
        schemas.push(...parsed);
      } else {
        schemas.push(parsed);
      }
    } catch (error) {
      console.error('[SCHEMA] Error parsing JSON-LD:', error.message);
    }
  });

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
