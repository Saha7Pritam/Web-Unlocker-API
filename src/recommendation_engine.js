// src/recommendation_engine.js
// CHANGE: business variables (GST, CostOfBusiness, ProfitMargin) are now
// read from CategorySettings table per category.
// Falls back to system-wide defaults if a category row is missing or
// any value is NULL (meaning "not yet configured via UI").

require('dotenv').config();
const sql = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

// ── System-wide defaults (used when CategorySettings has no override) ──
const DEFAULT_GST             = 0.18;
const DEFAULT_COST_OF_BUSINESS = 0.07;
const DEFAULT_PROFIT_MARGIN   = 0.05;

function isInStock(stockStatus) {
  if (!stockStatus) return false;
  return stockStatus.toLowerCase().trim() !== 'out of stock';
}

async function getSqlPool() {
  const credential = process.env.AZURE_ENV === 'production'
    ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
    : new AzureCliCredential();

  const tokenResponse = await credential.getToken('https://database.windows.net/.default');

  return await sql.connect({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenResponse.token } },
    options : { encrypt: true, trustServerCertificate: false, requestTimeout: 60_000 },
  });
}

// ── Load CategorySettings — build a map keyed by CategoryName ────────
// Returns Map<string, { gst, costOfBusiness, profitMargin }>
// All values are decimals (e.g. 0.18), already converted from the
// percentage numbers stored in the DB (e.g. 18 → 0.18).
async function loadCategorySettings(pool) {
  console.log('⚙️  Loading category settings...');

  const result = await pool.request().query(`
    SELECT CategoryName, GST, CostOfBusiness, ProfitMargin
    FROM CategorySettings
  `);

  const map = new Map();
  for (const row of result.recordset) {
    map.set(row.CategoryName, {
      gst            : row.GST             != null ? parseFloat(row.GST)             / 100 : null,
      costOfBusiness : row.CostOfBusiness  != null ? parseFloat(row.CostOfBusiness)  / 100 : null,
      profitMargin   : row.ProfitMargin    != null ? parseFloat(row.ProfitMargin)    / 100 : null,
    });
  }

  console.log(`   ✅ ${map.size} category settings loaded`);
  return map;
}

// ── Get effective business variables for a product's category ─────────
// Prefers category-level settings; falls back to system defaults for any
// value that is NULL (not yet configured).
function getBusinessVars(categorySettings, categoryName) {
  const settings = categorySettings.get(categoryName);

  const gst            = settings?.gst            ?? DEFAULT_GST;
  const costOfBusiness = settings?.costOfBusiness ?? DEFAULT_COST_OF_BUSINESS;
  const profitMargin   = settings?.profitMargin   ?? DEFAULT_PROFIT_MARGIN;

  return { gst, costOfBusiness, profitMargin };
}

// ── Step 1: Load internal products ────────────────────────────────────
async function loadInternalProducts(pool) {
  console.log('📦 Loading internal products...');

  const result = await pool.request().query(`
    SELECT
      SKU_ID,
      Title,
      PP,
      SP,
      Category,
      LastBillDate,
      ManualPP_UpdatedAt,
      ManualPP_UpdatedBy
    FROM InternalProducts
    WHERE PP        IS NOT NULL
      AND isActive  = 1
      AND isInStock = 1
  `);

  console.log(`   ✅ ${result.recordset.length} eligible internal products`);
  return result.recordset;
}

// ── Determine effective PP for a product ─────────────────────────────
function resolveEffectivePP(product) {
  const { PP, LastBillDate, ManualPP_UpdatedAt } = product;

  if (!ManualPP_UpdatedAt) {
    return { effectivePP: parseFloat(PP), source: 'bill' };
  }
  if (!LastBillDate) {
    return { effectivePP: parseFloat(PP), source: 'manual (no bill date)' };
  }

  const manualDate = new Date(ManualPP_UpdatedAt);
  const billDate   = new Date(LastBillDate);

  if (manualDate >= billDate) {
    return { effectivePP: parseFloat(PP), source: 'manual' };
  } else {
    return { effectivePP: parseFloat(PP), source: 'bill (newer than manual)' };
  }
}

