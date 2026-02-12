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

    // Take screenshot
    const screenshot = await page.screenshot({
      encoding: "base64",
      fullPage: false,
    });

    // Get HTML content
    const html = await page.content();

    // Close browser
    await browser.close();

    // Parse with Cheerio
    const $ = cheerio.load(html);

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

    ldJsonScripts.each((_, el) => {
      try {
        const jsonContent = $(el).html();
        if (jsonContent) {
          const schema = JSON.parse(jsonContent);
          if (schema["@type"]) {
            const type = Array.isArray(schema["@type"]) ? schema["@type"][0] : schema["@type"];
            schemaTypes.push(type);
            
            if (type === "Organization" || type === "Person") {
              hasIdentitySchema = true;
              identityType = type;
            }
            
            if (type === "LocalBusiness" || type.includes("LocalBusiness")) {
              hasLocalBusinessSchema = true;
            }
          }
        }
      } catch {
        // Invalid JSON, skip
      }
    });

    const technicalSEO = {
      hasRobotsTxt,
      robotsTxtUrl: hasRobotsTxt ? robotsTxtUrl : undefined,
      hasSitemap,
      sitemapUrl: hasSitemap ? sitemapUrl : undefined,
      hasSSL: isSSL,
      isResponsive: viewport.length > 0,
      hasAnalytics,
      hasSchema: schemaTypes.length > 0,
      schemaTypes,
      hasIdentitySchema,
      identityType: hasIdentitySchema ? identityType : undefined,
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

    // Calculate Social Score
    let socialScore = 0;
    if (hasFacebookPage) socialScore += 20;
    if (hasInstagram) socialScore += 20;
    if (hasTwitter) socialScore += 20;
    if (hasLinkedIn) socialScore += 20;
    if (hasYouTube) socialScore += 20;

    let socialMessage = "";
    let socialDescription = "";

    if (socialScore === 0) {
      socialMessage = "Your social needs improvement";
      socialDescription = "You appear to have a weak social presence or level of social activity (or we may just not be able to see your profiles!). Social activity is important for customer communication, brand awareness and as a marketing channel to bring visitors to your website. We recommend that you list all of your profiles on your page for visibility, and begin to build a following on those networks.";
    } else if (socialScore < 60) {
      socialMessage = "Your social presence needs work";
      socialDescription = "You have some social media presence, but there's room for improvement. Social activity is important for customer communication, brand awareness and as a marketing channel to bring visitors to your website. Consider expanding to more platforms and making your profiles more visible.";
    } else if (socialScore < 80) {
      socialMessage = "Your social presence is good";
      socialDescription = "You have a good social media presence with profiles on multiple platforms. Social activity is important for customer communication, brand awareness and as a marketing channel to bring visitors to your website. Keep building your following and engagement.";
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

    // Calculate Score
    let score = 0;

    if (metaTags.hasTitle && metaTags.titleLength >= 10 && metaTags.titleLength <= 60) score += 10;
    else if (metaTags.hasTitle) score += 5;
    
    if (metaTags.hasDescription && metaTags.descriptionLength >= 50 && metaTags.descriptionLength <= 160) score += 10;
    else if (metaTags.hasDescription) score += 5;
    
    if (metaTags.hasViewport) score += 5;
    if (metaTags.hasOgTags) score += 3;
    if (metaTags.hasTwitterCard) score += 2;

    if (headings.hasH1 && headings.h1Count === 1) score += 10;
    else if (headings.hasH1) score += 5;
    if (headings.h2Count > 0) score += 5;

    score += Math.round((imagesData.altPercentage / 100) * 15);

    if (content.wordCount >= 300) score += 20;
    else if (content.wordCount >= 150) score += 10;
    else if (content.wordCount >= 50) score += 5;

    if (linksData.total > 0) score += 5;
    if (linksData.internal > 0) score += 5;

    if (technicalSEO.hasSSL) score += 5;
    if (technicalSEO.isResponsive) score += 5;

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

    // Calculate On-Page SEO Score
    let onPageScore = 0;
    
    if (metaTags.hasTitle && metaTags.titleLength >= 50 && metaTags.titleLength <= 60) onPageScore += 20;
    else if (metaTags.hasTitle && metaTags.titleLength >= 10 && metaTags.titleLength <= 70) onPageScore += 15;
    else if (metaTags.hasTitle) onPageScore += 10;
    
    if (metaTags.hasDescription && metaTags.descriptionLength >= 120 && metaTags.descriptionLength <= 160) onPageScore += 20;
    else if (metaTags.hasDescription && metaTags.descriptionLength >= 50) onPageScore += 15;
    
    if (headings.hasH1 && headings.h1Count === 1) onPageScore += 10;
    else if (headings.hasH1) onPageScore += 5;
    if (headings.h2Count >= 2) onPageScore += 10;
    else if (headings.h2Count > 0) onPageScore += 5;
    
    if (imagesData.altPercentage === 100) onPageScore += 10;
    else if (imagesData.altPercentage >= 80) onPageScore += 7;
    else if (imagesData.altPercentage >= 50) onPageScore += 4;
    
    if (technicalSEO.hasSSL) onPageScore += 10;
    if (technicalSEO.hasRobotsTxt) onPageScore += 5;
    if (technicalSEO.hasSitemap) onPageScore += 5;
    if (technicalSEO.hasSchema) onPageScore += 5;
    if (technicalSEO.hasIdentitySchema) onPageScore += 5;

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
        priority: "Low Priority",
      });
    }

    console.log(`[ANALYZER] Analysis completed successfully for: ${url}`);
    console.log(`[ANALYZER] Score: ${score}, Grade: ${grade}`);

    return {
      url,
      score,
      grade,
      screenshot: `data:image/png;base64,${screenshot}`,
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
