// src/scheduler/index.js
// ─────────────────────────────────────────────────────────────
// Auto scrape scheduler.
//
// Run manually now:   node src/scheduler/index.js
// On Azure later:     Azure Timer Trigger Function (daily at midnight)
//
// What it does:
//   1. Reads all distinct categories from InternalProducts
//   2. For each category, checks if scrape is due
//      (today >= NextScrapDueAt  OR  NextScrapDueAt is null)
//   3. Finds the matching store + category config from urls.js
//   4. Runs the scraper for that category
//   5. Runs cleanup_mapper (Cosmos → SQL) for new data
//   6. Runs recommendation engine for affected SKUs
//   7. Updates LastScrapedAt + NextScrapDueAt in DB
//
// Frequency logic:
//   - If isFreqOverridden = 1 → use ScrapFreq_Override (set via UI)
//   - If isFreqOverridden = 0 → use DEFAULT_FREQUENCIES map below
//
// NOTE: LastScrapedAt is ONLY written here (auto scheduler).
//       Manual refresh writes LastManualRefreshAt instead.
//       These two never interfere with each other.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const sql      = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const { STORES }         = require('../urls');
const { scrapeCategory } = require('../scraper/index');
const { upsertManyFromCosmos } = require('../services/competitorPriceService');
const { CosmosClient }   = require('@azure/cosmos');

// ── Default scrape frequencies (days) ────────────────────────
// Manager confirmed these. Stored here as fallback when
// isFreqOverridden = 0. When manager sets via UI, isFreqOverridden
// flips to 1 and ScrapFreq_Override value is used instead.
const DEFAULT_FREQUENCIES = {
  'Processor'         : 7,
  'RAM'               : 3,
  'SSD'               : 3,
  'HDD'               : 3,
  'Storage'           : 3,  // catch-all for SSD/HDD combined categories
  'DEFAULT'           : 2,  // all other categories
};

/**
 * Returns the scrape frequency in days for a given category.
 * Uses override if set, otherwise falls back to DEFAULT_FREQUENCIES.
 */
function getFrequencyDays(categoryName, scrapFreqOverride, isFreqOverridden) {
  if (isFreqOverridden && scrapFreqOverride != null) {
    return scrapFreqOverride;
  }

  // Case-insensitive match against defaults
  const key = Object.keys(DEFAULT_FREQUENCIES).find(
    k => k.toLowerCase() === (categoryName || '').toLowerCase()
  );

  return DEFAULT_FREQUENCIES[key] || DEFAULT_FREQUENCIES['DEFAULT'];
}

/**
 * Returns true if this category is due for a scrape today.
 */
function isDue(nextScrapDueAt) {
  // Never scraped before → always due
  if (!nextScrapDueAt) return true;

  const due  = new Date(nextScrapDueAt);
  const now  = new Date();

  return now >= due;
}

// ── SQL connection ────────────────────────────────────────────
async function getSqlPool() {
  const credential = process.env.AZURE_ENV === 'production'
    ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
    : new AzureCliCredential();

  const tokenResponse = await credential.getToken(
    'https://database.windows.net/.default'
  );

  return await sql.connect({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: {
      type   : 'azure-active-directory-access-token',
      options: { token: tokenResponse.token },
    },
    options: {
      encrypt              : true,
      trustServerCertificate: false,
      requestTimeout       : 60_000,
    },
  });
}

// ── Load distinct categories from InternalProducts ────────────
// Groups by Category and picks the frequency settings.
// One row per unique category name.
async function loadCategorySchedule(pool) {
  const result = await pool.request().query(`
    SELECT
      Category,
      MAX(ScrapFreq_Override)  AS ScrapFreq_Override,
      MAX(isFreqOverridden)    AS isFreqOverridden,
      MAX(NextScrapDueAt)      AS NextScrapDueAt,
      MAX(LastScrapedAt)       AS LastScrapedAt
    FROM InternalProducts
    WHERE Category IS NOT NULL
    GROUP BY Category
    ORDER BY Category
  `);

  return result.recordset;
}

// ── Update LastScrapedAt + NextScrapDueAt after successful scrape ──
// ONLY called by the scheduler — never by manual refresh.
async function updateScrapedTimestamps(pool, categoryName, frequencyDays) {
  const now     = new Date();
  const nextDue = new Date(now);
  nextDue.setDate(nextDue.getDate() + frequencyDays);

  const nowStr     = now.toISOString();
  const nextDueStr = nextDue.toISOString();

  await pool.request()
    .input('Category',      sql.NVarChar(200), categoryName)
    .input('LastScrapedAt', sql.NVarChar(50),  nowStr)
    .input('NextScrapDueAt',sql.NVarChar(50),  nextDueStr)
    .query(`
      UPDATE InternalProducts
      SET
        LastScrapedAt  = @LastScrapedAt,
        NextScrapDueAt = @NextScrapDueAt
      WHERE Category = @Category
    `);

  console.log(`   ⏰ NextScrapDueAt set to ${nextDueStr} (+${frequencyDays} days)`);
}

