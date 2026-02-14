/**
 * Alt Tag Checker Module
 * 
 * Analyzes a webpage to check for missing alt attributes on images
 */

import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Check alt tags on a webpage
 * @param {string} url - The URL to analyze
 * @returns {Promise<Object>} Analysis results
 */
export async function checkAltTags(url) {
  try {
    // Ensure URL has protocol
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (err) {
      throw new Error('Invalid URL format');
    }

    console.log(`[ALT-TAG-CHECKER] Fetching: ${url}`);

    // Fetch the webpage
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 15000, // 15 second timeout
      maxRedirects: 5
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Find all image tags
    const images = [];
    const imagesWithAlt = [];
    const imagesWithoutAlt = [];

    $('img').each((index, element) => {
      const $img = $(element);
      const src = $img.attr('src') || '';
      const alt = $img.attr('alt');
      
      // Skip tracking pixels and small images (common UI elements)
      const width = $img.attr('width');
      const height = $img.attr('height');
      
      // Check if it's likely a tracking pixel or very small image
      const isTrackingPixel = (
        (width && parseInt(width) <= 1) || 
        (height && parseInt(height) <= 1) ||
        src.includes('tracking') ||
        src.includes('pixel') ||
        src.includes('analytics')
      );

      const imageData = {
        src: src,
        alt: alt || '',
        hasAlt: alt !== undefined && alt !== null,
        altLength: alt ? alt.length : 0,
        isTrackingPixel: isTrackingPixel
      };

      images.push(imageData);

      if (imageData.hasAlt) {
        imagesWithAlt.push(imageData);
      } else if (!isTrackingPixel) {
        // Only count as missing if not a tracking pixel
        imagesWithoutAlt.push(imageData);
      }
    });

    // Calculate statistics
    const totalImages = images.length;
    const totalWithAlt = imagesWithAlt.length;
    const totalWithoutAlt = imagesWithoutAlt.length;
    const totalTrackingPixels = images.filter(img => img.isTrackingPixel).length;
    
    // Relevant images (excluding tracking pixels)
    const relevantImages = images.filter(img => !img.isTrackingPixel);
    const relevantTotal = relevantImages.length;

    console.log(`[ALT-TAG-CHECKER] Analysis complete for ${url}`);
    console.log(`[ALT-TAG-CHECKER] Total images: ${totalImages}, With alt: ${totalWithAlt}, Missing alt: ${totalWithoutAlt}`);

    return {
      success: true,
      url: url,
      statistics: {
        totalImages: totalImages,
        relevantImages: relevantTotal,
        imagesWithAlt: totalWithAlt,
        imagesWithoutAlt: totalWithoutAlt,
        trackingPixels: totalTrackingPixels,
        altCoverage: relevantTotal > 0 ? Math.round((totalWithAlt / relevantTotal) * 100) : 0
      },
      images: {
        all: images,
        withAlt: imagesWithAlt,
        withoutAlt: imagesWithoutAlt
      },
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error('[ALT-TAG-CHECKER] Error:', error.message);
    
    // Provide user-friendly error messages
    let errorMessage = error.message;
    
    if (error.code === 'ENOTFOUND') {
      errorMessage = 'Website not found. Please check the URL and try again.';
    } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED') {
      errorMessage = 'Request timed out. The website took too long to respond.';
    } else if (error.response?.status === 403) {
      errorMessage = 'Access forbidden. The website blocked our request.';
    } else if (error.response?.status === 404) {
      errorMessage = 'Page not found (404). Please check the URL.';
    } else if (error.response?.status >= 500) {
      errorMessage = 'The website server returned an error. Please try again later.';
    }

    throw new Error(errorMessage);
  }
}
