// src/scraper/scrapeProduct.js
// ─────────────────────────────────────────────────────────────
// Single product scraper — the shared core used by:
//   1. src/scraper/index.js      (full category run, loops over this)
//   2. src/api_server.js         (manual refresh button, calls this once)
//
// Responsibility: given a store config + product URL,
// fetch the page and return parsed product data.
// Does NOT touch the DB — that's the caller's job.
// ─────────────────────────────────────────────────────────────

const { fetchPage }    = require('./fetchPage');
const { appendProduct, rebuildPriceFile } = require('./fileHelpers');

/**
 * Scrapes a single product page and returns the parsed product object.
 * Returns null if fetch or parse fails.
 *
 * @param {object} store       - Store config from urls.js { name, parser, ... }
 * @param {string} productUrl  - Full URL of the product page
 * @returns {Promise<object|null>}
 */
async function scrapeProduct(store, productUrl) {
  const { parser } = store;

  try {
    const html    = await fetchPage(productUrl);
    const product = parser.parseProductDetails(html, productUrl);

    if (product) {
      product.scrapedVia = 'web_unlocker';
      product.scrapedAt  = new Date().toISOString();
    }

    return product || null;

  } catch (err) {
    console.error(`  ❌ scrapeProduct failed [${productUrl}]: ${err.message}`);
    return null;
  }
}

/**
 * Scrapes a single product AND saves it to the output files.
 * Used by the category orchestrator (index.js) during full runs.
 * The manual API refresh does NOT call this — it calls scrapeProduct()
 * directly and handles its own DB update path.
 *
 * @param {object} store
 * @param {string} productUrl
 * @param {string} fullOutputPath   - Path to products_full.json
 * @param {string} priceOutputPath  - Path to products_prices.json
 * @returns {Promise<object|null>}
 */
async function scrapeAndSave(store, productUrl, fullOutputPath, priceOutputPath) {
  const product = await scrapeProduct(store, productUrl);

  if (product?.name) {
    appendProduct(fullOutputPath, product);
    rebuildPriceFile(fullOutputPath, priceOutputPath);
  }

  return product;
}

module.exports = { scrapeProduct, scrapeAndSave };