// ── Find matching store + category config from urls.js ────────
// Maps a DB category name to a store parser config.
// Returns { store, category } or null if not configured.
function findStoreConfig(categoryName) {
  for (const store of STORES) {
    for (const cat of store.categories) {
      // Match by slug (case-insensitive, hyphen-tolerant)
      const normalised = categoryName.toLowerCase().replace(/\s+/g, '-');
      if (
        cat.slug.toLowerCase() === normalised ||
        cat.slug.toLowerCase().includes(normalised) ||
        normalised.includes(cat.slug.toLowerCase())
      ) {
        return { store, category: cat };
      }
    }
  }
  return null;
}

// ── Push new Cosmos data to SQL after scraping ────────────────
async function runCleanupMapper() {
  const client    = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database('ScraperDB').container('scrap_results');

  const { resources } = await container.items
    .query('SELECT * FROM c')
    .fetchAll();

  console.log(`\n📦 Cosmos → SQL: ${resources.length} documents`);
  const stats = await upsertManyFromCosmos(resources);
  console.log(`   Inserted: ${stats.inserted} | Updated: ${stats.updated} | Failed: ${stats.failed}`);
}

// ── Main scheduler ────────────────────────────────────────────
async function runScheduler() {
  const startTime = Date.now();
  console.log('⏰ Scheduler starting...\n');

  let pool;

  try {
    pool = await getSqlPool();
    console.log('🔌 Connected to SQL\n');

    // Step 1: Load all categories + their schedule state
    const categories = await loadCategorySchedule(pool);
    console.log(`📋 Found ${categories.length} distinct categories in InternalProducts\n`);

    const due     = [];
    const skipped = [];

    // Step 2: Decide which categories need scraping
    for (const row of categories) {
      const freqDays = getFrequencyDays(
        row.Category,
        row.ScrapFreq_Override,
        row.isFreqOverridden
      );

      if (isDue(row.NextScrapDueAt)) {
        due.push({ ...row, freqDays });
      } else {
        skipped.push({ ...row, freqDays });
      }
    }

    console.log(`✅ Due for scraping   : ${due.length} categories`);
    console.log(`⏭️  Not due yet        : ${skipped.length} categories`);

    if (skipped.length > 0) {
      console.log('\n   Skipped (next due):');
      skipped.forEach(r =>
        console.log(`   → ${r.Category.padEnd(25)} next: ${r.NextScrapDueAt || 'unknown'}`)
      );
    }

    if (due.length === 0) {
      console.log('\n🎉 Nothing to scrape today. All categories are up to date.');
      return;
    }

    console.log('\n🚀 Starting scrapes...');

    // Step 3: Scrape each due category
    let totalScraped = 0;
    let totalFailed  = 0;

    for (const row of due) {
      console.log(`\n━━━ ${row.Category} (every ${row.freqDays} days) ━━━`);

      const config = findStoreConfig(row.Category);

      if (!config) {
        console.log(`   ⚠️  No store config found for category "${row.Category}" in urls.js — skipping`);
        console.log(`   💡 Add this category to a store in src/urls.js to enable auto-scraping`);
        continue;
      }

      console.log(`   Store: ${config.store.name} | Slug: ${config.category.slug}`);

      try {
        const result = await scrapeCategory(config.store, config.category);
        totalScraped += result.saved;
        totalFailed  += result.failed;

        // Step 4: Update timestamps — ONLY auto scheduler writes these
        await updateScrapedTimestamps(pool, row.Category, row.freqDays);

      } catch (err) {
        console.error(`   ❌ Scrape failed for ${row.Category}: ${err.message}`);
        totalFailed++;
      }
    }

    // Step 5: Push all new Cosmos data to SQL
    console.log('\n📤 Running cleanup mapper (Cosmos → SQL)...');
    await runCleanupMapper();

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n🎉 Scheduler done in ${totalSec}s`);
    console.log(`   Products scraped : ${totalScraped}`);
    console.log(`   Failed           : ${totalFailed}`);
    console.log(`\n   Run recommendation engine next:`);
    console.log(`   node src/recommendation_engine.js`);

  } catch (err) {
    console.error('\n❌ Scheduler fatal error:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

// Run directly
if (require.main === module) {
  runScheduler();
}

module.exports = { runScheduler };