/**
 * PDF Generator Service
 * 
 * Generates PDF reports using Puppeteer with server-side rendering.
 * This provides better quality and more reliable PDF generation than client-side solutions.
 */

import puppeteer from 'puppeteer';

/**
 * Generate PDF from report data
 * @param {Object} reportData - The SEO report data
 * @returns {Promise<Buffer>} PDF file buffer
 */
export async function generatePDF(reportData) {
  let browser = null;
  
  try {
    console.log('[PDF Generator] Starting PDF generation...');
    
    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    
    // Set viewport for better rendering
    await page.setViewport({
      width: 1200,
      height: 800,
      deviceScaleFactor: 2
    });

    console.log('[PDF Generator] Generating HTML content...');
    
    // Generate HTML content
    const htmlContent = generateHTMLReport(reportData);
    
    // Set content
    await page.setContent(htmlContent, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    console.log('[PDF Generator] Converting to PDF...');
    
    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: {
        top: '15mm',
        right: '15mm',
        bottom: '15mm',
        left: '15mm'
      },
      displayHeaderFooter: false,
      preferCSSPageSize: false
    });

    console.log('[PDF Generator] PDF generated successfully');
    
    return pdfBuffer;

  } catch (error) {
    console.error('[PDF Generator] Error:', error);
    throw new Error(`Failed to generate PDF: ${error.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Generate HTML report from data
 * @param {Object} data - Report data
 * @returns {string} HTML content
 */
function generateHTMLReport(data) {
  const getHostname = (url) => {
    try {
      const urlWithProtocol = url.startsWith('http://') || url.startsWith('https://') 
        ? url 
        : `https://${url}`;
      return new URL(urlWithProtocol).hostname;
    } catch {
      return url;
    }
  };

  const getScoreColor = (score) => {
    if (score >= 90) return '#10b981';
    if (score >= 80) return '#22c55e';
    if (score >= 70) return '#eab308';
    if (score >= 60) return '#3b82f6';
    return '#ef4444';
  };

  const getScoreMessage = (score) => {
    if (score >= 90) return 'Excellent SEO Performance!';
    if (score >= 80) return 'Very Good SEO Performance';
    if (score >= 70) return 'Good SEO Performance';
    if (score >= 60) return 'Your SEO Needs Improvement';
    return 'Significant SEO Work Required';
  };

  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (data.score / 100) * circumference;

  const smallRadius = 40;
  const smallCircumference = 2 * Math.PI * smallRadius;

  // Format timestamp
  const formatDate = () => {
    const date = data.createdAt ? new Date(data.createdAt) : new Date();
    return date.toLocaleDateString('en-GB', { 
      day: '2-digit', 
      month: 'long', 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    }) + ' UTC';
  };

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SEO Report - ${getHostname(data.url)}</title>
  <style>
    * { 
      margin: 0; 
      padding: 0; 
      box-sizing: border-box; 
    }
    @page {
      margin: 15mm;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #1f2937;
      background: #f9fafb;
    }
    .page-header {
      background: #2c3e50;
      color: white;
      padding: 20px 32px;
      page-break-after: avoid;
    }
    .page-header h1 {
      font-size: 18px;
      font-weight: 700;
      margin: 0;
    }
    .container {
      max-width: 1100px;
      margin: 0 auto;
      padding: 12px 16px;
    }
    .section {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 14px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      page-break-inside: avoid;
      break-inside: avoid;
    }
    h1 {
      font-size: 26px;
      font-weight: 700;
      margin-bottom: 6px;
      color: #111827;
      page-break-after: avoid;
    }
    h2 {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 16px;
      color: #111827;
      page-break-after: avoid;
    }
    h3 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 12px;
      color: #111827;
      page-break-after: avoid;
    }
    h4 {
      font-size: 17px;
      font-weight: 600;
      margin-bottom: 6px;
      color: #111827;
      page-break-after: avoid;
    }
    a {
      color: #2563eb;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    p {
      margin-bottom: 8px;
      color: #4b5563;
    }
    .text-sm {
      font-size: 14px;
    }
    .text-gray {
      color: #6b7280;
    }
    .intro-text {
      font-size: 13px;
      line-height: 1.6;
      color: #6b7280;
    }
    
    /* Audit Results Grid */
    .audit-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 16px;
      page-break-inside: auto;
      break-inside: auto;
    }
    
    /* Score Display */
    .score-section {
      text-align: center;
      page-break-inside: auto;
      break-inside: auto;
    }
    .score-circle-container {
      position: relative;
      width: 220px;
      height: 220px;
      margin: 0 auto 12px;
    }
    .score-circle {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    .score-value {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 56px;
      font-weight: 700;
      color: ${getScoreColor(data.score)};
    }
    .score-message {
      font-size: 16px;
      font-weight: 500;
      color: #374151;
      margin: 12px 0;
    }
    .recommendations-badge {
      display: inline-block;
      background: #fce7f3;
      color: #db2777;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      margin-top: 6px;
    }
    
    /* Category Scores */
    .category-scores {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      max-width: 350px;
      margin: 16px auto 0;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .category-score {
      text-align: center;
    }
    .category-circle-container {
      position: relative;
      width: 85px;
      height: 85px;
      margin: 0 auto 6px;
    }
    .category-label {
      font-size: 12px;
      font-weight: 500;
      color: #2563eb;
    }
    .timestamp {
      font-size: 12px;
      color: #9ca3af;
      margin-top: 14px;
    }
    
    /* Screenshots */
    .screenshot-container {
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .desktop-screenshot {
      border: 3px solid #e5e7eb;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 10px 15px rgba(0, 0, 0, 0.1);
      background: white;
      width: 100%;
    }
    .desktop-screenshot img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 350px;
      object-fit: contain;
    }
    .mobile-screenshot {
      position: absolute;
      bottom: -24px;
      right: -12px;
      width: 120px;
      border: 3px solid #e5e7eb;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 15px 20px rgba(0, 0, 0, 0.2);
      background: white;
      z-index: 10;
    }
    .mobile-screenshot img {
      display: block;
      width: 100%;
      height: auto;
    }
    
    /* Recommendations */
    .recommendation-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 0;
      border-bottom: 1px solid #f3f4f6;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .recommendation-item:last-child {
      border-bottom: none;
    }
    .recommendation-title {
      font-weight: 500;
      color: #111827;
      flex: 1;
    }
    .recommendation-badges {
      display: flex;
      gap: 12px;
      align-items: center;
    }
    .badge {
      padding: 4px 12px;
      border-radius: 16px;
      font-size: 13px;
    }
    .badge-category {
      background: #f3f4f6;
      color: #4b5563;
    }
    .badge-priority {
      background: #d1fae5;
      color: #059669;
      font-weight: 500;
    }
    
    /* Score with Description */
    .score-with-desc {
      display: flex;
      gap: 32px;
      align-items: flex-start;
      margin-bottom: 24px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .small-score-circle-container {
      position: relative;
      width: 160px;
      height: 160px;
      flex-shrink: 0;
    }
    .small-score-value {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      font-size: 48px;
      font-weight: 700;
    }
    .desc-content {
      flex: 1;
    }
    .desc-content h3 {
      margin-bottom: 12px;
    }
    .desc-content p {
      line-height: 1.7;
    }
    
    /* Check Items */
    .check-item {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 16px 0;
      border-bottom: 1px solid #e5e7eb;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .check-item:last-child {
      border-bottom: none;
    }
    .check-content {
      flex: 1;
      padding-right: 20px;
    }
    .check-icon {
      font-size: 36px;
      font-weight: 700;
      flex-shrink: 0;
      line-height: 1;
    }
    .check-icon.pass { color: #10b981; }
    .check-icon.fail { color: #ef4444; }
    
    .info-box {
      background: #f9fafb;
      padding: 12px;
      border-radius: 6px;
      margin: 8px 0;
      font-size: 14px;
      color: #1f2937;
    }
    
    /* Header Frequency Chart */
    .header-chart {
      margin-top: 16px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .chart-header {
      display: grid;
      grid-template-columns: 100px 100px 1fr;
      gap: 16px;
      font-size: 13px;
      font-weight: 600;
      color: #6b7280;
      margin-bottom: 12px;
    }
    .chart-row {
      display: grid;
      grid-template-columns: 100px 100px 1fr;
      gap: 16px;
      align-items: center;
      margin-bottom: 8px;
    }
    .chart-tag {
      color: #6b7280;
      font-weight: 500;
    }
    .chart-count {
      color: #1f2937;
    }
    .chart-bar-container {
      height: 8px;
      background: #f3f4f6;
      border-radius: 4px;
      overflow: hidden;
    }
    .chart-bar {
      height: 100%;
      background: #3b82f6;
      border-radius: 4px;
    }
    
    /* Local SEO Details */
    .local-details {
      background: #f9fafb;
      padding: 12px;
      border-radius: 6px;
      margin: 12px 0;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .local-detail-row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .local-detail-row:last-child {
      margin-bottom: 0;
    }
    .local-label {
      color: #6b7280;
      font-weight: 500;
      min-width: 80px;
    }
    .local-value {
      color: #1f2937;
    }
    .local-value.not-found {
      color: #ef4444;
    }
    
    svg {
      transform: rotate(-90deg);
    }
  </style>
</head>
<body>
  <!-- Page Header -->
  <div class="page-header">
    <h1>SEO Report for ${getHostname(data.url)}</h1>
  </div>

  <div class="container">
    <!-- Introduction -->
    <div class="section" style="page-break-inside: auto; break-inside: auto;">
      <h1>
        Website Report for 
        <a href="${data.url.startsWith('http') ? data.url : `https://${data.url}`}" target="_blank">
          ${getHostname(data.url)}
        </a>
      </h1>
      <p class="intro-text">
        This report grades your website on the strength of a range of
        important factors such as on-page SEO optimization, off-page
        backlinks, social, performance, security and more. The overall
        grade is on a A+ to F- scale, with most major industry leading
        websites in the A range. Improving a website's grade is
        recommended to ensure a better website experience for your users
        and improved ranking and visibility by search engines.
      </p>
    </div>

    <!-- Audit Results -->
    <div class="section" style="page-break-inside: auto; break-inside: auto;">
      <h2>
        Audit Results for 
        <a href="${data.url.startsWith('http') ? data.url : `https://${data.url}`}" target="_blank">
          ${getHostname(data.url)}
        </a>
      </h2>

      <div class="audit-grid">
        <!-- Left: Score and Categories -->
        <div>
          <div class="score-section">
            <div class="score-circle-container">
              <svg class="score-circle" width="220" height="220" viewBox="0 0 220 220">
                <circle cx="110" cy="110" r="${radius}" stroke="#e5e7eb" stroke-width="12" fill="none"/>
                <circle cx="110" cy="110" r="${radius}" stroke="${getScoreColor(data.score)}" stroke-width="12" fill="none"
                  stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}" stroke-linecap="round"/>
              </svg>
              <div class="score-value">${data.score}</div>
            </div>
            <div class="score-message">${getScoreMessage(data.score)}</div>
            ${data.recommendations && data.recommendations.length > 0 ? `
              <div class="recommendations-badge">
                Recommendations: ${data.recommendations.length}
              </div>
            ` : ''}
            
            <!-- Category Scores -->
            <div class="category-scores">
              <!-- On-Page SEO -->
              <div class="category-score">
                <div class="category-circle-container">
                  <svg width="85" height="85" viewBox="0 0 85 85">
                    <circle cx="42.5" cy="42.5" r="${smallRadius}" stroke="#e5e7eb" stroke-width="5" fill="none"/>
                    <circle cx="42.5" cy="42.5" r="${smallRadius}" stroke="${getScoreColor(data.onPageSEO.score)}" stroke-width="5" fill="none"
                      stroke-dasharray="${smallCircumference}" stroke-dashoffset="${smallCircumference - (data.onPageSEO.score / 100) * smallCircumference}" stroke-linecap="round"/>
                  </svg>
                  <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 22px; font-weight: 700; color: ${getScoreColor(data.onPageSEO.score)};">
                    ${data.onPageSEO.score}
                  </div>
                </div>
                <div class="category-label">On-Page SEO</div>
              </div>

              <!-- Social -->
              <div class="category-score">
                <div class="category-circle-container">
                  <svg width="85" height="85" viewBox="0 0 85 85">
                    <circle cx="42.5" cy="42.5" r="${smallRadius}" stroke="#e5e7eb" stroke-width="5" fill="none"/>
                    <circle cx="42.5" cy="42.5" r="${smallRadius}" stroke="${data.social.score === 0 ? '#d1d5db' : getScoreColor(data.social.score)}" stroke-width="5" fill="none"
                      stroke-dasharray="${smallCircumference}" stroke-dashoffset="${smallCircumference - (data.social.score / 100) * smallCircumference}" stroke-linecap="round"/>
                  </svg>
                  <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 22px; font-weight: 700; color: ${data.social.score === 0 ? '#9ca3af' : getScoreColor(data.social.score)};">
                    ${data.social.score}
                  </div>
                </div>
                <div class="category-label">Social</div>
              </div>
            </div>

            <div class="timestamp">
              Report Generated: ${formatDate()}
            </div>
          </div>
        </div>

        <!-- Right: Screenshots -->
        <div class="screenshot-container">
          ${data.screenshot ? `
            <div style="position: relative; width: 100%; max-width: 450px;">
              <div class="desktop-screenshot">
                <img src="${data.screenshot}" alt="Desktop screenshot" />
              </div>
              ${data.screenshotMobile ? `
                <div class="mobile-screenshot">
                  <img src="${data.screenshotMobile}" alt="Mobile screenshot" />
                </div>
              ` : ''}
            </div>
          ` : `
            <div style="width: 100%; max-width: 500px; height: 300px; background: #f3f4f6; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #9ca3af;">
              No screenshot available
            </div>
          `}
        </div>
      </div>
    </div>

    <!-- Recommendations -->
    ${data.recommendations && data.recommendations.length > 0 ? `
      <div class="section">
        <h2>Recommendations</h2>
        <div>
          ${data.recommendations.map(rec => `
            <div class="recommendation-item">
              <div class="recommendation-title">${rec.title}</div>
              <div class="recommendation-badges">
                <span class="badge badge-category">${rec.category}</span>
                <span class="badge badge-priority">${rec.priority}</span>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    ` : ''}

    <!-- On-Page SEO Results -->
    <div class="section">
      <h2>On-Page SEO Results</h2>

      <div class="score-with-desc">
        <div class="small-score-circle-container">
          <svg width="160" height="160" viewBox="0 0 160 160">
            <circle cx="80" cy="80" r="70" stroke="#e5e7eb" stroke-width="10" fill="none"/>
            <circle cx="80" cy="80" r="70" stroke="${getScoreColor(data.onPageSEO.score)}" stroke-width="10" fill="none"
              stroke-dasharray="439.6" stroke-dashoffset="${439.6 - (data.onPageSEO.score / 100) * 439.6}" stroke-linecap="round"/>
          </svg>
          <div class="small-score-value" style="color: ${getScoreColor(data.onPageSEO.score)};">
            ${data.onPageSEO.score}
          </div>
        </div>
        <div class="desc-content">
          <h3>${data.onPageSEO.message}</h3>
          <p>${data.onPageSEO.description}</p>
        </div>
      </div>

      <!-- Title Tag -->
      <div class="check-item">
        <div class="check-content">
          <h4>Title Tag</h4>
          <p class="text-sm text-gray">
            ${!data.metaTags.hasTitle
              ? "Your page does not have a Title Tag."
              : data.metaTags.titleLength >= 50 && data.metaTags.titleLength <= 60
              ? "You have a Title Tag of optimal length (between 50 and 60 characters)."
              : data.metaTags.titleLength < 50
              ? "You have a Title Tag, but ideally it should be lengthened to between 50 and 60 characters (including spaces)."
              : "You have a Title Tag, but ideally it should be shortened to between 50 and 60 characters (including spaces)."}
          </p>
          ${data.title ? `
            <div class="info-box">
              ${data.title}
              <div class="text-sm text-gray" style="margin-top: 8px;">Length: ${data.metaTags.titleLength}</div>
            </div>
          ` : ''}
          <p class="text-sm text-gray" style="margin-top: 8px;">
            Title Tags are very important for search engines to correctly understand and categorize your content.
          </p>
        </div>
        <div class="check-icon ${data.metaTags.hasTitle && data.metaTags.titleLength >= 50 && data.metaTags.titleLength <= 60 ? 'pass' : 'fail'}">
          ${data.metaTags.hasTitle && data.metaTags.titleLength >= 50 && data.metaTags.titleLength <= 60 ? '✓' : '✗'}
        </div>
      </div>

      <!-- Meta Description -->
      <div class="check-item">
        <div class="check-content">
          <h4>Meta Description Tag</h4>
          <p class="text-sm text-gray">
            ${!data.metaTags.hasDescription
              ? "Your page does not have a Meta Description Tag."
              : data.metaTags.descriptionLength >= 120 && data.metaTags.descriptionLength <= 160
              ? "You have a Meta Description Tag of optimal length (between 120 and 160 characters)."
              : data.metaTags.descriptionLength < 120
              ? "Your page has a Meta Description Tag however, your Meta Description should ideally be lengthened to between 120 and 160 characters (including spaces)."
              : "Your page has a Meta Description Tag however, your Meta Description should ideally be shortened to between 120 and 160 characters (including spaces)."}
          </p>
          ${data.description ? `
            <div class="info-box">
              ${data.description}
              <div class="text-sm text-gray" style="margin-top: 8px;">Length: ${data.metaTags.descriptionLength}</div>
            </div>
          ` : ''}
          <p class="text-sm text-gray" style="margin-top: 8px;">
            A Meta Description is important for search engines to understand the content of your page, and is often shown as the description text blurb in search results.
          </p>
        </div>
        <div class="check-icon ${data.metaTags.hasDescription && data.metaTags.descriptionLength >= 120 && data.metaTags.descriptionLength <= 160 ? 'pass' : 'fail'}">
          ${data.metaTags.hasDescription && data.metaTags.descriptionLength >= 120 && data.metaTags.descriptionLength <= 160 ? '✓' : '✗'}
        </div>
      </div>

      <!-- H1 Header -->
      <div class="check-item">
        <div class="check-content">
          <h4>H1 Header Tag Usage</h4>
          <p class="text-sm text-gray">
            ${data.headings.h1Count === 0
              ? "Your page is missing an H1 Tag."
              : data.headings.h1Count === 1
              ? "Your page has a H1 Tag."
              : "Your page has more than one H1 Tag. It is generally recommended to only use one H1 Tag on a page."}
          </p>
          <p class="text-sm text-gray" style="margin-top: 8px;">
            The H1 Header Tag is an important way of signaling to search engines what your content is about, and subsequently the keywords it should rank for.
          </p>
        </div>
        <div class="check-icon ${data.headings.h1Count === 1 ? 'pass' : 'fail'}">
          ${data.headings.h1Count === 1 ? '✓' : '✗'}
        </div>
      </div>

      <!-- H2-H6 Headers -->
      <div class="check-item">
        <div class="check-content">
          <h4>H2-H6 Header Tag Usage</h4>
          <p class="text-sm text-gray">
            ${data.headings.h2Count > 0 
              ? "Your page is making use of multiple levels of Header Tags (which is good)." 
              : "Your page should use multiple levels of Header Tags, such as H2 and H3."}
          </p>
          <p class="text-sm text-gray" style="margin-top: 8px;">
            When HTML Heading Tags are used properly, they help search engines better understand the structure and context of your web page.
          </p>
          <div class="header-chart">
            <div class="chart-header">
              <div>HEADER TAG</div>
              <div>FREQUENCY</div>
              <div></div>
            </div>
            ${[
              { tag: 'H2', count: data.headings.h2Count },
              { tag: 'H3', count: data.headings.h3Count },
              { tag: 'H4', count: data.headings.h4Count },
              { tag: 'H5', count: data.headings.h5Count },
              { tag: 'H6', count: data.headings.h6Count }
            ].map(h => `
              <div class="chart-row">
                <div class="chart-tag">${h.tag}</div>
                <div class="chart-count">${h.count}</div>
                <div class="chart-bar-container">
                  ${h.count > 0 ? `<div class="chart-bar" style="width: ${Math.min((h.count / 10) * 100, 100)}%;"></div>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="check-icon ${data.headings.h2Count > 0 ? 'pass' : 'fail'}">
          ${data.headings.h2Count > 0 ? '✓' : '✗'}
        </div>
      </div>

      <!-- Image Alt Attributes -->
      <div class="check-item">
        <div class="check-content">
          <h4>Image Alt Attributes</h4>
          <p class="text-sm text-gray">
            ${data.images.withoutAlt === 0
              ? "You do not have any images missing Alt Attributes on your page."
              : "You have images on your page that are missing Alt Attributes."}
          </p>
          ${data.images.total > 0 ? `
            <p class="text-sm text-gray" style="margin-top: 8px;">
              We found ${data.images.total} image${data.images.total > 1 ? 's' : ''} on your page${data.images.withoutAlt > 0 ? ` and ${data.images.withoutAlt} of them ${data.images.withoutAlt === 1 ? 'is' : 'are'} missing the attribute` : ' and all have Alt Attributes'}.
            </p>
          ` : ''}
          <p class="text-sm text-gray" style="margin-top: 8px;">
            Alt Attributes are an often overlooked and simple way to signal to Search Engines what an image is about, and help it rank in image search results.
          </p>
        </div>
        <div class="check-icon ${data.images.withoutAlt === 0 ? 'pass' : 'fail'}">
          ${data.images.withoutAlt === 0 ? '✓' : '✗'}
        </div>
      </div>

      <!-- SSL Enabled -->
      <div class="check-item">
        <div class="check-content">
          <h4>SSL Enabled</h4>
          <p class="text-sm text-gray">
            ${data.technicalSEO.hasSSL 
              ? "Your website has SSL enabled." 
              : "Your website does not have SSL enabled."}
          </p>
        </div>
        <div class="check-icon ${data.technicalSEO.hasSSL ? 'pass' : 'fail'}">
          ${data.technicalSEO.hasSSL ? '✓' : '✗'}
        </div>
      </div>

      <!-- Robots.txt -->
      <div class="check-item">
        <div class="check-content">
          <h4>Robots.txt</h4>
          <p class="text-sm text-gray">
            ${data.technicalSEO.hasRobotsTxt 
              ? "Your website appears to have a robots.txt file." 
              : "Your website does not appear to have a robots.txt file."}
          </p>
          ${data.technicalSEO.robotsTxtUrl ? `
            <div class="info-box" style="margin-top: 8px;">
              <a href="${data.technicalSEO.robotsTxtUrl}" target="_blank">${data.technicalSEO.robotsTxtUrl}</a>
            </div>
          ` : ''}
        </div>
        <div class="check-icon ${data.technicalSEO.hasRobotsTxt ? 'pass' : 'fail'}">
          ${data.technicalSEO.hasRobotsTxt ? '✓' : '✗'}
        </div>
      </div>

      <!-- XML Sitemaps -->
      <div class="check-item">
        <div class="check-content">
          <h4>XML Sitemaps</h4>
          <p class="text-sm text-gray">
            ${data.technicalSEO.hasSitemap 
              ? "Your website appears to have an XML Sitemap." 
              : "Your website does not appear to have an XML Sitemap."}
          </p>
          ${data.technicalSEO.sitemapUrl ? `
            <div class="info-box" style="margin-top: 8px;">
              <a href="${data.technicalSEO.sitemapUrl}" target="_blank">${data.technicalSEO.sitemapUrl}</a>
            </div>
          ` : ''}
          ${data.technicalSEO.hasSitemap ? `
            <p class="text-sm text-gray" style="margin-top: 8px;">
              More Sitemaps were found, but not tested.
            </p>
          ` : ''}
        </div>
        <div class="check-icon ${data.technicalSEO.hasSitemap ? 'pass' : 'fail'}">
          ${data.technicalSEO.hasSitemap ? '✓' : '✗'}
        </div>
      </div>

      <!-- Analytics -->
      <div class="check-item">
        <div class="check-content">
          <h4>Analytics</h4>
          <p class="text-sm text-gray">
            ${data.technicalSEO.hasAnalytics 
              ? "We detected an analytics tool installed on your page." 
              : "We could not detect an analytics tool installed on your page."}
          </p>
          ${!data.technicalSEO.hasAnalytics ? `
            <p class="text-sm text-gray" style="margin-top: 8px;">
              Website analytics tools like Google Analytics assist you in measuring, analyzing and ultimately improving traffic to your page.
            </p>
          ` : ''}
        </div>
        <div class="check-icon ${data.technicalSEO.hasAnalytics ? 'pass' : 'fail'}">
          ${data.technicalSEO.hasAnalytics ? '✓' : '✗'}
        </div>
      </div>

      <!-- Schema.org Structured Data -->
      <div class="check-item">
        <div class="check-content">
          <h4>Schema.org Structured Data</h4>
          <p class="text-sm text-gray">
            ${data.technicalSEO.hasJsonLd 
              ? "You are using JSON-LD Schema on your page." 
              : "Your page is not using JSON-LD Schema."}
          </p>
        </div>
        <div class="check-icon ${data.technicalSEO.hasJsonLd ? 'pass' : 'fail'}">
          ${data.technicalSEO.hasJsonLd ? '✓' : '✗'}
        </div>
      </div>

      <!-- Identity Schema -->
      <div class="check-item">
        <div class="check-content">
          <h4>Identity Schema</h4>
          <p class="text-sm text-gray">
            ${data.technicalSEO.hasIdentitySchema 
              ? "Organization or Person Schema identified on the page." 
              : "No Organization or Person Schema identified on the page."}
          </p>
          ${data.technicalSEO.identityType ? `
            <div class="info-box" style="margin-top: 8px;">
              <strong>${data.technicalSEO.identityType}</strong>
            </div>
          ` : ''}
          <p class="text-sm text-gray" style="margin-top: 8px;">
            The absence of Organization or Person Schema can make it harder for Search Engines and LLMs to identify the ownership of a website and confidently answer brand, company or person queries.
          </p>
        </div>
        <div class="check-icon ${data.technicalSEO.hasIdentitySchema ? 'pass' : 'fail'}">
          ${data.technicalSEO.hasIdentitySchema ? '✓' : '✗'}
        </div>
      </div>
    </div>

    <!-- Social Results -->
    <div class="section">
      <h2>Social Results</h2>

      <div class="score-with-desc">
        <div class="small-score-circle-container">
          <svg width="160" height="160" viewBox="0 0 160 160">
            <circle cx="80" cy="80" r="70" stroke="#e5e7eb" stroke-width="10" fill="none"/>
            <circle cx="80" cy="80" r="70" stroke="${data.social.score === 0 ? '#d1d5db' : getScoreColor(data.social.score)}" stroke-width="10" fill="none"
              stroke-dasharray="439.6" stroke-dashoffset="${439.6 - (data.social.score / 100) * 439.6}" stroke-linecap="round"/>
          </svg>
          <div class="small-score-value" style="color: ${data.social.score === 0 ? '#9ca3af' : getScoreColor(data.social.score)};">
            ${data.social.score}
          </div>
        </div>
        <div class="desc-content">
          <h3>${data.social.message}</h3>
          <p>${data.social.description}</p>
        </div>
      </div>

      <!-- Facebook Page -->
      <div class="check-item">
        <div class="check-content">
          <h4>Facebook Page Linked</h4>
          <p class="text-sm text-gray">
            ${data.social.hasFacebookPage 
              ? "We found a linked Facebook Page on your website." 
              : "We did not detect a Facebook Page linked to your website."}
          </p>
          ${!data.social.hasFacebookPage ? `
            <p class="text-sm text-gray" style="margin-top: 8px;">
              Facebook is one of the top social media platforms and linking your business page helps strengthen your online presence.
            </p>
          ` : ''}
          ${data.social.facebookUrl ? `
            <div class="info-box" style="margin-top: 8px;">
              <a href="${data.social.facebookUrl}" target="_blank">${data.social.facebookUrl}</a>
            </div>
          ` : ''}
        </div>
        <div class="check-icon ${data.social.hasFacebookPage ? 'pass' : 'fail'}">
          ${data.social.hasFacebookPage ? '✓' : '✗'}
        </div>
      </div>

      <!-- Instagram -->
      <div class="check-item">
        <div class="check-content">
          <h4>Instagram Linked</h4>
          <p class="text-sm text-gray">
            ${data.social.hasInstagram 
              ? "We found a linked Instagram account on your website." 
              : "We did not detect an Instagram account linked to your website."}
          </p>
          ${!data.social.hasInstagram ? `
            <p class="text-sm text-gray" style="margin-top: 8px;">
              Instagram is a highly visual platform that can help showcase your brand and engage with customers.
            </p>
          ` : ''}
          ${data.social.instagramUrl ? `
            <div class="info-box" style="margin-top: 8px;">
              <a href="${data.social.instagramUrl}" target="_blank">${data.social.instagramUrl}</a>
            </div>
          ` : ''}
        </div>
        <div class="check-icon ${data.social.hasInstagram ? 'pass' : 'fail'}">
          ${data.social.hasInstagram ? '✓' : '✗'}
        </div>
      </div>
    </div>

    <!-- Local SEO -->
    <div class="section">
      <h2>Local SEO</h2>

      <!-- Address & Phone -->
      <div class="check-item">
        <div class="check-content">
          <h4>Address & Phone Shown on Website</h4>
          <p class="text-sm text-gray">
            ${(data.localSEO.hasPhone && data.localSEO.hasAddress)
              ? "We detected both an address and phone number on your website."
              : data.localSEO.hasPhone && !data.localSEO.hasAddress
              ? "We detected a phone number, but no address was found on your website."
              : !data.localSEO.hasPhone && data.localSEO.hasAddress
              ? "We detected an address, but no phone number was found on your website."
              : "We did not detect an address or phone number on your website."}
          </p>
          <p class="text-sm text-gray" style="margin-top: 8px;">
            Displaying your business address and phone number prominently helps build trust with visitors and is important for local SEO.
          </p>
          <div class="local-details">
            <div class="local-detail-row">
              <span class="local-label">Phone</span>
              <span class="local-value ${!data.localSEO.hasPhone || !data.localSEO.phoneNumber ? 'not-found' : ''}">
                ${data.localSEO.hasPhone && data.localSEO.phoneNumber ? data.localSEO.phoneNumber : 'Not found'}
              </span>
            </div>
            <div class="local-detail-row">
              <span class="local-label">Address</span>
              <span class="local-value ${!data.localSEO.hasAddress || !data.localSEO.addressText ? 'not-found' : ''}">
                ${data.localSEO.hasAddress && data.localSEO.addressText ? data.localSEO.addressText : 'Not found'}
              </span>
            </div>
          </div>
        </div>
        <div class="check-icon ${(data.localSEO.hasPhone && data.localSEO.hasAddress) ? 'pass' : 'fail'}">
          ${(data.localSEO.hasPhone && data.localSEO.hasAddress) ? '✓' : '✗'}
        </div>
      </div>

      <!-- Local Business Schema -->
      <div class="check-item">
        <div class="check-content">
          <h4>Local Business Schema</h4>
          <p class="text-sm text-gray">
            ${data.localSEO.hasLocalBusinessSchema 
              ? "Local Business Schema identified on the page." 
              : "No Local Business Schema identified on the page."}
          </p>
        </div>
        <div class="check-icon ${data.localSEO.hasLocalBusinessSchema ? 'pass' : 'fail'}">
          ${data.localSEO.hasLocalBusinessSchema ? '✓' : '✗'}
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}
