// src/recommendation_engine.js
// CHANGE: effectivePP logic now applies the manual PP condition:
//   if ManualPP_UpdatedAt >= LastBillDate → use ManualPP (the current PP set by user)
//   else → use PP from Zoho bill (already stored in the PP column by internal_db_sync)
//
// No schema change needed for this file — it reads the columns already added.

require('dotenv').config();
const sql = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const GST               = 0.18;
const COST_OF_BUSINESS  = 0.07;
const MIN_PROFIT_MARGIN = 0.05;

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

// ── Step 1: Load internal products ────────────────────────────
// Now also fetches LastBillDate + ManualPP_UpdatedAt so we can
// decide which PP to use for each product.
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

// ── Determine effective PP for a product ─────────────────────
// Condition (from senior's note):
//   if ManualPP_UpdatedAt >= LastBillDate → Manual PP is newer → trust it
//   else (bill is newer OR no manual update) → use bill PP
//
// Since internal_db_sync already writes the latest bill PP into the PP column,
// "bill PP" IS the current PP column value.
// When a user manually updates PP via the UI, they overwrite the PP column directly
// AND set ManualPP_UpdatedAt to now.
// So the effective PP is always the PP column — but we LOG which source won.
function resolveEffectivePP(product) {
  const { PP, LastBillDate, ManualPP_UpdatedAt } = product;

  // No manual update ever made — use bill PP as-is
  if (!ManualPP_UpdatedAt) {
    return { effectivePP: parseFloat(PP), source: 'bill' };
  }

  // No bill date (product has no recent bill) — use whatever is in PP
  if (!LastBillDate) {
    return { effectivePP: parseFloat(PP), source: 'manual (no bill date)' };
  }

  const manualDate = new Date(ManualPP_UpdatedAt);
  const billDate   = new Date(LastBillDate);

  if (manualDate >= billDate) {
    // Manual update is at or after the last bill — keep manual PP
    return { effectivePP: parseFloat(PP), source: 'manual' };
  } else {
    // Bill is newer — but note: internal_db_sync already overwrote PP with bill value
    // on the last sync run, so PP is already the bill price.
    // We just log the source for transparency.
    return { effectivePP: parseFloat(PP), source: 'bill (newer than manual)' };
  }
}

// ── Steps 2 & 3: Load competitor prices + build map ──────────
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

// ── Step 4: Calculate recommended price ──────────────────────
function calculateRecommendedPrice(pp, lowestCompetitorPrice) {
  const basePrice = parseFloat((pp * (1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN)).toFixed(2));
  if (lowestCompetitorPrice <= basePrice) return { recommendedSP: basePrice, pricingStrategy: 'floor' };
  const target = parseFloat((lowestCompetitorPrice * 0.99).toFixed(2));
  if (target > basePrice) return { recommendedSP: target, pricingStrategy: 'optimized' };
  return { recommendedSP: basePrice, pricingStrategy: 'floor' };
}

