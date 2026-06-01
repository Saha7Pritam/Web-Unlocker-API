// src/scheduler/index.js
// CHANGE: scrape frequency now comes from CategorySettings table
// instead of ScrapFreq_Override / isFreqOverridden on InternalProducts.
// LastScrapedAt and NextScrapDueAt still live on InternalProducts — unchanged.

require('dotenv').config();

const sql      = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const { STORES }               = require('../urls');
const { scrapeCategory }       = require('../scraper/index');
const { upsertManyFromCosmos } = require('../services/competitorPriceService');
const { CosmosClient }         = require('@azure/cosmos');

// ── System-wide default frequencies (days) ───────────────────
// Used only as a last resort — when a category has no row in
// CategorySettings at all (shouldn't happen after the seed script,
// but good to have as a safety net).
const DEFAULT_FREQUENCIES = {
  'Processor' : 7,
  'RAM'       : 3,
  'SSD'       : 3,
  'HDD'       : 3,
  'Storage'   : 3,
  'DEFAULT'   : 2,
};

function getDefaultFrequency(categoryName) {
  const key = Object.keys(DEFAULT_FREQUENCIES).find(
    k => k.toLowerCase() === (categoryName || '').toLowerCase()
  );
  return DEFAULT_FREQUENCIES[key] || DEFAULT_FREQUENCIES['DEFAULT'];
}

function isDue(nextScrapDueAt) {
  if (!nextScrapDueAt) return true;
  return new Date() >= new Date(nextScrapDueAt);
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

// ── Load category schedule ────────────────────────────────────
// JOIN between InternalProducts (for timing state) and
// CategorySettings (for frequency config).
// LEFT JOIN so categories not yet in CategorySettings still appear
// and get the hardcoded default frequency as fallback.
async function loadCategorySchedule(pool) {
  const result = await pool.request().query(`
    SELECT
      ip.Category,
      MAX(ip.NextScrapDueAt)     AS NextScrapDueAt,
      MAX(ip.LastScrapedAt)      AS LastScrapedAt,
      -- Prefer CategorySettings values; fall back to NULL if no row
      MAX(cs.ScrapFreqDays)      AS ScrapFreqDays,
      MAX(cs.IsScrapEnabled)     AS IsScrapEnabled
    FROM InternalProducts ip
    LEFT JOIN CategorySettings cs ON cs.CategoryName = ip.Category
    WHERE ip.Category IS NOT NULL
    GROUP BY ip.Category
    ORDER BY ip.Category
  `);

  return result.recordset;
}

// ── Update LastScrapedAt + NextScrapDueAt after successful scrape ──
// Still writes to InternalProducts — timing state stays there.
async function updateScrapedTimestamps(pool, categoryName, frequencyDays) {
  const now     = new Date();
  const nextDue = new Date(now);
  nextDue.setDate(nextDue.getDate() + frequencyDays);

  await pool.request()
    .input('Category',       sql.NVarChar(200), categoryName)
    .input('LastScrapedAt',  sql.NVarChar(50),  now.toISOString())
    .input('NextScrapDueAt', sql.NVarChar(50),  nextDue.toISOString())
    .query(`
      UPDATE InternalProducts
      SET LastScrapedAt  = @LastScrapedAt,
          NextScrapDueAt = @NextScrapDueAt
      WHERE Category = @Category
    `);

  console.log(`   ⏰ NextScrapDueAt set to ${nextDue.toISOString()} (+${frequencyDays} days)`);
}

// ── Find matching store + category config from urls.js ────────
function findStoreConfig(categoryName) {
  for (const store of STORES) {
    for (const cat of store.categories) {
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

    const categories = await loadCategorySchedule(pool);
    console.log(`📋 Found ${categories.length} distinct categories\n`);

    const due     = [];
    const skipped = [];
    const paused  = [];

    for (const row of categories) {
      // IsScrapEnabled = 0 means paused from the UI
      if (row.IsScrapEnabled === false || row.IsScrapEnabled === 0) {
        paused.push(row);
        continue;
      }

      // Frequency: use CategorySettings value, fall back to hardcoded default
      const freqDays = row.ScrapFreqDays ?? getDefaultFrequency(row.Category);

      if (isDue(row.NextScrapDueAt)) {
        due.push({ ...row, freqDays });
      } else {
        skipped.push({ ...row, freqDays });
      }
    }

    console.log(`✅ Due for scraping   : ${due.length} categories`);
    console.log(`⏭️  Not due yet        : ${skipped.length} categories`);
    if (paused.length > 0) {
      console.log(`⏸️  Paused (UI)        : ${paused.length} categories`);
      paused.forEach(r => console.log(`   → ${r.Category}`));
    }

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

    let totalScraped = 0;
    let totalFailed  = 0;

    for (const row of due) {
      console.log(`\n━━━ ${row.Category} (every ${row.freqDays} days) ━━━`);

      const config = findStoreConfig(row.Category);

      if (!config) {
        console.log(`   ⚠️  No store config found for "${row.Category}" in urls.js — skipping`);
        continue;
      }

      console.log(`   Store: ${config.store.name} | Slug: ${config.category.slug}`);

      try {
        const result = await scrapeCategory(config.store, config.category);
        totalScraped += result.saved;
        totalFailed  += result.failed;

        await updateScrapedTimestamps(pool, row.Category, row.freqDays);
      } catch (err) {
        console.error(`   ❌ Scrape failed for ${row.Category}: ${err.message}`);
        totalFailed++;
      }
    }

    console.log('\n📤 Running cleanup mapper (Cosmos → SQL)...');
    await runCleanupMapper();

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Scheduler done in ${totalSec}s`);
    console.log(`   Products scraped : ${totalScraped}`);
    console.log(`   Failed           : ${totalFailed}`);

  } catch (err) {
    console.error('\n❌ Scheduler fatal error:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

if (require.main === module) {
  runScheduler();
}

module.exports = { runScheduler };