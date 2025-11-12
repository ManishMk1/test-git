import fs from 'fs/promises';
import path from 'path';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import pLimit from 'p-limit';
import pkg from 'csv-writer';
puppeteer.use(StealthPlugin());

const INPUT_FILE = 'asins.txt';
const OUTPUT_JSON = 'results.json';
const OUTPUT_CSV = 'results.csv';

// change if you want another amazon domain (amazon.in, amazon.co.uk, amazon.com)
const AMAZON_DOMAIN = 'amazon.in';

const concurrency = 8; // number of pages at once
const timeout = 30_000;

function amazonUrlFromAsin(asin) {
  return `https://${AMAZON_DOMAIN}/dp/${asin}`;
}

// helper: random delay
function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function cleanUnicode(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/[\u200E\u200F\u202A-\u202E]/g, '').trim();
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
    let price = null;
    try {
      // This selector is more reliable for the main price part
      const priceWhole = await getText(page, ['.a-price-whole']);
      if (priceWhole) {
        const priceSymbol = await getText(page, ['.a-price-symbol']);
        price = `${priceSymbol || ''}${priceWhole}`;
      } else {
        // Fallback to older selectors if the main one fails
        price = await getText(page, [
          '#priceblock_ourprice',
          '#priceblock_dealprice',
          '#corePriceDisplay_desktop_feature_div .a-offscreen'
        ]);
      }
    } catch (e) { /* ignore */ }
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

    // "About this item" bullet points
 // "About this item" bullet points
let aboutItem = null;
try {
  // Try both feature-bullets and generic unordered list patterns
  await page.waitForSelector('ul.a-unordered-list.a-vertical.a-spacing-small, #feature-bullets', { timeout: 3000 });

  // Collect all possible bullet list items from both selectors
  const bulletItems = await page.$$('ul.a-unordered-list.a-vertical.a-spacing-small li, #feature-bullets .a-list-item');
  if (bulletItems.length > 0) {
    const texts = await Promise.all(
      bulletItems.map(el => el.evaluate(node => node.textContent.trim().replace(/\s+/g, ' ')))
    );
    // Filter out empty lines
    aboutItem = texts.filter(text => text.length > 0);
  }
} catch (e) {
  /* ignore */
}

    // "Product Description" paragraph
    let productDescription = null;
    try {
      await page.waitForSelector('#productDescription', { timeout: 3000 });
      productDescription = await getText(page, ['#productDescription']);
    } catch (e) { /* ignore */ }

    // Availability / stock
    const availability = await getText(page, [
      '#availability .a-color-state',
      '#availability .a-color-success',
      '#availability'
    ]);
    
    // Product Details and Best Sellers Rank (BSR)
    let productDetails = {};
    let bsr = null; 
    try {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight)); // Scroll to load details
        await delay(200); // wait for content to potentially load

        const details = await page.evaluate(() => {
            const data = {};
            const cleanText = (str) => str.replace(/:/g, '').replace(/\s\s+/g, ' ').trim();

            // First, try the modern "detailBullets" format
            const detailLines = Array.from(document.querySelectorAll('#detailBullets_feature_div li'));
            if (detailLines.length) {
                detailLines.forEach(li => {
                    const keyEl = li.querySelector('span.a-text-bold');
                    if (keyEl) {
                        const key = cleanText(keyEl.textContent);
                        // The value is in the span that follows the key's span
                        const valueEl = keyEl.parentElement.querySelector('span:not(.a-text-bold)');
                        if (valueEl) {
                            data[key] = cleanText(valueEl.textContent);
                        } else {
                            // Fallback if structure is different
                            data[key] = cleanText(li.textContent.replace(keyEl.textContent, ''));
                        }
                    }
                });
                return data;
            }

            // Fallback for older table-based layouts
            const tableRows = Array.from(document.querySelectorAll('#productDetails_detailBullets_sections1 tr, #prodDetails tr'));
            if (tableRows.length) {
                tableRows.forEach(row => {
                   const th = row.querySelector('th');
                   const td = row.querySelector('td');
                   if (th && td) {
                       data[cleanText(th.innerText)] = cleanText(td.innerText);
                   }
               });
               return data;
            }

            return data;
        });
        productDetails = cleanUnicode(details);
        // Extract BSR from the collected details
        const bsrKey = Object.keys(productDetails).find(k => k.toLowerCase().includes('best sellers rank'));
        if (bsrKey) {
            // Clean up the BSR string
            bsr = productDetails[bsrKey].split('(')[0].trim();
        }
    } catch (e) { /* ignore */ }

    return {
      asin,
      url,
      title,
      price,
      rating,
      reviewsCount,
      image,
      aboutItem,
      productDescription,
      availability,
      bsr,
      productDetails,
      scrapedAt: new Date().toISOString(),
      error: null
    };
  } catch (err) {
    return {
      asin, url, title: null, price: null, rating: null, reviewsCount: null,
      image: null, aboutItem: null, productDescription: null, availability: null, bsr: null, productDetails: null,
      scrapedAt: new Date().toISOString(),
      error: err.message
    }
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
  headless: true,
  args: [
    '--no-sandbox', // Necessary for many environments
    '--disable-setuid-sandbox', // Increases compatibility
    '--disable-dev-shm-usage' // Prevents memory-related crashes in Docker/CI
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
  await fs.writeFile(OUTPUT_JSON, JSON.stringify(results, null, 2));

  // save csv
  const csvWriter = pkg.createObjectCsvWriter({
    path: OUTPUT_CSV,
    header: [
      {id: 'asin', title: 'ASIN'},
      {id: 'title', title: 'Title'},
      {id: 'price', title: 'Price'},
      {id: 'rating', title: 'Rating'},
      {id: 'reviewsCount', title: 'Reviews'},
      {id: 'aboutItem', title: 'About Item'},
      {id: 'productDescription', title: 'Product Description'},
      {id: 'image', title: 'Image'},
      {id: 'availability', title: 'Availability'},
      {id: 'bsr', title: 'BSR'},
      {id: 'url', title: 'URL'},
      {id: 'productDetails', title: 'Product Details'},
      {id: 'error', title: 'Error'}
    ]
  });
  // Convert array fields to strings for CSV
  const records = results.map(r => ({
    ...r,
    aboutItem: r.aboutItem ? r.aboutItem.join(' | ') : ''
  }));
  await csvWriter.writeRecords(records);
  console.log(`Saved ${results.length} results to ${OUTPUT_JSON} and ${OUTPUT_CSV}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