// ── Steps 2 & 3: Load competitor prices + build map ──────────────────
async function loadCompetitorPrices(pool) {
  console.log('🏪 Loading competitor prices...');
  const result = await pool.request().query(`
    SELECT SKU, CompetitorPrice, StockStatus, StoreName
    FROM CompetitorPrices
    WHERE CompetitorPrice IS NOT NULL
  `);
  console.log(`   ✅ ${result.recordset.length} competitor price rows`);
  return result.recordset;
}

function buildCompetitorMap(competitorRows) {
  const map = new Map();
  for (const row of competitorRows) {
    if (!row.SKU) continue;
    if (!isInStock(row.StockStatus)) continue;
    const key = row.SKU.trim().toUpperCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ price: parseFloat(row.CompetitorPrice), storeName: row.StoreName });
  }
  console.log(`   🗺️  ${map.size} unique SKUs with in-stock competitor`);
  return map;
}

// ── Step 4: Calculate recommended price ──────────────────────────────
// Now receives the three business vars so each category can have
// different rates.
function calculateRecommendedPrice(pp, lowestCompetitorPrice, gst, costOfBusiness, profitMargin) {
  const multiplier = 1 + gst + costOfBusiness + profitMargin;
  const basePrice  = parseFloat((pp * multiplier).toFixed(2));

  if (lowestCompetitorPrice <= basePrice) {
    return { recommendedSP: basePrice, pricingStrategy: 'floor' };
  }

  const target = parseFloat((lowestCompetitorPrice * 0.99).toFixed(2));
  if (target > basePrice) {
    return { recommendedSP: target, pricingStrategy: 'optimized' };
  }

  return { recommendedSP: basePrice, pricingStrategy: 'floor' };
}

// ── Step 5: Generate recommendations ─────────────────────────────────
function generateRecommendations(internalProducts, competitorMap, categorySettings) {
  console.log('\n🧮 Generating recommendations...');

  const recommendations = [];
  let skippedNoMatch = 0, strategyFloor = 0, strategyOptimized = 0;
  let sourceBill = 0, sourceManual = 0;

  // Track which categories used custom vs default settings for the log
  const categoryVarLog = new Map();

  for (const product of internalProducts) {
    const key = (product.SKU_ID || '').trim().toUpperCase();
    const competitorEntries = competitorMap.get(key);
    if (!competitorEntries || competitorEntries.length === 0) { skippedNoMatch++; continue; }

    const lowestEntry = competitorEntries.reduce((a, b) => a.price < b.price ? a : b);

    const { effectivePP, source } = resolveEffectivePP(product);
    if (source === 'manual') sourceManual++;
    else                     sourceBill++;

    // ── Look up per-category business variables ───────────────
    const { gst, costOfBusiness, profitMargin } = getBusinessVars(categorySettings, product.Category);
    const multiplier = 1 + gst + costOfBusiness + profitMargin;

    // Log per-category vars once
    if (!categoryVarLog.has(product.Category)) {
      categoryVarLog.set(product.Category, { gst, costOfBusiness, profitMargin, multiplier });
    }

    const { recommendedSP, pricingStrategy } = calculateRecommendedPrice(
      effectivePP, lowestEntry.price, gst, costOfBusiness, profitMargin
    );

    const baseFloor   = parseFloat((effectivePP * multiplier).toFixed(2));
    const extraProfit = parseFloat((recommendedSP - baseFloor).toFixed(2));

    if (pricingStrategy === 'floor')     strategyFloor++;
    if (pricingStrategy === 'optimized') strategyOptimized++;

    recommendations.push({
      SKU_ID               : product.SKU_ID,
      ProductName          : product.Title,
      PP                   : effectivePP,
      PPSource             : source,
      CurrentSP            : product.SP ? parseFloat(product.SP) : null,
      BaseFloor            : baseFloor,
      RecommendedPrice     : recommendedSP,
      LowestCompetitorPrice: lowestEntry.price,
      LowestCompetitorStore: lowestEntry.storeName,
      CompetitorCount      : competitorEntries.length,
      PricingStrategy      : pricingStrategy,
      ExtraProfit          : extraProfit,
    });
  }

  console.log(`   ✅ Recommendations generated   : ${recommendations.length}`);
  console.log(`   ⏭️  Skipped (no competitor match): ${skippedNoMatch}`);

  console.log(`\n   📊 Business variables per category:`);
  for (const [cat, vars] of categoryVarLog) {
    console.log(
      `      ${cat.padEnd(25)} GST=${(vars.gst * 100).toFixed(1)}% | ` +
      `COB=${(vars.costOfBusiness * 100).toFixed(1)}% | ` +
      `Margin=${(vars.profitMargin * 100).toFixed(1)}% | ` +
      `Multiplier=×${vars.multiplier.toFixed(4)}`
    );
  }

  console.log(`\n   📊 PP source breakdown:`);
  console.log(`      🧾 Bill PP used   : ${sourceBill}`);
  console.log(`      ✏️  Manual PP used : ${sourceManual}`);
  console.log(`\n   📊 Pricing strategy:`);
  console.log(`      🔼 Optimized : ${strategyOptimized}`);
  console.log(`      🔒 Floor     : ${strategyFloor}`);

  return recommendations;
}