// ── Step 5: Generate recommendations ─────────────────────────
function generateRecommendations(internalProducts, competitorMap) {
  console.log('\n🧮 Generating recommendations...');

  const recommendations = [];
  let skippedNoMatch = 0, strategyFloor = 0, strategyOptimized = 0;
  let sourceBill = 0, sourceManual = 0;

  for (const product of internalProducts) {
    const key = (product.SKU_ID || '').trim().toUpperCase();
    const competitorEntries = competitorMap.get(key);
    if (!competitorEntries || competitorEntries.length === 0) { skippedNoMatch++; continue; }

    const lowestEntry = competitorEntries.reduce((a, b) => a.price < b.price ? a : b);

    // ── Apply manual vs bill PP condition ──────────────────
    const { effectivePP, source } = resolveEffectivePP(product);
    if (source === 'manual') sourceManual++;
    else                     sourceBill++;

    const { recommendedSP, pricingStrategy } = calculateRecommendedPrice(effectivePP, lowestEntry.price);
    const baseFloor   = parseFloat((effectivePP * (1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN)).toFixed(2));
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
  console.log(`\n   📊 PP source breakdown:`);
  console.log(`      🧾 Bill PP used   : ${sourceBill}`);
  console.log(`      ✏️  Manual PP used : ${sourceManual}`);
  console.log(`\n   📊 Pricing strategy:`);
  console.log(`      🔼 Optimized : ${strategyOptimized}`);
  console.log(`      🔒 Floor     : ${strategyFloor}`);

  return recommendations;
}

// ── Step 6: Update RecommendedSP ─────────────────────────────
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
  const totalMultiplier = 1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN;

  console.log('🚀 Recommendation Engine starting...');
  console.log(`   Formula: PP × ${totalMultiplier}`);
  console.log(`   PP source: manual PP if ManualPP_UpdatedAt >= LastBillDate, else bill PP\n`);

  let pool;
  try {
    pool = await getSqlPool();
    console.log('🔌 Connected\n');

    const internalProducts = await loadInternalProducts(pool);
    const competitorRows   = await loadCompetitorPrices(pool);
    const competitorMap    = buildCompetitorMap(competitorRows);
    const recommendations  = generateRecommendations(internalProducts, competitorMap);

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

run();




















// // ─────────────────────────────────────────────────────────────
// //  src/recommendation_engine.js
// //
// //  Run: node src/recommendation_engine.js
// //
// //  What it does:
// //    1. Reads InternalProducts — only where PP is not null,
// //       isActive = 1, isInStock = 1
// //    2. Reads CompetitorPrices — only in-stock entries
// //    3. Matches on SKU (InternalProducts.SKU_ID = CompetitorPrices.SKU)
// //    4. Skips internal products with no competitor match
// //    5. Calculates RecommendedSP using additive formula:
// //         PP × (1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN)
// //    6. Updates RecommendedSP column directly in InternalProducts
// //
// //  Prototype constants (manager confirmed):
// //    GST               = 18%
// //    COST_OF_BUSINESS  = 7%
// //    MIN_PROFIT_MARGIN = 5%
// //
// //  Formula example — PP = ₹1000:
// //    1000 × (1 + 0.18 + 0.07 + 0.05)
// //    = 1000 × 1.30
// //    = ₹1300
// // ─────────────────────────────────────────────────────────────

// require('dotenv').config();
// const sql            = require('mssql');
// const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

// // ── Prototype constants ───────────────────────────────────────
// const GST               = 0.18;  // 18%
// const COST_OF_BUSINESS  = 0.07;  // 7%
// const MIN_PROFIT_MARGIN = 0.05;  // 5%

// // ── In-stock signal ───────────────────────────────────────────
// // StockStatus values: "In Stock" | "Hurry, Only X left." | "Out of Stock"
// // Anything that is NOT "out of stock" is treated as available.
// function isInStock(stockStatus) {
//   if (!stockStatus) return false;
//   return stockStatus.toLowerCase().trim() !== 'out of stock';
// }

// // ── SQL connection ────────────────────────────────────────────
// async function getSqlPool() {
//   const credential = process.env.AZURE_ENV === 'production'
//     ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
//     : new AzureCliCredential();

//   const tokenResponse = await credential.getToken(
//     'https://database.windows.net/.default'
//   );

//   return await sql.connect({
//     server  : process.env.db_serverendpoint,
//     database: 'db_tpstechautomata',
//     authentication: {
//       type   : 'azure-active-directory-access-token',
//       options: { token: tokenResponse.token },
//     },
//     options: {
//       encrypt              : true,
//       trustServerCertificate: false,
//       requestTimeout       : 60_000,
//     },
//   });
// }

// // ── Step 1: Load eligible internal products ───────────────────
// // Only products where:
// //   - PP is not null  (need cost base for formula)
// //   - isActive = 1    (live on the store)
// //   - isInStock = 1   (currently selling)
// async function loadInternalProducts(pool) {
//   console.log('📦 Loading internal products (PP not null, active, in stock)...');

//   const result = await pool.request().query(`
//     SELECT SKU_ID, Title, PP, SP, Category
//     FROM   InternalProducts
//     WHERE  PP        IS NOT NULL
//       AND  isActive  = 1
//       AND  isInStock = 1
//   `);

//   console.log(`   ✅ ${result.recordset.length} eligible internal products`);
//   return result.recordset;
// }

// // ── Step 2: Load competitor prices ───────────────────────────
// async function loadCompetitorPrices(pool) {
//   console.log('🏪 Loading competitor prices...');

//   const result = await pool.request().query(`
//     SELECT SKU, CompetitorPrice, StockStatus, StoreName
//     FROM   CompetitorPrices
//     WHERE  CompetitorPrice IS NOT NULL
//   `);

//   console.log(`   ✅ ${result.recordset.length} competitor price rows`);
//   return result.recordset;
// }

// // ── Step 3: Build competitor lookup map ───────────────────────
// // Key   : SKU uppercased (case-insensitive matching)
// // Value : array of in-stock { price, storeName }
// function buildCompetitorMap(competitorRows) {
//   const map = new Map();

//   for (const row of competitorRows) {
//     if (!row.SKU) continue;
//     if (!isInStock(row.StockStatus)) continue;

//     const key = row.SKU.trim().toUpperCase();
//     if (!map.has(key)) map.set(key, []);
//     map.get(key).push({
//       price    : parseFloat(row.CompetitorPrice),
//       storeName: row.StoreName,
//     });
//   }

//   console.log(`   🗺️  ${map.size} unique SKUs with at least one in-stock competitor`);
//   return map;
// }

// // ── Step 4: Calculate recommended price ───────────────────────
// // Phase 1 — Base floor: PP × (1 + GST + COB + margin) = PP × 1.30
// // Phase 2 — Optimize:   if competitor is higher, go to 99% of their price
// //           but only if 99% of competitor > base floor (never sell below cost)
// function calculateRecommendedPrice(pp, lowestCompetitorPrice) {
//   const basePrice = parseFloat(
//     (pp * (1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN)).toFixed(2)
//   );

//   // No room to optimize — competitor is at or below our cost floor
//   if (lowestCompetitorPrice <= basePrice) {
//     return { recommendedSP: basePrice, pricingStrategy: 'floor' };
//   }

//   // Competitor is higher — try to go 1% below them
//   const target = parseFloat((lowestCompetitorPrice * 0.99).toFixed(2));

//   if (target > basePrice) {
//     return { recommendedSP: target, pricingStrategy: 'optimized' };
//   }

//   return { recommendedSP: basePrice, pricingStrategy: 'floor' };
// }

// // ── Step 5: Generate recommendations ─────────────────────────
// // ── Step 5: Generate recommendations ─────────────────────────
// function generateRecommendations(internalProducts, competitorMap) {
//   console.log('\n🧮 Generating recommendations...');

//   const recommendations = [];
//   let skippedNoMatch  = 0;
//   let strategyFloor   = 0;
//   let strategyOptimized = 0;

//   for (const product of internalProducts) {
//     const key = (product.SKU_ID || '').trim().toUpperCase();
//     const competitorEntries = competitorMap.get(key);

//     if (!competitorEntries || competitorEntries.length === 0) {
//       skippedNoMatch++;
//       continue;
//     }

//     const lowestEntry = competitorEntries.reduce((a, b) =>
//       a.price < b.price ? a : b
//     );

//     const pp = parseFloat(product.PP);
//     const { recommendedSP, pricingStrategy } = calculateRecommendedPrice(pp, lowestEntry.price);

//     const baseFloor = parseFloat(
//       (pp * (1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN)).toFixed(2)
//     );
//     const extraProfit = parseFloat((recommendedSP - baseFloor).toFixed(2));

//     if (pricingStrategy === 'floor')     strategyFloor++;
//     if (pricingStrategy === 'optimized') strategyOptimized++;

//     recommendations.push({
//       SKU_ID               : product.SKU_ID,
//       ProductName          : product.Title,
//       PP                   : pp,
//       CurrentSP            : product.SP ? parseFloat(product.SP) : null,
//       BaseFloor            : baseFloor,
//       RecommendedPrice     : recommendedSP,
//       LowestCompetitorPrice: lowestEntry.price,
//       LowestCompetitorStore: lowestEntry.storeName,
//       CompetitorCount      : competitorEntries.length,
//       PricingStrategy      : pricingStrategy,
//       ExtraProfit          : extraProfit,
//     });
//   }

//   console.log(`   ✅ Recommendations generated   : ${recommendations.length}`);
//   console.log(`   ⏭️  Skipped (no competitor match): ${skippedNoMatch}`);
//   console.log(`\n   📊 Pricing strategy breakdown:`);
//   console.log(`      🔼 Optimized (99% of competitor) : ${strategyOptimized}`);
//   console.log(`      🔒 Floor    (PP × 1.30 used)     : ${strategyFloor}`);

//   console.log('\n   📋 Sample recommendations:');
//   recommendations.slice(0, 8).forEach(r => {
//     const tag = r.PricingStrategy === 'optimized' ? '🔼' : '🔒';
//     console.log(
//       `   ${tag} ${r.SKU_ID}\n` +
//       `      PP=₹${r.PP} | Floor=₹${r.BaseFloor} | RecommendedSP=₹${r.RecommendedPrice}\n` +
//       `      Competitor=₹${r.LowestCompetitorPrice} (${r.LowestCompetitorStore})` +
//       ` | ExtraProfit=₹${r.ExtraProfit}` +
//       (r.CurrentSP ? ` | CurrentSP=₹${r.CurrentSP}` : '')
//     );
//   });

//   return recommendations;
// }

// // ── Step 6: Update RecommendedSP in InternalProducts ─────────
// // async function updateRecommendedSP(pool, recommendations) {
// //   console.log('\n📤 Updating RecommendedSP in InternalProducts...');

// //   let updated = 0;
// //   let failed  = 0;

// //   for (const row of recommendations) {
// //     try {
// //       await pool.request()
// //         .input('SKU_ID',        sql.NVarChar(100),  row.SKU_ID)
// //         .input('RecommendedSP', sql.Decimal(10, 2), row.RecommendedPrice)
// //         .query(`
// //           UPDATE InternalProducts
// //           SET    RecommendedSP = @RecommendedSP,
// //                  UpdatedAt     = GETDATE()
// //           WHERE  SKU_ID = @SKU_ID
// //         `);
// //       updated++;
// //     } catch (err) {
// //       failed++;
// //       console.error(`   → ${row.SKU_ID}: ${err.message}`);
// //     }
// //   }

// //   console.log(`   ✅ Updated : ${updated}`);
// //   console.log(`   ❌ Failed  : ${failed}`);
// // }

// // ── Step 6: Update RecommendedSP in InternalProducts ─────────
// async function updateRecommendedSP(pool, recommendations) {
//   console.log('\n📤 Updating RecommendedSP in InternalProducts...');

//   let updated = 0;
//   let failed  = 0;

//   for (const row of recommendations) {
//     try {
//       await pool.request()
//         .input('SKU_ID',        sql.NVarChar(100),  row.SKU_ID)
//         .input('RecommendedSP', sql.Decimal(10, 2), row.RecommendedPrice)
//         .query(`
//           UPDATE InternalProducts
//           SET    RecommendedSP          = @RecommendedSP,
//                  RecommendedSPUpdatedAt = GETDATE()
//           WHERE  SKU_ID = @SKU_ID
//         `);
//       updated++;
//     } catch (err) {
//       failed++;
//       console.error(`   → ${row.SKU_ID}: ${err.message}`);
//     }
//   }

//   console.log(`   ✅ Updated : ${updated}`);
//   console.log(`   ❌ Failed  : ${failed}`);
// }

// // ── Main ──────────────────────────────────────────────────────
// async function run() {
//   const startTime = Date.now();

//   const totalMultiplier = 1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN;

//   console.log('🚀 Recommendation Engine starting...');
//   console.log(`   GST               : ${GST * 100}%`);
//   console.log(`   Cost of Business  : ${COST_OF_BUSINESS * 100}%`);
//   console.log(`   Min Profit Margin : ${MIN_PROFIT_MARGIN * 100}%`);
//   console.log(`   Formula           : PP × ${totalMultiplier} (e.g. ₹1000 → ₹${(1000 * totalMultiplier).toFixed(2)})\n`);

//   let pool;
//   try {
//     console.log('🔌 Connecting to Azure SQL...');
//     pool = await getSqlPool();
//     console.log('   Connected\n');

//     const internalProducts = await loadInternalProducts(pool);
//     const competitorRows   = await loadCompetitorPrices(pool);
//     const competitorMap    = buildCompetitorMap(competitorRows);
//     const recommendations  = generateRecommendations(internalProducts, competitorMap);

//     if (recommendations.length === 0) {
//       console.log('\n⚠️  No recommendations generated — check that SKUs match between tables.');
//       return;
//     }

//     await updateRecommendedSP(pool, recommendations);

//     const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
//     console.log(`\n🎉 Done in ${totalSec}s`);
//     console.log(`\n   To verify in SSMS:`);
//     console.log(`   SELECT SKU_ID, PP, SP, RecommendedSP FROM InternalProducts WHERE RecommendedSP IS NOT NULL`);

//   } catch (err) {
//     console.error('\n❌ Fatal error:', err.message);
//     process.exit(1);
//   } finally {
//     if (pool) await pool.close();
//   }
// }

// run();