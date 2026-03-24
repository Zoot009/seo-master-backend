import * as cheerio from "cheerio";
import puppeteer from "puppeteer";

// Thrown when the failure is caused by the target site (DNS, SSL, etc.) — not a server/infra error.
// The backend uses this to return 422 instead of 500 so the caller knows not to retry.
class SiteError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiteError';
  }
}

// fetch() with AbortSignal timeout — never hangs, never throws
async function safeFetch(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Map low-level Puppeteer/network errors to SiteErrors (won't be retried by the caller).
// Does nothing if the error isn't a known site-specific failure.
function classifyError(err) {
  const msg = err.message || "";
  if (msg.includes("ERR_NAME_NOT_RESOLVED") || msg.includes("NS_ERROR_UNKNOWN_HOST"))
    throw new SiteError("The domain could not be found. Please check the URL and try again.");
  if (msg.includes("ERR_CONNECTION_REFUSED"))
    throw new SiteError("The site refused the connection. It may be down or blocking automated access.");
  if (msg.includes("ERR_CONNECTION_TIMED_OUT") || msg.includes("ETIMEDOUT"))
    throw new SiteError("The site took too long to respond. Try again later.");
  if (msg.includes("ERR_SSL") || msg.includes("SSL_ERROR") || msg.includes("certificate"))
    throw new SiteError("There is an SSL/certificate problem with this site.");
  if (msg.includes("ERR_TOO_MANY_REDIRECTS"))
    throw new SiteError("The site has too many redirects and cannot be loaded.");
  if (msg.includes("ERR_ABORTED") || msg.includes("net::ERR"))
    throw new SiteError(`A network error occurred while loading the page: ${msg}`);
  // Not a site-specific error — caller handles it (timeout, etc.)
}

async function _runCheerioPipeline(url, urlObj, html, screenshotDesktop, screenshotMobile, loadTime) {
    // Parse with Cheerio
    const $ = cheerio.load(html);
    const textContent = $("body").text().replace(/\s+/g, " ").trim();
    const htmlSize = html.length;
    const textSize = textContent.length;
    const renderingPercentage = htmlSize > 0
      ? Math.round((textSize / htmlSize) * 100)
      : 0;

    // Analyze Meta Tags
    let title = $("title").first().text().trim() || "";
    
    // Clean up title - remove payment method keywords that sometimes get injected
    const paymentKeywords = [
      'Apple Pay', 'ApplePay', 'Google Pay', 'GooglePay', 
      'Klarna', 'Mastercard', 'MasterCard', 'Visa', 'PayPal',
      'American Express', 'Amex', 'Discover', 'Diners Club'
    ];
    
    // Remove payment keywords if they appear at the end of the title
    paymentKeywords.forEach(keyword => {
      const regex = new RegExp(`\\s*${keyword}\\s*$`, 'gi');
      title = title.replace(regex, '').trim();
    });
    
    // Remove multiple consecutive payment keywords concatenated together
    const concatenatedPattern = new RegExp(
      `\\s*[-|]?\\s*(${paymentKeywords.join('|')})\\s*`, 
      'gi'
    );
    const cleaned = title.replace(concatenatedPattern, ' ').replace(/\s+/g, ' ').trim();
    if (cleaned.length > 0 && cleaned.length < title.length * 0.8) {
      // Only use cleaned version if it removed a significant amount (likely payment methods)
      title = cleaned;
    }
    
    console.log(`[ANALYZER] Title Tag: "${title}" (Length: ${title.length})`);
    
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
    let imagesWithAlt = 0;
    const imagesList = [];
    const imagesWithAltList = [];
    const imagesWithoutAltList = [];
    
    // Count images with meaningful alt attributes (not empty or whitespace-only)
    images.each((i, img) => {
      const $img = $(img);
      const src = $img.attr("src") || '';
      const alt = $img.attr("alt");
      const hasAlt = alt !== undefined && alt !== null && alt.trim().length > 0;
      
      const imageData = {
        src: src,
        alt: alt || '',
        hasAlt: hasAlt
      };
      
      imagesList.push(imageData);
      
      if (hasAlt) {
        imagesWithAlt++;
        imagesWithAltList.push(imageData);
      } else {
        imagesWithoutAltList.push(imageData);
      }
    });
    
    const totalImages = images.length;

    const imagesData = {
      total: totalImages,
      withAlt: imagesWithAlt,
      withoutAlt: totalImages - imagesWithAlt,
      altPercentage:
        totalImages > 0 ? Math.round((imagesWithAlt / totalImages) * 100) : 100,
      all: imagesList,
      withAltList: imagesWithAltList,
      withoutAltList: imagesWithoutAltList
    };

    // Analyze Links
    const links = $("a[href]");
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
    const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

    const content = {
      wordCount: wordCount,
      textLength: bodyText.length,
    };

    // Technical SEO
    const isSSL = url.startsWith("https://");

    // Parallel fetch with hard timeouts — robots.txt and sitemap never hang
    const robotsTxtUrl = `${urlObj.protocol}//${urlObj.hostname}/robots.txt`;
    const sitemapUrl = `${urlObj.protocol}//${urlObj.hostname}/sitemap.xml`;
    const [robotsRes, sitemapRes] = await Promise.all([
      safeFetch(robotsTxtUrl, { method: "HEAD" }, 6000),
      safeFetch(sitemapUrl, { method: "HEAD" }, 6000),
    ]);
    const hasRobotsTxt = robotsRes ? robotsRes.ok : false;
    const hasSitemap = sitemapRes ? sitemapRes.ok : false;
    console.log(`[ANALYZER] robots.txt: ${hasRobotsTxt}, sitemap: ${hasSitemap}`);

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

    // Comprehensive set of all schema.org LocalBusiness types and subtypes
    const LOCAL_BUSINESS_TYPES = new Set([
      "LocalBusiness",
      // Food & Drink
      "FoodEstablishment", "Restaurant", "Bakery", "BarOrPub", "Brewery",
      "CafeOrCoffeeShop", "FastFoodRestaurant", "IceCreamShop", "Winery", "Distillery",
      // Retail Stores
      "Store", "AutoPartsStore", "BikeStore", "BookStore", "ClothingStore",
      "ComputerStore", "ConvenienceStore", "DepartmentStore", "ElectronicsStore",
      "Florist", "FurnitureStore", "GardenStore", "GroceryStore", "HardwareStore",
      "HobbyShop", "HomeGoodsStore", "JewelryStore", "LiquorStore", "MensClothingStore",
      "MobilePhoneStore", "MovieRentalStore", "MusicStore", "OfficeEquipmentStore",
      "OutletStore", "PawnShop", "PetStore", "ShoeStore", "SportingGoodsStore",
      "TireShop", "ToyStore", "WholesaleStore",
      // Automotive
      "AutomotiveBusiness", "AutoBodyShop", "AutoDealer", "AutoRental", "AutoRepair",
      "AutoWash", "GasStation", "MotorcycleDealer", "MotorcycleRepair",
      // Medical & Health
      "MedicalBusiness", "Dentist", "DiagnosticLab", "Hospital", "MedicalClinic",
      "Optician", "Pharmacy", "Physician", "VeterinaryCare",
      // Health & Beauty
      "HealthAndBeautyBusiness", "BeautySalon", "DaySpa", "HairSalon", "HealthClub",
      "NailSalon", "TattooParlor",
      // Home & Construction
      "HomeAndConstructionBusiness", "Electrician", "GeneralContractor", "HVACBusiness",
      "HousePainter", "Locksmith", "MovingCompany", "Plumber", "RoofingContractor",
      // Financial
      "FinancialService", "AccountingService", "AutomatedTeller", "BankOrCreditUnion",
      "InsuranceAgency",
      // Legal
      "LegalService", "Attorney", "Notary",
      // Lodging
      "LodgingBusiness", "BedAndBreakfast", "Campground", "Hostel", "Hotel",
      "Motel", "Resort", "VacationRental",
      // Entertainment
      "EntertainmentBusiness", "AmusementPark", "ArtGallery", "Casino",
      "ComedyClub", "MovieTheater", "NightClub", "AdultEntertainment",
      // Sports & Recreation
      "SportsActivityLocation", "BowlingAlley", "ExerciseGym", "GolfCourse",
      "PublicSwimmingPool", "SkiResort", "SportsClub", "StadiumOrArena", "TennisComplex",
      // Professional & Services
      "ProfessionalService", "EmploymentAgency", "RealEstateAgent", "TravelAgency",
      // Emergency & Government
      "EmergencyService", "FireStation", "PoliceStation", "GovernmentOffice", "PostOffice",
      // Other Local
      "AnimalShelter", "ChildCare", "DryCleaningOrLaundry", "InternetCafe", "Library",
      "RecyclingCenter", "SelfStorage", "ShoppingCenter", "TouristAttraction",
      "TouristInformationCenter", "RadioStation",
    ]);

    // Helper function to normalize a schema @type value (strips namespace prefixes)
    const normalizeSchemaType = (type) => {
      // Strip full URL namespaces like "https://schema.org/LocalBusiness" → "LocalBusiness"
      return type.replace(/^https?:\/\/schema\.org\//i, "").replace(/^schema:/i, "");
    };

    // Helper function to extract schema types recursively
    const extractSchemaTypes = (schema) => {
      if (!schema) return;
      
      // Handle @graph array
      if (schema["@graph"] && Array.isArray(schema["@graph"])) {
        schema["@graph"].forEach(item => extractSchemaTypes(item));
        // Don't return early — also process any @type on the root object
      }
      
      // Handle single schema or array of schemas
      if (schema["@type"]) {
        const types = Array.isArray(schema["@type"]) ? schema["@type"] : [schema["@type"]];
        
        types.forEach(rawType => {
          if (!rawType) return;
          const type = normalizeSchemaType(rawType);
          if (!schemaTypes.includes(type)) {
            schemaTypes.push(type);
          }
          
          // Check for identity schema
          if (type === "Organization" || type === "Person" || 
              type === "Corporation" || type === "LocalBusiness") {
            hasIdentitySchema = true;
            identityType = type;
          }
          
          // Check for local business schema using comprehensive type list
          if (LOCAL_BUSINESS_TYPES.has(type) || type.includes("LocalBusiness")) {
            hasLocalBusinessSchema = true;
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

    // Helper to decode HTML entities that may appear in JSON-LD script content
    const decodeHtmlEntities = (str) => {
      return str
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&#x27;/g, "'")
        .replace(/&#x2F;|&#47;/g, "/");
    };

    ldJsonScripts.each((_, el) => {
      const rawContent = $(el).html();
      if (!rawContent) return;
      // Try parsing as-is first; if that fails, try with decoded HTML entities
      let parsed = null;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        try {
          parsed = JSON.parse(decodeHtmlEntities(rawContent));
        } catch (error) {
          console.log('[ANALYZER] Invalid JSON-LD schema:', error.message);
        }
      }
      if (parsed) {
        // Handle root-level arrays
        if (Array.isArray(parsed)) {
          parsed.forEach(item => { if (item && typeof item === 'object') extractSchemaTypes(item); });
        } else {
          extractSchemaTypes(parsed);
        }
      }
    });
    
    // Also check for microdata and RDFa
    const hasMicrodata = $('[itemtype]').length > 0;
    const hasRDFa = $('[vocab], [typeof]').length > 0;
    const hasAnyStructuredData = schemaTypes.length > 0 || hasMicrodata || hasRDFa;
    const hasJsonLd = ldJsonScripts.length > 0 && schemaTypes.length > 0;

    const technicalSEO = {
      hasRobotsTxt,
      robotsTxtUrl: hasRobotsTxt ? robotsTxtUrl : undefined,
      hasSitemap,
      sitemapUrl: hasSitemap ? sitemapUrl : undefined,
      hasSSL: isSSL,
      isResponsive: viewport.length > 0,
      hasAnalytics,
      hasSchema: hasAnyStructuredData,
      hasJsonLd,
      schemaTypes,
      hasIdentitySchema,
      identityType: hasIdentitySchema ? identityType : undefined,
      hasLocalBusinessSchema,
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

    // Helper to apply a candidate URL to the right social variable
    const applySocialUrl = (href) => {
      if (!href || typeof href !== "string") return;
      if ((href.includes("facebook.com/") || href.includes("fb.com/") || href.includes("fb.me/")) && !facebookUrl) {
        facebookUrl = href;
      }
      if (href.includes("instagram.com/") && !instagramUrl) {
        instagramUrl = href;
      }
      if ((href.includes("twitter.com/") || href.includes("x.com/")) && !twitterUrl) {
        twitterUrl = href;
      }
      if (href.includes("linkedin.com/") && !linkedInUrl) {
        linkedInUrl = href;
      }
      if (href.includes("youtube.com/") && !youTubeUrl) {
        youTubeUrl = href;
      }
    };

    // Method 1: <a href> tags (primary)
    $("a[href]").each((_, el) => {
      applySocialUrl($(el).attr("href") || "");
    });

    // Method 2: og:url meta tag (Facebook-specific fallback)
    const ogFacebook = $('meta[property="og:url"]').attr("content") || "";
    if (ogFacebook.includes("facebook.com/") && !facebookUrl) {
      facebookUrl = ogFacebook;
    }

    // Method 3: JSON-LD sameAs property (many SEO-conscious sites use this)
    ldJsonScripts.each((_, el) => {
      const rawContent = $(el).html();
      if (!rawContent) return;
      let parsed = null;
      try {
        parsed = JSON.parse(rawContent);
      } catch {
        try {
          parsed = JSON.parse(decodeHtmlEntities(rawContent));
        } catch { return; }
      }
      if (!parsed) return;

      const extractSameAs = (schema) => {
        if (!schema || typeof schema !== "object") return;
        if (Array.isArray(schema)) { schema.forEach(extractSameAs); return; }
        const sameAs = schema.sameAs;
        if (sameAs) {
          const urls = Array.isArray(sameAs) ? sameAs : [sameAs];
          urls.forEach(u => { if (typeof u === "string") applySocialUrl(u); });
        }
        if (schema["@graph"] && Array.isArray(schema["@graph"])) {
          schema["@graph"].forEach(extractSameAs);
        }
        Object.values(schema).forEach(v => {
          if (v && typeof v === "object") extractSameAs(v);
        });
      };

      if (Array.isArray(parsed)) {
        parsed.forEach(extractSameAs);
      } else {
        extractSameAs(parsed);
      }
    });

    // Method 4: data-href attributes (Facebook Like/Share widgets)
    $("[data-href]").each((_, el) => {
      applySocialUrl($(el).attr("data-href") || "");
    });

    // Method 5: Raw HTML regex fallback — catches onclick handlers, JS vars, etc.
    if (!facebookUrl || !instagramUrl || !twitterUrl || !linkedInUrl || !youTubeUrl) {
      const rawHtml = $.html();
      const fallbackPatterns = [
        { key: "facebook",  regex: /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.com|fb\.me)\/(?!sharer|dialog\/share|plugins)[^\s"'<>\]\\)]+/i },
        { key: "instagram", regex: /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|explore\/)[^\s"'<>\]\\)]+/i },
        { key: "twitter",   regex: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent\/|share\?)[^\s"'<>\]\\)]+/i },
        { key: "linkedin",  regex: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^\s"'<>\]\\)]+/i },
        { key: "youtube",   regex: /https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|c\/|@)[^\s"'<>\]\\)]+/i },
      ];
      for (const { key, regex } of fallbackPatterns) {
        const alreadyFound =
          (key === "facebook"  && facebookUrl)  ||
          (key === "instagram" && instagramUrl) ||
          (key === "twitter"   && twitterUrl)   ||
          (key === "linkedin"  && linkedInUrl)  ||
          (key === "youtube"   && youTubeUrl);
        if (!alreadyFound) {
          const match = rawHtml.match(regex);
          if (match) applySocialUrl(match[0]);
        }
      }
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

    // Analyze Local SEO - Phone and Address Detection
    // Phone detection — ordered by confidence (highest first):
    //   1. Schema.org structured data
    //   2. tel: links (explicit, unambiguous)
    //   3. Contact/footer elements with phone-like patterns
    //   4. Full bodyText regex with strict word boundaries (last resort)

    // Strict phone regex with word boundaries to avoid matching partial numbers
    const phoneRegexStrict = /(?<!\d)(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}(?!\d)/g;
    const intlPhoneRegex = /(?<!\d)\+(?!1\b)\d{1,3}[-.\s]\d{2,5}[-.\s]\d{3,5}(?:[-.\s]\d{1,5})?(?!\d)/g;

    const extractPhoneFromText = (text) => {
      phoneRegexStrict.lastIndex = 0;
      intlPhoneRegex.lastIndex = 0;
      const m = phoneRegexStrict.exec(text) || intlPhoneRegex.exec(text);
      return m ? m[0].trim() : null;
    };

    let validPhone = null;

    // Reject obviously fake/placeholder phone numbers (sequential digits, all same digit, etc.)
    const isFakePhone = (num) => {
      const digits = num.replace(/\D/g, '');
      if (digits.length < 7) return true;
      // All same digit: 0000000, 1111111
      if (/^(\d)\1+$/.test(digits)) return true;
      // Sequential ascending (wrapping): 1234567890, 234567890, 0123456789, etc.
      let allAsc = true, allDesc = true;
      for (let i = 1; i < digits.length; i++) {
        if ((+digits[i] - +digits[i - 1] + 10) % 10 !== 1) allAsc = false;
        if ((+digits[i - 1] - +digits[i] + 10) % 10 !== 1) allDesc = false;
        if (!allAsc && !allDesc) break;
      }
      if (allAsc || allDesc) return true;
      return false;
    };

    // 1. tel: links — highest confidence: these are clickable and always reflect the real number
    const telLinks = [];
    $('a[href^="tel:"]').each((_, el) => {
      const displayText = $(el).text().trim();
      const hrefVal = ($(el).attr('href') || '').replace('tel:', '').trim();
      telLinks.push({ display: displayText, href: hrefVal });
      if (validPhone) return false;
      // Prefer visible display text (formatted); fall back to href value
      const candidate = displayText && /\d/.test(displayText) ? displayText : hrefVal;
      if (candidate && /\d{7,}/.test(candidate.replace(/\D/g, '')) && !isFakePhone(candidate)) {
        validPhone = candidate;
      }
    });
    console.log(`[PHONE-DEBUG] tel: links found (${telLinks.length}):`, JSON.stringify(telLinks));
    console.log(`[PHONE-DEBUG] After tel: links → validPhone=${validPhone}`);

    // 2. Schema.org structured data (checked after tel: links — schema may be outdated/placeholder)
    if (!validPhone && ldJsonScripts.length > 0) {
      ldJsonScripts.each((_, el) => {
        if (validPhone) return false;
        try {
          const schema = JSON.parse($(el).html());
          const findPhone = (obj) => {
            if (!obj || typeof obj !== 'object') return null;
            if (typeof obj.telephone === 'string' && obj.telephone.length > 6) return obj.telephone;
            for (const val of Object.values(obj)) {
              const found = findPhone(val);
              if (found) return found;
            }
            return null;
          };
          const p = findPhone(schema);
          if (p && !isFakePhone(p)) validPhone = p;
        } catch { /* skip */ }
      });
    }
    console.log(`[PHONE-DEBUG] After schema → validPhone=${validPhone}`);

    // 3. Contact / footer elements
    if (!validPhone) {
      const contactSelectors = [
        'footer', '[class*="contact"]', '#contact', '[class*="phone"]',
        '[class*="tel"]', '[itemprop="telephone"]', '[class*="footer"]',
      ];
      for (const sel of contactSelectors) {
        if (validPhone) break;
        $(sel).each((_, el) => {
          if (validPhone) return false;
          const elText = $(el).text().replace(/\s+/g, ' ');
          const found = extractPhoneFromText(elText);
          if (found && !isFakePhone(found)) { validPhone = found; console.log(`[PHONE-DEBUG] Found via contact selector "${sel}": ${found}`); }
        });
      }
    }
    console.log(`[PHONE-DEBUG] After contact selectors → validPhone=${validPhone}`);

    // 4. Full bodyText — strict patterns only to avoid false positives
    if (!validPhone) {
      const candidate = extractPhoneFromText(bodyText);
      if (candidate && !isFakePhone(candidate)) validPhone = candidate;
      console.log(`[PHONE-DEBUG] After bodyText scan → validPhone=${validPhone}`);
    }

    if (validPhone) {
      console.log(`[ANALYZER] Phone: "${validPhone}"`);
    } else {
      console.log(`[ANALYZER] Phone: Not found`);
    }

    const hasPhone = validPhone !== null;
    const phoneNumber = validPhone;

    // Address detection
    let hasAddress = false;
    let addressText = undefined;
    let addressSource = undefined;
    
    // First, try to extract from Schema.org structured data
    if (ldJsonScripts.length > 0) {
      ldJsonScripts.each((_, el) => {
        try {
          const jsonContent = $(el).html();
          if (jsonContent) {
            const schema = JSON.parse(jsonContent);
            const extractAddress = (obj) => {
              if (obj.address) {
                if (typeof obj.address === 'string' && obj.address.length > 15) {
                  return obj.address;
                } else if (obj.address.streetAddress) {
                  const addr = obj.address;
                  const parts = [
                    addr.streetAddress,
                    addr.addressLocality,
                    addr.addressRegion,
                    addr.postalCode
                  ].filter(Boolean);
                  return parts.join(', ');
                }
              }
              return null;
            };
            
            let addr = null;
            if (schema['@graph']) {
              for (const item of schema['@graph']) {
                addr = extractAddress(item);
                if (addr) break;
              }
            } else {
              addr = extractAddress(schema);
            }
            
            if (addr && addr.length > 15) {
              hasAddress = true;
              addressText = addr;
              addressSource = 'Schema.org';
              return false; // break the each loop
            }
          }
        } catch (e) {
          // Skip invalid JSON
        }
      });
    }
    
    // If no address in schema, try HTML pattern matching
    if (!hasAddress) {
      let addressCandidates = [];
      
      // Full street address (e.g. "123 Main Street, Albany, NY 12188")
      const usAddressRegex = /\b\d{1,5}\s+[A-Za-z][A-Za-z\s.]+?\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Circle|Cir|Way|Place|Pl|Plaza|Square|Trail|Parkway|Pkwy|Highway|Hwy)\b[,\s]*(?:[A-Za-z\s]+)?[,\s]*(?:[A-Z]{2})?\s*\d{5}?/gi;
      const usMatches = bodyText.match(usAddressRegex);
      console.log(`[ADDRESS-DEBUG] US street regex matches:`, usMatches);
      if (usMatches) {
        usMatches.forEach(m => addressCandidates.push({ text: m, source: 'US address pattern' }));
      }

      // City, State ZIP format (e.g. "Waterford, NY 12188" or "Albany, NY 12201-1234")
      // (?<![A-Za-z]) ensures we don't match a city name that is directly concatenated
      // with a preceding word (e.g. "PlansContactWaterford" from class name + text fusion)
      const cityStateZipRegex = /(?<![A-Za-z])[A-Za-z][A-Za-z\s]{1,30},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/g;
      const cityStateMatches = bodyText.match(cityStateZipRegex);
      console.log(`[ADDRESS-DEBUG] City/State/ZIP regex matches:`, cityStateMatches);
      if (cityStateMatches) {
        cityStateMatches.forEach(m => addressCandidates.push({ text: m.trim(), source: 'City/State/ZIP pattern' }));
      }
      
      // Look for PO Box addresses
      const poBoxRegex = /P\.?O\.?\s*Box\s+\d+[,\s]*[A-Za-z\s]*[,\s]*[A-Z]{2}\s*\d{5}/gi;
      const poBoxMatches = bodyText.match(poBoxRegex);
      if (poBoxMatches) {
        poBoxMatches.forEach(m => addressCandidates.push({ text: m, source: 'PO Box pattern' }));
      }
      
      // Check for address-related microdata or structured markup
      $('[itemprop*="address"], [itemtype*="PostalAddress"]').each((_, el) => {
        const addrText = $(el).text().trim().replace(/\s+/g, ' ');
        if (addrText.length > 15 && addrText.length < 200) {
          addressCandidates.push({ text: addrText, source: 'Microdata itemprop' });
        }
      });
      
      // Look for elements with address-related classes or IDs
      // Also check footer and semantic <address> elements — addresses are commonly placed there
      const addressSelectors = [
        'address',                          // HTML semantic <address> element
        'footer address',                   // <address> inside footer
        'footer [itemprop*="address"]',     // Microdata inside footer
        '.address', '#address', '[class*="address"]',
        '.location', '#location', '[class*="location"]',
        '.contact-info', '.contact-address',
        'footer [class*="contact"]',        // Contact blocks in footer
        'footer [class*="address"]',        // Address blocks in footer
        'footer [class*="location"]',       // Location blocks in footer
        '[class*="footer"] [class*="address"]',
        '[class*="footer"] [class*="contact"]'
      ];
      
      addressSelectors.forEach(selector => {
        $(selector).each((_, el) => {
          const addrText = $(el).text().trim().replace(/\s+/g, ' ');
          if (addrText.length > 10 && addrText.length < 300 && /\d/.test(addrText)) {
            addressCandidates.push({ text: addrText, source: `CSS selector: ${selector}` });
          }
        });
      });

      // Scan individual text nodes inside footer for address-like patterns
      // This catches addresses in plain <p> or <span> tags with no special classes
      if (addressCandidates.length === 0) {
        $('footer p, footer span, footer li, footer div').each((_, el) => {
          // Only look at leaf-like nodes to avoid capturing entire footer blocks
          const children = $(el).children().length;
          if (children > 3) return;
          const elText = $(el).text().trim().replace(/\s+/g, ' ');
          if (elText.length < 10 || elText.length > 250) return;
          usAddressRegex.lastIndex = 0;
          poBoxRegex.lastIndex = 0;
          if (usAddressRegex.test(elText) || poBoxRegex.test(elText)) {
            addressCandidates.push({ text: elText, source: 'footer element pattern match' });
          }
          // Also match generic number + word pattern typical of any address line
          if (/\d{1,5}\s+\w/.test(elText) && /,/.test(elText) && /\d/.test(elText)) {
            addressCandidates.push({ text: elText, source: 'footer generic address pattern' });
          }
        });
      }
      
      // Use the first address found
      console.log(`[ADDRESS-DEBUG] All candidates (${addressCandidates.length}):`, JSON.stringify(addressCandidates.slice(0, 10)));
      if (addressCandidates.length > 0) {
        hasAddress = true;
        // Strip leading label words (e.g. "Location", "Address", "Our Location") that
        // get pulled in when the scraped element contains a visible label alongside the value.
        addressText = addressCandidates[0].text.trim()
          .replace(/^(our\s+)?(location|address)\s*[:.\-–—]?\s*/i, '');
        addressSource = addressCandidates[0].source;
      }
    }
    
    // Always log the final address result
    if (hasAddress && addressText) {
      console.log(`[ANALYZER] Address: "${addressText}" (Source: ${addressSource})`);
    } else {
      // Log a snippet of bodyText around any digit to help diagnose why patterns failed
      const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 500);
      console.log(`[ANALYZER] Address: Not found. bodyText snippet (first 500 chars): ${snippet}`);
    }

    // Performance
    const performance = {
      loadTime: loadTime,
      pageSize: Math.round(html.length / 1024),
    };

    // ====================================================================
    // NEW COMPREHENSIVE 100-POINT SEO SCORING SYSTEM (STRICT)
    // ====================================================================
    
    let scoreBreakdown = {
      onPage: 0,
      technical: 0,
      local: 0,
      social: 0,
      details: []
    };

    // 🟦 ON-PAGE SEO — 45 POINTS (VERY STRICT SCORING)
    let onPagePoints = 0;
    
    // Title Tag — 12 pts (CRITICAL - must be perfect to get high score)
    if (metaTags.hasTitle) {
      if (metaTags.titleLength >= 50 && metaTags.titleLength <= 60) {
        onPagePoints += 12;
        scoreBreakdown.details.push("✓ Title Tag Perfect (optimal length 50-60): +12");
      } else if (metaTags.titleLength >= 30 && metaTags.titleLength <= 70) {
        onPagePoints += 4;
        scoreBreakdown.details.push(`✗ Title Tag Acceptable (${metaTags.titleLength} chars, optimal 50-60): +4`);
      } else {
        onPagePoints += 1;
        scoreBreakdown.details.push(`✗ Title Tag Poor (${metaTags.titleLength} chars, need 50-60): +1`);
      }
    } else {
      scoreBreakdown.details.push("✗ CRITICAL: Missing Title Tag: +0");
    }
    
    // Meta Description — 8 pts (must be perfect to get high score)
    if (metaTags.hasDescription) {
      if (metaTags.descriptionLength >= 120 && metaTags.descriptionLength <= 160) {
        onPagePoints += 8;
        scoreBreakdown.details.push("✓ Meta Description Perfect (optimal length 120-160): +8");
      } else if (metaTags.descriptionLength >= 50 && metaTags.descriptionLength <= 200) {
        onPagePoints += 2;
        scoreBreakdown.details.push(`✗ Meta Description Acceptable (${metaTags.descriptionLength} chars, optimal 120-160): +2`);
      } else {
        onPagePoints += 1;
        scoreBreakdown.details.push(`✗ Meta Description Poor (${metaTags.descriptionLength} chars, need 120-160): +1`);
      }
    } else {
      scoreBreakdown.details.push("✗ Missing Meta Description: +0");
    }
    
    // H1 Tag — 8 pts (must be perfect: exactly 1, good length)
    if (headings.h1Count === 1) {
      if (headings.h1Text.length > 0 && headings.h1Text[0].length >= 20) {
        onPagePoints += 8;
        scoreBreakdown.details.push("✓ Perfect H1 (exactly 1 with good length): +8");
      } else {
        onPagePoints += 1;
        scoreBreakdown.details.push("✗ H1 Too Short (needs 20+ characters): +1");
      }
    } else if (headings.h1Count > 1) {
      onPagePoints += 1;
      scoreBreakdown.details.push(`✗ Multiple H1 Tags (${headings.h1Count}, need exactly 1): +1`);
    } else {
      scoreBreakdown.details.push("✗ Missing H1 Tag: +0");
    }
    
    // H2–H6 Headings — 5 pts (need multiple levels)
    if (headings.h2Count >= 3 && (headings.h3Count >= 2 || headings.h4Count >= 1)) {
      onPagePoints += 5;
      scoreBreakdown.details.push("✓ Excellent Heading Hierarchy (3+ H2, 2+ H3): +5");
    } else if (headings.h2Count >= 2) {
      onPagePoints += 2;
      scoreBreakdown.details.push("✗ Basic Heading Structure (needs 3+ H2, 2+ H3): +2");
    } else {
      scoreBreakdown.details.push("✗ Poor Heading Structure (no proper hierarchy): +0");
    }
    
    // Image Alt Text — 4 pts (must be 100% to get good score)
    if (imagesData.total > 0) {
      if (imagesData.altPercentage === 100) {
        onPagePoints += 4;
        scoreBreakdown.details.push("✓ All Images Have Alt Text (100%): +4");
      } else if (imagesData.altPercentage >= 80) {
        onPagePoints += 2;
        scoreBreakdown.details.push(`✗ Most Images Have Alt (${imagesData.altPercentage.toFixed(0)}%, need 100%): +2`);
      } else if (imagesData.altPercentage >= 50) {
        onPagePoints += 1;
        scoreBreakdown.details.push(`✗ Only ${imagesData.altPercentage.toFixed(0)}% Images Have Alt (need 100%): +1`);
      } else {
        scoreBreakdown.details.push(`✗ Few Images Have Alt (${imagesData.altPercentage.toFixed(0)}%): +0`);
      }
    } else {
      onPagePoints += 2;
      scoreBreakdown.details.push("⚠ No Images Found: +2");
    }
    
    // Content Quality — 8 pts (need substantial content)
    if (content.wordCount >= 1000) {
      onPagePoints += 8;
      scoreBreakdown.details.push(`✓ Excellent Content Length (${content.wordCount} words): +8`);
    } else if (content.wordCount >= 500) {
      onPagePoints += 3;
      scoreBreakdown.details.push(`✗ Content Too Short (${content.wordCount} words, need 1000+): +3`);
    } else if (content.wordCount >= 300) {
      onPagePoints += 1;
      scoreBreakdown.details.push(`✗ Very Low Content (${content.wordCount} words, need 1000+): +1`);
    } else if (content.wordCount >= 50) {
      onPagePoints += 1;
      scoreBreakdown.details.push(`✗ Minimal Content (${content.wordCount} words): +1`);
    } else {
      scoreBreakdown.details.push(`✗ Almost No Content (${content.wordCount} words): +0`);
    }
    
    scoreBreakdown.onPage = onPagePoints;
    
    // 🟧 TECHNICAL SEO — 30 POINTS (Schema is now CRITICAL)
    let technicalPoints = 0;
    
    // SSL (HTTPS) — 5 pts
    if (technicalSEO.hasSSL) {
      technicalPoints += 5;
      scoreBreakdown.details.push("✓ HTTPS Enabled: +5");
    } else {
      scoreBreakdown.details.push("✗ No HTTPS: +0");
    }
    
    // robots.txt — 5 pts
    if (technicalSEO.hasRobotsTxt) {
      technicalPoints += 3;
      scoreBreakdown.details.push("✓ robots.txt Exists: +3");
      technicalPoints += 2;
      scoreBreakdown.details.push("✓ robots.txt Proper Rules: +2");
    } else {
      scoreBreakdown.details.push("✗ No robots.txt: +0");
    }
    
    // XML Sitemap — 5 pts
    if (technicalSEO.hasSitemap) {
      technicalPoints += 3;
      scoreBreakdown.details.push("✓ XML Sitemap Exists: +3");
      technicalPoints += 2;
      scoreBreakdown.details.push("✓ Sitemap Accessible: +2");
    } else {
      scoreBreakdown.details.push("✗ No XML Sitemap: +0");
    }
    
    // Analytics Installed — 3 pts
    if (technicalSEO.hasAnalytics) {
      technicalPoints += 3;
      scoreBreakdown.details.push("✓ Analytics Installed: +3");
    } else {
      scoreBreakdown.details.push("✗ No Analytics: +0");
    }
    
    // Schema (JSON-LD) — 12 pts (CRITICAL - MAJOR INCREASE)
    if (technicalSEO.hasSchema) {
      if (technicalSEO.hasJsonLd) {
        technicalPoints += 12;
        scoreBreakdown.details.push("✓ CRITICAL: Schema.org with Valid JSON-LD: +12");
      } else {
        technicalPoints += 4;
        scoreBreakdown.details.push("⚠ Schema Present but NOT JSON-LD (use JSON-LD): +4");
      }
    } else {
      scoreBreakdown.details.push("✗ CRITICAL: No Schema.org Structured Data: +0");
    }
    
    scoreBreakdown.technical = technicalPoints;
    
    // 🟨 LOCAL SEO — 15 POINTS (Local Business Schema is CRITICAL)
    let localPoints = 0;
    
    // Business Info (NAP) — 7 pts
    if (hasPhone) {
      localPoints += 3;
      scoreBreakdown.details.push("✓ Phone Number Found: +3");
    } else {
      scoreBreakdown.details.push("✗ No Phone Number: +0");
    }
    
    if (hasAddress) {
      localPoints += 4;
      scoreBreakdown.details.push("✓ Address Found: +4");
    } else {
      scoreBreakdown.details.push("✗ No Address: +0");
    }
    
    // Local Business Schema — 8 pts (CRITICAL - MAJOR INCREASE for local businesses)
    if (hasLocalBusinessSchema) {
      localPoints += 8;
      scoreBreakdown.details.push("✓ CRITICAL: Local Business Schema Present: +8");
    } else {
      scoreBreakdown.details.push("✗ CRITICAL: No Local Business Schema: +0");
    }
    
    scoreBreakdown.local = localPoints;
    
    // 🟥 SOCIAL SIGNALS — 10 POINTS
    let socialPoints = 0;
    
    // Social Links — 10 pts
    let socialLinksCount = 0;
    if (social.hasFacebookPage) socialLinksCount++;
    if (social.hasInstagram) socialLinksCount++;
    if (social.hasTwitter) socialLinksCount++;
    if (social.hasLinkedIn) socialLinksCount++;
    if (social.hasYouTube) socialLinksCount++;
    
    if (socialLinksCount >= 2) {
      socialPoints += 10;
      scoreBreakdown.details.push(`✓ Multiple Social Links (${socialLinksCount}): +10`);
    } else if (socialLinksCount === 1) {
      socialPoints += 5;
      scoreBreakdown.details.push("⚠ One Social Link: +5");
    } else {
      scoreBreakdown.details.push("✗ No Social Links: +0");
    }
    
    scoreBreakdown.social = socialPoints;
    
    // 🎯 FINAL SCORE CALCULATION
    const score = scoreBreakdown.onPage + scoreBreakdown.technical + scoreBreakdown.local + scoreBreakdown.social;
    
    console.log(`[ANALYZER] Score Breakdown:`);
    console.log(`  On-Page SEO: ${scoreBreakdown.onPage}/45`);
    console.log(`  Technical SEO: ${scoreBreakdown.technical}/30`);
    console.log(`  Local SEO: ${scoreBreakdown.local}/15`);
    console.log(`  Social Signals: ${scoreBreakdown.social}/10`);
    console.log(`  TOTAL: ${score}/100`);

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

    // Calculate On-Page SEO Score section (for compatibility)
    let onPageScore = Math.round((scoreBreakdown.onPage / 45) * 100);
    
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
      hasPhone,
      phoneNumber,
      hasAddress,
      addressText,
      localBusinessSchemaData: null,
    };

    // Generate Recommendations
    const recommendations = [];

    // HIGH PRIORITY - On-Page SEO
    if (!metaTags.hasTitle) {
      recommendations.push({
        title: "Add a Title Tag to your page",
        category: "On-Page SEO",
        priority: "High Priority",
      });
    } else if (metaTags.titleLength < 50 || metaTags.titleLength > 60) {
      if (metaTags.titleLength < 50) {
        recommendations.push({
          title: `Increase Title Tag length from ${metaTags.titleLength} to 50-60 characters`,
          category: "On-Page SEO",
          priority: "High Priority",
        });
      } else {
        recommendations.push({
          title: `Shorten Title Tag length from ${metaTags.titleLength} to 50-60 characters`,
          category: "On-Page SEO",
          priority: "High Priority",
        });
      }
    }

    if (!metaTags.hasDescription) {
      recommendations.push({
        title: "Add a Meta Description to your page",
        category: "On-Page SEO",
        priority: "High Priority",
      });
    } else if (metaTags.descriptionLength < 120 || metaTags.descriptionLength > 160) {
      if (metaTags.descriptionLength < 120) {
        recommendations.push({
          title: `Increase Meta Description length from ${metaTags.descriptionLength} to 120-160 characters`,
          category: "On-Page SEO",
          priority: "High Priority",
        });
      } else {
        recommendations.push({
          title: `Shorten Meta Description length from ${metaTags.descriptionLength} to 120-160 characters`,
          category: "On-Page SEO",
          priority: "High Priority",
        });
      }
    }

    if (headings.h1Count === 0) {
      recommendations.push({
        title: "Add exactly one H1 Header Tag to your page",
        category: "On-Page SEO",
        priority: "High Priority",
      });
    } else if (headings.h1Count > 1) {
      recommendations.push({
        title: `Reduce H1 tags from ${headings.h1Count} to exactly 1`,
        category: "On-Page SEO",
        priority: "High Priority",
      });
    }

    // MEDIUM PRIORITY - On-Page SEO
    if (headings.h2Count < 2) {
      recommendations.push({
        title: "Add more H2-H6 heading tags to improve content structure",
        category: "On-Page SEO",
        priority: "Medium Priority",
      });
    }

    if (imagesData.total > 0 && imagesData.altPercentage < 100) {
      recommendations.push({
        title: `Add Alt Attributes to ${imagesData.withoutAlt} images (${(100 - imagesData.altPercentage).toFixed(0)}% missing)`,
        category: "On-Page SEO",
        priority: "Medium Priority",
      });
    }

    if (content.wordCount < 300) {
      recommendations.push({
        title: `Increase content length from ${content.wordCount} to at least 300 words`,
        category: "On-Page SEO",
        priority: "Medium Priority",
      });
    }

    // TECHNICAL SEO
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

    if (!technicalSEO.hasAnalytics) {
      recommendations.push({
        title: "Implement an Analytics Tracking Tool",
        category: "Technical SEO",
        priority: "Low Priority",
      });
    }

    if (!technicalSEO.hasSchema) {
      recommendations.push({
        title: "Add Schema.org Structured Data",
        category: "Technical SEO",
        priority: "Medium Priority",
      });
    }

    if (!technicalSEO.hasIdentitySchema) {
      recommendations.push({
        title: "Add Identity Schema (Organization or Person)",
        category: "Technical SEO",
        priority: "Medium Priority",
      });
    }

    // LOCAL SEO
    if (!localSEO.hasPhone) {
      recommendations.push({
        title: "Add Phone Number to Website",
        category: "Local SEO",
        priority: "Medium Priority",
      });
    }

    if (!localSEO.hasAddress) {
      recommendations.push({
        title: "Add Address Information to Website",
        category: "Local SEO",
        priority: "Medium Priority",
      });
    }

    if (!localSEO.hasLocalBusinessSchema) {
      recommendations.push({
        title: "Add Local Business Schema",
        category: "Local SEO",
        priority: "Low Priority",
      });
    }

    // SOCIAL
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

    console.log(`[ANALYZER] Analysis complete: ${url} → Score ${score} (${grade})`);

    return {
      url,
      score,
      grade,
      scoreBreakdown,
      screenshot: screenshotDesktop
        ? (screenshotDesktop.startsWith('data:') ? screenshotDesktop : `data:image/png;base64,${screenshotDesktop}`)
        : "",
      screenshotMobile: screenshotMobile
        ? (screenshotMobile.startsWith('data:') ? screenshotMobile : `data:image/png;base64,${screenshotMobile}`)
        : "",
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
}

export async function analyzeSEO(url) {
  console.log(`[ANALYZER] Starting analysis for: ${url}`);
  
  // Ensure URL has protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
    console.log(`[ANALYZER] Added protocol: ${url}`);
  }

  // Fast-fail on obviously invalid URLs before launching a browser
  let urlObj;
  try {
    urlObj = new URL(url);
    if (!urlObj.hostname || urlObj.hostname.length < 3) throw new Error("Invalid hostname");
  } catch {
    throw new Error(`Invalid URL: "${url}". Please provide a valid web address.`);
  }

  let browser;
  try {
    console.log(`[ANALYZER] Launching Puppeteer browser...`);
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--single-process",
        "--no-zygote",
        "--memory-pressure-off",
      ],
      timeout: 30000,
    });
    console.log(`[ANALYZER] Browser launched successfully`);

    const page = await browser.newPage();

    // Block heavy resources we don't need for SEO analysis
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["media", "font", "websocket"].includes(type)) req.abort();
      else req.continue();
    });

    // Silence noisy page-side JS errors so they don't interrupt analysis
    page.on("console", () => {});
    page.on("pageerror", () => {});

    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    // Extra headers to reduce bot detection by aggressive WAFs/firewalls
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Upgrade-Insecure-Requests": "1",
    });

    const startTime = Date.now();

    // Navigate with one retry on timeout
    console.log(`[ANALYZER] Navigating to page: ${url}`);
    let pageHttpStatus = 200;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (response) pageHttpStatus = response.status();
        await page.waitForNetworkIdle({ timeout: 5000, idleTime: 500 }).catch(() => {});
        break;
      } catch (navErr) {
        classifyError(navErr); // throws SiteError if it's a site-specific failure
        if (attempt === 1) {
          console.log(`[ANALYZER] Navigation timeout on attempt 1, retrying...`);
          await new Promise((r) => setTimeout(r, 1500));
        } else {
          console.log(`[ANALYZER] Still slow on attempt 2 — proceeding with partial content.`);
        }
      }
    }
    const loadTime = Date.now() - startTime;
    console.log(`[ANALYZER] Page loaded in ${loadTime}ms (HTTP ${pageHttpStatus})`);

    // Screenshots (non-fatal) — skip if the site returned an error status (bot blocking, etc.)
    let screenshotDesktop = "";
    let screenshotMobile = "";
    if (pageHttpStatus >= 200 && pageHttpStatus < 400) {
      try {
        screenshotDesktop = await page.screenshot({ encoding: "base64", fullPage: false });
        await page.setViewport({ width: 360, height: 640 });
        screenshotMobile = await page.screenshot({ encoding: "base64", fullPage: false });
        console.log(`[ANALYZER] Screenshots captured`);
      } catch (ssErr) {
        console.warn(`[ANALYZER] Screenshot failed (non-fatal): ${ssErr.message}`);
      }
    } else {
      console.warn(`[ANALYZER] Skipping screenshots — site returned HTTP ${pageHttpStatus}`);
    }

    // Get HTML content
    let html = "";
    try {
      html = await page.content();
    } catch (htmlErr) {
      console.warn(`[ANALYZER] Failed to get page content: ${htmlErr.message}`);
    }

    // Close browser as soon as we have what we need
    await browser.close();
    browser = null;
    console.log(`[ANALYZER] Browser closed`);


    return await _runCheerioPipeline(url, urlObj, html, screenshotDesktop, screenshotMobile, loadTime);
  } catch (error) {
    console.error(`[ANALYZER] ERROR analyzing SEO for ${url}:`, error.message);
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
        console.log(`[ANALYZER] Browser closed in finally block`);
      } catch (closeErr) {
        console.error(`[ANALYZER] Error closing browser:`, closeErr.message);
      }
    }
  }
}

// Analyze SEO from pre-fetched HTML (e.g. via scrape.do)
export async function analyzeSEOFromHTML(url, html, screenshotDesktop = "", screenshotMobile = "") {
  console.log(`[ANALYZER] Starting HTML-based analysis for: ${url}`);

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }

  let urlObj;
  try {
    urlObj = new URL(url);
    if (!urlObj.hostname || urlObj.hostname.length < 3) throw new Error("Invalid hostname");
  } catch {
    throw new Error(`Invalid URL: "${url}". Please provide a valid web address.`);
  }

  return await _runCheerioPipeline(url, urlObj, html, screenshotDesktop, screenshotMobile, 0);
}