// ── Step 6: Update RecommendedSP ─────────────────────────────────────
async function updateRecommendedSP(pool, recommendations) {
  console.log('\n📤 Updating RecommendedSP in InternalProducts...');
  let updated = 0, failed = 0;

  for (const row of recommendations) {
    try {
      await pool.request()
        .input('SKU_ID',        sql.NVarChar(100),  row.SKU_ID)
        .input('RecommendedSP', sql.Decimal(10, 2), row.RecommendedPrice)
        .query(`
          UPDATE InternalProducts
          SET RecommendedSP          = @RecommendedSP,
              RecommendedSPUpdatedAt = GETDATE()
          WHERE SKU_ID = @SKU_ID
        `);
      updated++;
    } catch (err) {
      failed++;
      console.error(`   → ${row.SKU_ID}: ${err.message}`);
    }
  }

  console.log(`   ✅ Updated : ${updated}`);
  console.log(`   ❌ Failed  : ${failed}`);
}

async function run() {
  const startTime = Date.now();

  console.log('🚀 Recommendation Engine starting...');
  console.log(`   System defaults: GST=${DEFAULT_GST * 100}% | COB=${DEFAULT_COST_OF_BUSINESS * 100}% | Margin=${DEFAULT_PROFIT_MARGIN * 100}%`);
  console.log(`   (Per-category overrides loaded from CategorySettings table)\n`);

  let pool;
  try {
    pool = await getSqlPool();
    console.log('🔌 Connected\n');

    // Load category settings FIRST — passed into generateRecommendations
    const categorySettings = await loadCategorySettings(pool);
    const internalProducts = await loadInternalProducts(pool);
    const competitorRows   = await loadCompetitorPrices(pool);
    const competitorMap    = buildCompetitorMap(competitorRows);
    const recommendations  = generateRecommendations(internalProducts, competitorMap, categorySettings);

    if (recommendations.length === 0) {
      console.log('\n⚠️  No recommendations generated.');
      return;
    }

    await updateRecommendedSP(pool, recommendations);

    console.log(`\n🎉 Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}





// Only auto-run when called directly via `npm run recommend`
if (require.main === module) {
  run();
}

// Export individual functions so api_server.js can call them on demand
module.exports = {
  getSqlPool,
  loadCategorySettings,
  loadInternalProducts,
  loadCompetitorPrices,
  buildCompetitorMap,
  generateRecommendations,
  updateRecommendedSP,
};