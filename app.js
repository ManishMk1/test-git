// // generateAmazonUrls.js
// // Usage: node generateAmazonUrls.js inputFile [outputFile]
// // Example: node generateAmazonUrls.js asins.txt amazon_urls.txt

// const fs = require('fs');
// const path = require('path');

// const inputFile = process.argv[2] || 'asins.txt';
// const outputFile = process.argv[3] || 'amazon_urls.txt';

// function isValidAsin(asin) {
//   return /^[A-Za-z0-9]{10}$/.test(asin.trim());
// }

// async function main() {
//   try {
//     const data = await fs.promises.readFile(path.resolve(inputFile), 'utf8');
//     const asins = data
//       .split(/\r?\n/)
//       .map(a => a.trim())
//       .filter(a => a.length > 0 && isValidAsin(a));

//     if (asins.length === 0) {
//       console.log('No valid ASINs found in file.');
//       return;
//     }

//     // Generate URLs
//     const urls = asins.flatMap(asin => [
//       `https://www.amazon.in/dp/${asin}`,
//       `https://www.amazon.co.uk/dp/${asin}`
//     ]);

//     // Write URLs to output file
//     await fs.promises.writeFile(path.resolve(outputFile), urls.join('\n'), 'utf8');
//     console.log(`✅ URLs written to ${outputFile} (${urls.length} total)`);
//   } catch (err) {
//     console.error('Error:', err.message);
//   }
// }

// main();

// index.js
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer-extra'); // using puppeteer-extra for stealth if available
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const pLimit = require('p-limit').default;
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

puppeteer.use(StealthPlugin());

const INPUT_FILE = 'asins.txt';
const OUTPUT_JSON = 'results.json';
const OUTPUT_CSV = 'results.csv';

// change if you want another amazon domain (amazon.in, amazon.co.uk, amazon.com)
const AMAZON_DOMAIN = 'amazon.in';

const concurrency = 3; // number of pages at once
const timeout = 30_000;

function amazonUrlFromAsin(asin) {
  return `https://${AMAZON_DOMAIN}/dp/${asin}`;
}

