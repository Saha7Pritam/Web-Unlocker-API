// src/scraper/fileHelpers.js
// All file system helpers for the scraper.
// Centralised here so scrapeProduct, index, and scheduler
// all read/write output files the same way.

const fs   = require('fs');
const path = require('path');

/**
 * Creates a directory (and all parents) if it doesn't exist.
 */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Reads a JSON file. Returns fallback if file doesn't exist or is corrupt.
 */
function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

/**
 * Writes data as pretty-printed JSON to filePath.
 */
function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Returns all output file paths for a given store + category slug.
 * This is the single source of truth for the output folder structure.
 *
 * output/
 *   <storeName>/
 *     <categorySlug>/
 *       collected_urls.json   ← all product URLs found during listing crawl
 *       visited.json          ← URLs already scraped (resume support)
 *       products_full.json    ← full scraped data for every product
 *       products_prices.json  ← lightweight price-only extract
 */
function getPaths(storeName, categorySlug) {
  const dir = path.join('output', storeName, categorySlug);
  return {
    dir,
    urlsCache   : path.join(dir, 'collected_urls.json'),
    visitedCache: path.join(dir, 'visited.json'),
    fullOutput  : path.join(dir, 'products_full.json'),
    priceOutput : path.join(dir, 'products_prices.json'),
  };
}

/**
 * Appends a single product object to products_full.json.
 * Used during scraping so each product is saved immediately —
 * crash-safe, no data loss on interruption.
 */
function appendProduct(fullOutputPath, product) {
  const existing = readJson(fullOutputPath, []);
  existing.push(product);
  writeJson(fullOutputPath, existing);
}

/**
 * Rebuilds products_prices.json from products_full.json.
 * Called after every appendProduct so the price file stays in sync.
 * Price file is a lightweight extract — only fields needed for SQL mapping.
 */
function rebuildPriceFile(fullOutputPath, priceOutputPath) {
  const all = readJson(fullOutputPath, []);
  const prices = all.map(p => ({
    store         : p.store,
    sku           : p.sku,
    model         : p.model,
    modelNumber   : p.modelNumber,
    productCode   : p.productCode,
    name          : p.name,
    category      : p.category,
    salePrice     : p.salePrice,
    originalPrice : p.originalPrice,
    stockStatus   : p.stockStatus,
    discountBadge : p.discountBadge,
    partId        : p.partId,
    partId2       : p.partId2,
    lowestPrice   : p.lowestPrice,
    retailerPrices: p.retailerPrices,
    tags          : p.tags,
    url           : p.url,
    scrapedAt     : p.scrapedAt,
    scrapedVia    : p.scrapedVia,
  }));
  writeJson(priceOutputPath, prices);
}

module.exports = {
  ensureDir,
  readJson,
  writeJson,
  getPaths,
  appendProduct,
  rebuildPriceFile,
};

































// // src/scraper/fileHelpers.js
// // All file system helpers for the scraper.
// // Centralised here so scrapeProduct, index, and scheduler
// // all read/write output files the same way.

// const fs   = require('fs');
// const path = require('path');

// /**
//  * Creates a directory (and all parents) if it doesn't exist.
//  */
// function ensureDir(dir) {
//   if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
// }

// /**
//  * Reads a JSON file. Returns fallback if file doesn't exist or is corrupt.
//  */
// function readJson(filePath, fallback) {
//   if (!fs.existsSync(filePath)) return fallback;
//   try {
//     return JSON.parse(fs.readFileSync(filePath, 'utf8'));
//   } catch (_) {
//     return fallback;
//   }
// }

// /**
//  * Writes data as pretty-printed JSON to filePath.
//  */
// function writeJson(filePath, data) {
//   fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
// }

// /**
//  * Returns all output file paths for a given store + category slug.
//  * This is the single source of truth for the output folder structure.
//  *
//  * output/
//  *   <storeName>/
//  *     <categorySlug>/
//  *       collected_urls.json   ← all product URLs found during listing crawl
//  *       visited.json          ← URLs already scraped (resume support)
//  *       products_full.json    ← full scraped data for every product
//  *       products_prices.json  ← lightweight price-only extract
//  */
// function getPaths(storeName, categorySlug) {
//   const dir = path.join('output', storeName, categorySlug);
//   return {
//     dir,
//     urlsCache   : path.join(dir, 'collected_urls.json'),
//     visitedCache: path.join(dir, 'visited.json'),
//     fullOutput  : path.join(dir, 'products_full.json'),
//     priceOutput : path.join(dir, 'products_prices.json'),
//   };
// }

// /**
//  * Appends a single product object to products_full.json.
//  * Used during scraping so each product is saved immediately —
//  * crash-safe, no data loss on interruption.
//  */
// function appendProduct(fullOutputPath, product) {
//   const existing = readJson(fullOutputPath, []);
//   existing.push(product);
//   writeJson(fullOutputPath, existing);
// }

// /**
//  * Rebuilds products_prices.json from products_full.json.
//  * Called after every appendProduct so the price file stays in sync.
//  * Price file is a lightweight extract — only fields needed for SQL mapping.
//  */
// function rebuildPriceFile(fullOutputPath, priceOutputPath) {
//   const all = readJson(fullOutputPath, []);
//   const prices = all.map(p => ({
//     store         : p.store,
//     sku           : p.sku,
//     model         : p.model,
//     modelNumber   : p.modelNumber,
//     productCode   : p.productCode,
//     name          : p.name,
//     category      : p.category,
//     salePrice     : p.salePrice,
//     originalPrice : p.originalPrice,
//     stockStatus   : p.stockStatus,
//     discountBadge : p.discountBadge,
//     partId        : p.partId,
//     partId2       : p.partId2,
//     lowestPrice   : p.lowestPrice,
//     retailerPrices: p.retailerPrices,
//     tags          : p.tags,
//     url           : p.url,
//     scrapedAt     : p.scrapedAt,
//     scrapedVia    : p.scrapedVia,
//   }));
//   writeJson(priceOutputPath, prices);
// }

// module.exports = {
//   ensureDir,
//   readJson,
//   writeJson,
//   getPaths,
//   appendProduct,
//   rebuildPriceFile,
// };
