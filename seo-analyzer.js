import * as cheerio from "cheerio";
import puppeteer from "puppeteer";

export async function analyzeSEO(url) {
  console.log(`[ANALYZER] Starting analysis for: ${url}`);
  
  // Ensure URL has protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
    console.log(`[ANALYZER] Added protocol: ${url}`);
  }

  let browser;
  try {
    console.log(`[ANALYZER] Launching Puppeteer browser...`);
    // Launch Puppeteer browser
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    console.log(`[ANALYZER] Browser launched successfully`);

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Start timing
    const startTime = Date.now();

    // Navigate to the page
    console.log(`[ANALYZER] Navigating to page: ${url}`);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });
    console.log(`[ANALYZER] Page loaded successfully`);

    const loadTime = Date.now() - startTime;

    // Take desktop screenshot
    console.log(`[ANALYZER] Taking desktop screenshot...`);
    const screenshotDesktop = await page.screenshot({
      encoding: "base64",
      fullPage: false,
    });

    // Take mobile screenshot
    console.log(`[ANALYZER] Taking mobile screenshot...`);
    await page.setViewport({ width: 375, height: 667 }); // iPhone SE size
    const screenshotMobile = await page.screenshot({
      encoding: "base64",
      fullPage: false,
    });

    // Get HTML content
    const html = await page.content();
    
    // Calculate rendering percentage (text content vs HTML size)
    const $ = cheerio.load(html);
    const textContent = $("body").text().replace(/\s+/g, " ").trim();
    const htmlSize = html.length;
    const textSize = textContent.length;
    const renderingPercentage = htmlSize > 0 
      ? Math.round((textSize / htmlSize) * 100)
      : 0;

    // Close browser
    await browser.close();

    // Parse with Cheerio (already loaded above)

    // Analyze Meta Tags
    const title = $("title").text() || "";
    const description = $('meta[name="description"]').attr("content") || "";
    const viewport = $('meta[name="viewport"]').attr("content") || "";
    const ogTags = $('meta[property^="og:"]').length;
    const twitterCard = $('meta[name^="twitter:"]').length;

    const metaTags = {
      hasTitle: title.length > 0,
      titleLength: title.length,
      hasDescription: description.length > 0,
      descriptionLength: description.length,
      hasViewport: viewport.length > 0,
      hasOgTags: ogTags > 0,
      hasTwitterCard: twitterCard > 0,
    };

    // Analyze Headings
    const h1Elements = $("h1");
    const h1Text = h1Elements
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((text) => text.length > 0);

    const headings = {
      h1Count: h1Elements.length,
      h2Count: $("h2").length,
      h3Count: $("h3").length,
      h4Count: $("h4").length,
      h5Count: $("h5").length,
      h6Count: $("h6").length,
      hasH1: h1Elements.length > 0,
      h1Text: h1Text,
    };

    // Analyze Images
    const images = $("img");
    const imagesWithAlt = images.filter('[alt!=""]').length;
    const totalImages = images.length;

    const imagesData = {
      total: totalImages,
      withAlt: imagesWithAlt,
      withoutAlt: totalImages - imagesWithAlt,
      altPercentage:
        totalImages > 0 ? Math.round((imagesWithAlt / totalImages) * 100) : 100,
    };

    // Analyze Links
    const links = $("a[href]");
    const urlObj = new URL(url);
    let internalLinks = 0;
    let externalLinks = 0;

    links.each((_, el) => {
      const href = $(el).attr("href") || "";
      if (href.startsWith("/") || href.includes(urlObj.hostname)) {
        internalLinks++;
      } else if (href.startsWith("http")) {
        externalLinks++;
      }
    });

    const linksData = {
      total: links.length,
      internal: internalLinks,
      external: externalLinks,
      broken: 0,
    };

    // Analyze Content
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();
    const wordCount = bodyText.split(/\s+/).length;

    const content = {
      wordCount: wordCount,
      textLength: bodyText.length,
    };

    // Technical SEO
    const isSSL = url.startsWith("https://");

    // Check for robots.txt
    const robotsTxtUrl = `${urlObj.protocol}//${urlObj.hostname}/robots.txt`;
    let hasRobotsTxt = false;
    try {
      const robotsResponse = await fetch(robotsTxtUrl, { method: "HEAD" });
      hasRobotsTxt = robotsResponse.ok;
    } catch {
      hasRobotsTxt = false;
    }

    // Check for sitemap
    const sitemapUrl = `${urlObj.protocol}//${urlObj.hostname}/sitemap.xml`;
    let hasSitemap = false;
    try {
      const sitemapResponse = await fetch(sitemapUrl, { method: "HEAD" });
      hasSitemap = sitemapResponse.ok;
    } catch {
      hasSitemap = false;
    }

    // Check for analytics
    const hasGoogleAnalytics = html.includes("google-analytics.com/analytics.js") || 
                                html.includes("googletagmanager.com/gtag/js") ||
                                html.includes("gtag(") ||
                                html.includes("ga(");
    const hasFacebookPixel = html.includes("facebook.net/en_US/fbevents.js") || html.includes("fbq(");
    const hasAnalytics = hasGoogleAnalytics || hasFacebookPixel;

    // Check for Schema.org structured data
    const ldJsonScripts = $('script[type="application/ld+json"]');
    const schemaTypes = [];
    let hasIdentitySchema = false;
    let identityType = "";
    let hasLocalBusinessSchema = false;

    // Helper function to extract schema types recursively
    const extractSchemaTypes = (schema) => {
      if (!schema) return;
      
      // Handle @graph array
      if (schema["@graph"] && Array.isArray(schema["@graph"])) {
        schema["@graph"].forEach(item => extractSchemaTypes(item));
        return;
      }
      
      // Handle single schema or array of schemas
      if (schema["@type"]) {
        const types = Array.isArray(schema["@type"]) ? schema["@type"] : [schema["@type"]];
        
        types.forEach(type => {
          if (type && !schemaTypes.includes(type)) {
            schemaTypes.push(type);
            
            // Check for identity schema
            if (type === "Organization" || type === "Person" || 
                type === "Corporation" || type === "LocalBusiness") {
              hasIdentitySchema = true;
              identityType = type;
            }
            
            // Check for local business schema
            if (type === "LocalBusiness" || type.includes("LocalBusiness") ||
                type === "Restaurant" || type === "Store" || 
                type === "MedicalBusiness" || type === "ProfessionalService") {
              hasLocalBusinessSchema = true;
            }
          }
        });
      }
      
      // Check nested objects
      Object.values(schema).forEach(value => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          extractSchemaTypes(value);
        } else if (Array.isArray(value)) {
          value.forEach(item => {
            if (item && typeof item === 'object') {
              extractSchemaTypes(item);
            }
          });
        }
      });
    };

    ldJsonScripts.each((_, el) => {
      try {
        const jsonContent = $(el).html();
        if (jsonContent) {
          const schema = JSON.parse(jsonContent);
          extractSchemaTypes(schema);
        }
      } catch (error) {
        console.log('[ANALYZER] Invalid JSON-LD schema:', error.message);
      }
    });
    
    // Also check for microdata and RDFa
    const hasMicrodata = $('[itemtype]').length > 0;
    const hasRDFa = $('[vocab], [typeof]').length > 0;
    const hasAnyStructuredData = schemaTypes.length > 0 || hasMicrodata || hasRDFa;

    const technicalSEO = {
      hasRobotsTxt,
      robotsTxtUrl: hasRobotsTxt ? robotsTxtUrl : undefined,
      hasSitemap,
      sitemapUrl: hasSitemap ? sitemapUrl : undefined,
      hasSSL: isSSL,
      isResponsive: viewport.length > 0,
      hasAnalytics,
      hasSchema: hasAnyStructuredData,
      schemaTypes,
      hasIdentitySchema,
      identityType: hasIdentitySchema ? identityType : undefined,
      renderingPercentage,
      hasMicrodata,
      hasRDFa,
    };

    // Analyze Social Media Links
    let facebookUrl = "";
    let instagramUrl = "";
    let twitterUrl = "";
    let linkedInUrl = "";
    let youTubeUrl = "";

    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || "";
      
      if (href.includes("facebook.com/") && !facebookUrl) {
        facebookUrl = href;
      }
      if (href.includes("instagram.com/") && !instagramUrl) {
        instagramUrl = href;
      }
      if (href.includes("twitter.com/") || href.includes("x.com/")) {
        if (!twitterUrl) twitterUrl = href;
      }
      if (href.includes("linkedin.com/") && !linkedInUrl) {
        linkedInUrl = href;
      }
      if (href.includes("youtube.com/") && !youTubeUrl) {
        youTubeUrl = href;
      }
    });

    const ogFacebook = $('meta[property="og:url"]').attr("content") || "";
    if (ogFacebook.includes("facebook.com/") && !facebookUrl) {
      facebookUrl = ogFacebook;
    }

    const hasFacebookPage = facebookUrl.length > 0;
    const hasInstagram = instagramUrl.length > 0;
    const hasTwitter = twitterUrl.length > 0;
    const hasLinkedIn = linkedInUrl.length > 0;
    const hasYouTube = youTubeUrl.length > 0;

    // Calculate Social Score - Based on Facebook and Instagram only
    let socialScore = 0;
    if (hasFacebookPage && hasInstagram) {
      socialScore = 100;
    } else if (hasFacebookPage || hasInstagram) {
      socialScore = 50;
    } else {
      socialScore = 0;
    }

    let socialMessage = "";
    let socialDescription = "";

    if (socialScore === 0) {
      socialMessage = "Your social needs improvement";
      socialDescription = "You appear to have a weak social presence or level of social activity (or we may just not be able to see your profiles!). Social activity is important for customer communication, brand awareness and as a marketing channel to bring visitors to your website. We recommend that you list all of your profiles on your page for visibility, and begin to build a following on those networks.";
    } else if (socialScore === 50) {
      socialMessage = "Your social presence needs work";
      socialDescription = "You have one major social media profile, but you're missing the other. Social activity is important for customer communication, brand awareness and as a marketing channel to bring visitors to your website. Consider adding both Facebook and Instagram profiles for better reach.";
    } else {
      socialMessage = "Your social presence is excellent!";
      socialDescription = "You have an excellent social media presence across multiple platforms. Social activity is important for customer communication, brand awareness and as a marketing channel to bring visitors to your website. Continue engaging with your audience across these networks.";
    }

    const social = {
      score: socialScore,
      message: socialMessage,
      description: socialDescription,
      hasFacebookPage,
      facebookUrl: hasFacebookPage ? facebookUrl : undefined,
      hasInstagram,
      instagramUrl: hasInstagram ? instagramUrl : undefined,
      hasTwitter,
      twitterUrl: hasTwitter ? twitterUrl : undefined,
      hasLinkedIn,
      linkedInUrl: hasLinkedIn ? linkedInUrl : undefined,
      hasYouTube,
      youTubeUrl: hasYouTube ? youTubeUrl : undefined,
    };

    // Performance
    const performance = {
      loadTime: loadTime,
      pageSize: Math.round(html.length / 1024),
    };

    // Calculate Score - Start from 100 and deduct for issues
    let score = 100;
    let deductions = [];

    // Title Tag - High Impact (deduct up to 10 points)
    if (!metaTags.hasTitle) {
      score -= 10;
      deductions.push("Missing Title Tag: -10");
    } else if (metaTags.titleLength < 50 || metaTags.titleLength > 60) {
      score -= 5;
      deductions.push("Suboptimal Title Length: -5");
    }
    
    // Meta Description - High Impact (deduct up to 10 points)
    if (!metaTags.hasDescription) {
      score -= 10;
      deductions.push("Missing Meta Description: -10");
    } else if (metaTags.descriptionLength < 120 || metaTags.descriptionLength > 160) {
      score -= 5;
      deductions.push("Suboptimal Description Length: -5");
    }
    
    // H1 Tag - High Impact (deduct up to 10 points)
    if (!headings.hasH1) {
      score -= 10;
      deductions.push("Missing H1 Tag: -10");
    } else if (headings.h1Count !== 1) {
      score -= 5;
      deductions.push("Multiple H1 Tags: -5");
    }
    
    // H2-H6 Headers - Medium Impact
    if (headings.h2Count === 0) {
      score -= 5;
      deductions.push("No H2 Tags: -5");
    }
    
    // Image Alt Attributes - Medium Impact (deduct based on percentage missing)
    const altDeduction = Math.round((100 - imagesData.altPercentage) / 10);
    if (altDeduction > 0) {
      score -= altDeduction;
      deductions.push(`Images without Alt (${100 - imagesData.altPercentage}%): -${altDeduction}`);
    }
    
    // Content - High Impact
    if (content.wordCount < 50) {
      score -= 15;
      deductions.push("Very Low Word Count: -15");
    } else if (content.wordCount < 150) {
      score -= 10;
      deductions.push("Low Word Count: -10");
    } else if (content.wordCount < 300) {
      score -= 5;
      deductions.push("Below Recommended Word Count: -5");
    }
    
    // Technical SEO - Medium to High Impact
    if (!technicalSEO.hasSSL) {
      score -= 10;
      deductions.push("No SSL Certificate: -10");
    }
    if (!technicalSEO.hasRobotsTxt) {
      score -= 5;
      deductions.push("No robots.txt: -5");
    }
    if (!technicalSEO.hasSitemap) {
      score -= 5;
      deductions.push("No XML Sitemap: -5");
    }
    if (!technicalSEO.hasSchema) {
      score -= 5;
      deductions.push("No Schema.org Data: -5");
    }
    if (!technicalSEO.hasIdentitySchema) {
      score -= 3;
      deductions.push("No Identity Schema: -3");
    }
    if (!technicalSEO.hasAnalytics) {
      score -= 3;
      deductions.push("No Analytics Tool: -3");
    }
    
    // Basic SEO Elements
    if (!metaTags.hasViewport) {
      score -= 3;
      deductions.push("No Viewport Meta: -3");
    }
    if (!metaTags.hasOgTags) {
      score -= 2;
      deductions.push("No Open Graph Tags: -2");
    }
    if (!metaTags.hasTwitterCard) {
      score -= 2;
      deductions.push("No Twitter Card: -2");
    }
    
    // Links
    if (linksData.total === 0) {
      score -= 3;
      deductions.push("No Links Found: -3");
    } else if (linksData.internal === 0) {
      score -= 2;
      deductions.push("No Internal Links: -2");
    }
    
    // Ensure score doesn't go below 0
    score = Math.max(0, score);
    
    console.log(`[ANALYZER] Score calculations:`, deductions);

    // Determine Grade
    let grade = "F";
    if (score >= 90) grade = "A+";
    else if (score >= 85) grade = "A";
    else if (score >= 80) grade = "A-";
    else if (score >= 75) grade = "B+";
    else if (score >= 70) grade = "B";
    else if (score >= 65) grade = "B-";
    else if (score >= 60) grade = "C+";
    else if (score >= 55) grade = "C";
    else if (score >= 50) grade = "C-";
    else if (score >= 45) grade = "D+";
    else if (score >= 40) grade = "D";
    else if (score >= 35) grade = "D-";

    // Calculate On-Page SEO Score - Start from 100 and deduct for issues
    let onPageScore = 100;
    
    // Title Tag - deduct up to 20 points
    if (!metaTags.hasTitle) {
      onPageScore -= 20;
    } else if (metaTags.titleLength < 50 || metaTags.titleLength > 60) {
      onPageScore -= 10;
    }
    
    // Meta Description - deduct up to 20 points
    if (!metaTags.hasDescription) {
      onPageScore -= 20;
    } else if (metaTags.descriptionLength < 120 || metaTags.descriptionLength > 160) {
      onPageScore -= 10;
    }
    
    // H1 Tag - deduct up to 10 points
    if (!headings.hasH1) {
      onPageScore -= 10;
    } else if (headings.h1Count !== 1) {
      onPageScore -= 5;
    }
    
    // H2+ Tags - deduct up to 10 points
    if (headings.h2Count === 0) {
      onPageScore -= 10;
    } else if (headings.h2Count === 1) {
      onPageScore -= 5;
    }
    
    // Image Alt - deduct based on percentage missing (up to 10 points)
    const onPageAltDeduction = Math.round((100 - imagesData.altPercentage) / 10);
    onPageScore -= onPageAltDeduction;
    
    // Technical SEO elements
    if (!technicalSEO.hasSSL) onPageScore -= 10;
    if (!technicalSEO.hasRobotsTxt) onPageScore -= 5;
    if (!technicalSEO.hasSitemap) onPageScore -= 5;
    if (!technicalSEO.hasSchema) onPageScore -= 5;
    if (!technicalSEO.hasIdentitySchema) onPageScore -= 5;
    
    // Ensure score doesn't go below 0
    onPageScore = Math.max(0, onPageScore);

    let onPageMessage = "";
    let onPageDescription = "";
    
    if (onPageScore >= 90) {
      onPageMessage = "Your On-Page SEO is excellent!";
      onPageDescription = "Outstanding work! Your On-Page SEO is exceptionally well optimized. On-Page SEO is important to ensure Search Engines can understand your content appropriately and help it rank for relevant keywords. Continue maintaining these high standards.";
    } else if (onPageScore >= 80) {
      onPageMessage = "Your On-Page SEO is very good!";
      onPageDescription = "Congratulations, your On-Page SEO is well optimized. On-Page SEO is important to ensure Search Engines can understand your content appropriately and help it rank for relevant keywords. You can continue to build on your strong position through testing content improvements for gradual gains.";
    } else if (onPageScore >= 70) {
      onPageMessage = "Your On-Page SEO is good!";
      onPageDescription = "Your On-Page SEO is performing well. On-Page SEO is important to ensure Search Engines can understand your content appropriately and help it rank for relevant keywords. There are some areas for improvement that could boost your rankings further.";
    } else if (onPageScore >= 60) {
      onPageMessage = "Your On-Page SEO needs improvement";
      onPageDescription = "Your On-Page SEO has some optimization, but there are significant opportunities for improvement. On-Page SEO is important to ensure Search Engines can understand your content appropriately and help it rank for relevant keywords.";
    } else {
      onPageMessage = "Your On-Page SEO needs significant work";
      onPageDescription = "Your On-Page SEO requires substantial improvements. On-Page SEO is important to ensure Search Engines can understand your content appropriately and help it rank for relevant keywords. Focus on the recommendations below to improve your search visibility.";
    }

    const onPageSEO = {
      score: onPageScore,
      message: onPageMessage,
      description: onPageDescription,
    };

    const localSEO = {
      hasLocalBusinessSchema,
    };

    // Generate Recommendations
    const recommendations = [];

    if (!social.hasFacebookPage) {
      recommendations.push({
        title: "Create and link your Facebook Page",
        category: "Social",
        priority: "Low Priority",
      });
    }

    if (!social.hasInstagram) {
      recommendations.push({
        title: "Create and link an associated Instagram Profile",
        category: "Social",
        priority: "Low Priority",
      });
    }

    if (!technicalSEO.hasAnalytics) {
      recommendations.push({
        title: "Implement an Analytics Tracking Tool",
        category: "On-Page SEO",
        priority: "Low Priority",
      });
    }

    if (!localSEO.hasLocalBusinessSchema) {
      recommendations.push({
        title: "Add Local Business Schema",
        category: "Other",
        priority: "Low Priority",
      });
    }

    if (!technicalSEO.hasRobotsTxt) {
      recommendations.push({
        title: "Create a robots.txt file",
        category: "Technical SEO",
        priority: "Medium Priority",
      });
    }

    if (!technicalSEO.hasSitemap) {
      recommendations.push({
        title: "Create an XML Sitemap",
        category: "Technical SEO",
        priority: "Medium Priority",
      });
    }

    if (!metaTags.hasDescription || metaTags.descriptionLength < 120 || metaTags.descriptionLength > 160) {
      recommendations.push({
        title: "Optimize Meta Description (120-160 characters)",
        category: "On-Page SEO",
        priority: "High Priority",
      });
    }

    if (!metaTags.hasTitle || metaTags.titleLength < 50 || metaTags.titleLength > 60) {
      recommendations.push({
        title: "Optimize Title Tag (50-60 characters)",
        category: "On-Page SEO",
        priority: "High Priority",
      });
    }

    if (headings.h1Count !== 1) {
      recommendations.push({
        title: "Use exactly one H1 tag per page",
        category: "On-Page SEO",
        priority: "High Priority",
      });
    }

    if (imagesData.altPercentage < 100) {
      recommendations.push({
        title: "Add alt text to all images",
        category: "On-Page SEO",
        priority: "Medium Priority",
      });
    }

    if (!technicalSEO.hasIdentitySchema) {
      recommendations.push({
        title: "Add Organization or Person Schema",
        category: "Technical SEO",
        priority: "Medium Priority",
      });
    }
    
    if (!technicalSEO.hasSchema) {
      recommendations.push({
        title: "Add Schema.org Structured Data",
        category: "Technical SEO",
        priority: "Medium Priority",
      });
    }

    console.log(`[ANALYZER] Analysis completed successfully for: ${url}`);
    console.log(`[ANALYZER] Score: ${score}, Grade: ${grade}`);

    return {
      url,
      score,
      grade,
      screenshot: `data:image/png;base64,${screenshotDesktop}`,
      screenshotMobile: `data:image/png;base64,${screenshotMobile}`,
      title,
      description,
      metaTags,
      headings,
      images: imagesData,
      links: linksData,
      performance,
      content,
      technicalSEO,
      onPageSEO,
      social,
      localSEO,
      recommendations,
    };
  } catch (error) {
    console.error(`[ANALYZER] ERROR analyzing SEO for ${url}:`, error);
    console.error(`[ANALYZER] Error details:`, {
      message: error.message,
      stack: error.stack,
      name: error.name,
    });
    if (browser) {
      await browser.close();
      console.log(`[ANALYZER] Browser closed after error`);
    }
    throw error;
  }
}