// helper: random delay
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// fallback helpers for multiple selectors
async function getText(page, selectors) {
  for (const s of selectors) {
    try {
      const el = await page.$(s);
      if (el) {
        const txt = (await page.evaluate(e => e.textContent, el)) || '';
        const cleaned = txt.trim().replace(/\s+/g, ' ');
        if (cleaned) return cleaned;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

async function getAttr(page, selector, attr) {
  try {
    const el = await page.$(selector);
    if (!el) return null;
    return await page.evaluate((e, a) => e.getAttribute(a), el, attr);
  } catch (e) {
    return null;
  }
}

async function scrapeAsin(page, asin) {
  const url = amazonUrlFromAsin(asin);
  try {
    await page.setUserAgent(randomUserAgent());
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // small random wait so behavior isn't mechanical
    await delay(500 + Math.floor(Math.random() * 1500));

    // Accept cookies dialog (common on EU/UK) — try click if present
    try {
      const acceptBtn = await page.$x("//input[@name='accept' or contains(@id,'accept') or contains(@value,'Accept')]");
      if (acceptBtn.length) {
        await acceptBtn[0].click();
        await page.waitForTimeout(500);
      }
    } catch (e) { /* ignore */ }

    // Title
    const title = await getText(page, [
      '#productTitle',
      '#titleSection #title',
      '#ebooksProductTitle',
      "h1.a-size-large.a-spacing-none"
    ]);

    // Price — many possible selectors
    const price = await getText(page, [
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      'span.a-size-medium.a-color-price.offer-price.a-text-normal',
      'span.a-price > span.a-offscreen',
      '#corePriceDisplay_desktop_feature_div .a-offscreen'
    ]);

    // Rating (stars)
    const rating = await getText(page, [
      'span#acrPopover',
      'span[data-hook="rating-out-of-text"]',
      'i.a-icon-star span'
    ]);

    // Reviews count
    const reviewsCount = await getText(page, [
      '#acrCustomerReviewText',
      'span[data-hook="total-review-count"]',
      '#reviewsMedley .a-size-base'
    ]);

    // Image
    let image = await getAttr(page, '#landingImage', 'src');
    if (!image) {
      image = await getAttr(page, '#imgTagWrapperId img', 'src') ||
              await getAttr(page, '#imgTagWrapperId img', 'data-old-hires');
    }

    // Availability / stock
    const availability = await getText(page, [
      '#availability .a-color-state',
      '#availability .a-color-success',
      '#availability'
    ]);

    // Best Sellers Rank (BSR) — tricky: inside Product details or "Best Sellers Rank"
    let bsr = null;
    try {
      // scroll into view to ensure the details are loaded
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      bsr = await getText(page, [
        '#detailBulletsWrapper_feature_div li:has(span:contains("Best Sellers Rank"))', // not supported CSS in browsers but left for concept
        '#detailBullets_feature_div',
        '#productDetails_detailBullets_sections1',
        '#prodDetails'
      ]);

      if (bsr) {
        // try to extract "Best Sellers Rank" from returned text
        const m = bsr.match(/Best Sellers Rank[:\s]*([\s\S]+)/i);
        if (m) bsr = m[1].trim();
      } else {
        // try another approach: search the page text
        const txt = await page.evaluate(() => document.body.innerText);
        const m2 = txt.match(/Best Sellers Rank[:\s]*([\s\S]{0,200})/i);
        if (m2) bsr = m2[1].split('\n')[0].trim();
      }
    } catch (e) {
      bsr = null;
    }

    return {
      asin,
      url,
      title,
      price,
      rating,
      reviewsCount,
      image,
      availability,
      bsr,
      scrapedAt: new Date().toISOString(),
      error: null
    };
  } catch (err) {
    return {
      asin, url, title: null, price: null, rating: null, reviewsCount: null,
      image: null, availability: null, bsr: null, scrapedAt: new Date().toISOString(),
      error: err.message
    };
  }
}

function randomUserAgent() {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

async function readAsins() {
  const txt = await fs.readFile(INPUT_FILE, 'utf8');
  return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

async function main() {
  const asins = await readAsins();
  console.log(`Found ${asins.length} ASIN(s). Starting scraping with concurrency=${concurrency}`);

  const browser = await puppeteer.launch({
    headless: true, // set to false to see browser
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ]
  });

  // concurrency control
  const limit = pLimit(concurrency);
  const results = [];

  const tasks = asins.map(asin => limit(async () => {
    const page = await browser.newPage();
    // set viewport & UA
    await page.setViewport({ width: 1200, height: 800 });
    try {
      // try up to 2 times if it fails
      for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await scrapeAsin(page, asin);
        if (!r.error) {
          results.push(r);
          console.log(`OK  ${asin} -> ${r.title ? r.title.slice(0,60) : 'NO TITLE'}`);
          break;
        } else {
          console.warn(`Attempt ${attempt} failed for ${asin}: ${r.error}`);
          if (attempt === 2) {
            results.push(r);
          } else {
            await delay(1500 + Math.random() * 2000);
          }
        }
      }
    } finally {
      await page.close();
      // small delay between closing and next create to look less bot-like
      await delay(300 + Math.floor(Math.random() * 400));
    }
  }));

  await Promise.all(tasks);

  await browser.close();

  // save json
  await fs.writeFile(OUTPUT_JSON, JSON.stringify(results, null, 2), 'utf8');

  // save csv
  const csvWriter = createCsvWriter({
    path: OUTPUT_CSV,
    header: [
      {id: 'asin', title: 'ASIN'},
      {id: 'title', title: 'Title'},
      {id: 'price', title: 'Price'},
      {id: 'rating', title: 'Rating'},
      {id: 'reviewsCount', title: 'Reviews'},
      {id: 'image', title: 'Image'},
      {id: 'availability', title: 'Availability'},
      {id: 'bsr', title: 'BSR'},
      {id: 'url', title: 'URL'},
      {id: 'error', title: 'Error'}
    ]
  });
  await csvWriter.writeRecords(results);
  console.log(`Saved ${results.length} results to ${OUTPUT_JSON} and ${OUTPUT_CSV}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
