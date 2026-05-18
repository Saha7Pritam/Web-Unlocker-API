// src/scraper/index.js
// ─────────────────────────────────────────────────────────────
// Full category orchestrator — refactored from src/scraper.js
//
// Run manually:  node src/scraper/index.js
// Called by:     src/scheduler/index.js (automatic, per-category)
//
// Flow per category:
//   1. Paginate through listing pages → collect all product URLs
//   2. For each URL not yet visited → scrapeAndSave()
//   3. Resume support via collected_urls.json + visited.json
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const { fetchPage }                        = require('./fetchPage');
const { ensureDir, readJson, writeJson, getPaths } = require('./fileHelpers');
const { scrapeAndSave }                    = require('./scrapeProduct');
const { STORES }                           = require('../urls');

// ─────────────────────────────────────────────────────────────
//  URL COLLECTION
//  Paginates through all listing pages for a category.
//  Caches result to collected_urls.json — so if interrupted,
//  re-running skips URL collection and goes straight to scraping.
// ─────────────────────────────────────────────────────────────

async function collectUrlsForCategory(store, startUrl, urlsCachePath) {
  // Resume from cache if URL collection was already completed
  const saved = readJson(urlsCachePath, null);
  if (saved) {
    console.log(`  ♻️  Loaded ${saved.length} cached URLs`);
    return new Set(saved);
  }

  const { parser } = store;
  const productUrls        = new Set();
  const visitedListingUrls = new Set(); // infinite loop guard
  let currentUrl = startUrl;
  let pageNum    = 1;

  while (currentUrl) {
    // Infinite pagination loop guard
    if (visitedListingUrls.has(currentUrl)) {
      console.log(`  ⚠️  Pagination loop detected at ${currentUrl} — stopping`);
      break;
    }
    visitedListingUrls.add(currentUrl);

    console.log(`  📄 Page ${pageNum}: ${currentUrl}`);

    try {
      const html  = await fetchPage(currentUrl);
      const links = parser.parseProductLinks(html);
      console.log(`     ↳ ${links.length} links found`);
      links.forEach(l => productUrls.add(l));

      currentUrl = parser.getNextPageUrl(html, currentUrl);
      pageNum++;

    } catch (err) {
      console.error(`  ❌ Listing page error: ${err.message}`);
      break;
    }

    // Polite delay between listing pages
    await new Promise(r => setTimeout(r, 1500));
  }

  writeJson(urlsCachePath, [...productUrls]);
  console.log(`  💾 Saved ${productUrls.size} URLs to cache`);
  return productUrls;
}

// ─────────────────────────────────────────────────────────────
//  CATEGORY RUNNER
//  Exported so scheduler can call it for individual categories.
// ─────────────────────────────────────────────────────────────

/**
 * Scrapes all products for a single store + category.
 * Fully resumable — skips already-visited URLs.
 *
 * @param {object} store     - Store config from urls.js
 * @param {object} category  - { slug, url } from store.categories
 * @returns {Promise<{ done: number, saved: number, failed: number }>}
 */
async function scrapeCategory(store, category) {
  const { name: storeName } = store;
  const { slug, url: startUrl } = category;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🏪 Store: ${storeName}  📂 Category: ${slug}`);
  console.log(`${'─'.repeat(60)}`);

  const paths = getPaths(storeName, slug);
  ensureDir(paths.dir);

  // Step 1: Collect all product URLs
  const productUrls = await collectUrlsForCategory(store, startUrl, paths.urlsCache);
  console.log(`  ✅ ${productUrls.size} product URLs total`);

  // Step 2: Load visited cache for resume support
  const visited = new Set(readJson(paths.visitedCache, []));
  const total   = productUrls.size;
  let done      = visited.size;
  let saved     = 0;
  let failed    = 0;

  if (visited.size > 0) {
    console.log(`  ♻️  Resuming: ${visited.size} already done, ${total - visited.size} remaining`);
  }

  // Step 3: Scrape each unvisited product
  for (const productUrl of productUrls) {
    if (visited.has(productUrl)) continue;
    done++;

    process.stdout.write(`  🛒 [${done}/${total}] `);

    const product = await scrapeAndSave(store, productUrl, paths.fullOutput, paths.priceOutput);

    if (product?.name) {
      console.log(`✅ ${product.name.substring(0, 55)}`);
      saved++;
    } else {
      console.log(`⚠️  No data — ${productUrl}`);
      failed++;
    }

    // Always mark visited even on failure — don't retry endlessly
    visited.add(productUrl);
    writeJson(paths.visitedCache, [...visited]);

    // Polite delay between product requests
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n  🏁 ${storeName}/${slug} complete`);
  console.log(`     Saved : ${saved} | Failed: ${failed} | Total: ${done}`);
  console.log(`     Full  → ${paths.fullOutput}`);
  console.log(`     Price → ${paths.priceOutput}`);

  return { done, saved, failed };
}

// ─────────────────────────────────────────────────────────────
//  MAIN — runs all stores/categories when called directly
// ─────────────────────────────────────────────────────────────

async function scrapeAll(stores = STORES) {
  console.log('🚀 Multi-store price scraper (Web Unlocker API)\n');
  console.log(`   Stores     : ${stores.map(s => s.name).join(', ')}`);

  const totalCategories = stores.reduce((acc, s) => acc + s.categories.length, 0);
  console.log(`   Categories : ${totalCategories}\n`);

  const results = [];

  for (const store of stores) {
    for (const category of store.categories) {
      try {
        const result = await scrapeCategory(store, category);
        results.push({ store: store.name, category: category.slug, ...result, success: true });
      } catch (err) {
        console.error(`\n❌ Failed: ${store.name}/${category.slug}: ${err.message}`);
        results.push({ store: store.name, category: category.slug, success: false, error: err.message });
      }
    }
  }

  console.log('\n\n🎉 All stores and categories complete!');
  console.log('Output saved in: output/<store>/<category>/');

  return results;
}

// Run directly
if (require.main === module) {
  scrapeAll().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { scrapeAll, scrapeCategory };