// src/services/competitorPriceService.js
// ─────────────────────────────────────────────────────────────
// Reusable competitor price mapping + SQL upsert logic.
// Extracted from cleanup_mapper.js so both:
//   - cleanup_mapper.js (full batch CLI)
//   - api_server.js     (single product manual refresh)
// can call the same functions without duplication.
// ─────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const sql = require('mssql');
const {
  AzureCliCredential,
  ManagedIdentityCredential,
} = require('@azure/identity');

// ── SQL connection ────────────────────────────────────────────
async function getSqlPool() {
  const credential =
    process.env.AZURE_ENV === 'production'
      ? new ManagedIdentityCredential({
          clientId: process.env.db_userclientid,
        })
      : new AzureCliCredential();

  const tokenResponse = await credential.getToken(
    'https://database.windows.net/.default'
  );

  return await sql.connect({
    server: process.env.db_serverendpoint,
    database: 'db_tpstechautomata',

    authentication: {
      type: 'azure-active-directory-access-token',
      options: {
        token: tokenResponse.token,
      },
    },

    options: {
      encrypt: true,
      trustServerCertificate: false,
      requestTimeout: 60_000,
    },
  });
}

// ── Price parser ──────────────────────────────────────────────
// Strips currency symbols, commas, whitespace → returns float or null
function parsePrice(priceStr) {
  if (!priceStr) return null;

  return (
    parseFloat(
      String(priceStr)
        .replace(/[^0-9.]/g, '')
        .trim()
    ) || null
  );
}

// ── SKU cleaners ──────────────────────────────────────────────
function cleanSku(value) {
  if (Array.isArray(value)) {
    value = value[0];
  }

  if (value === undefined || value === null) {
    return null;
  }

  const sku = String(value).trim();

  if (!sku) {
    return null;
  }

  if (/^(n\/?a|none|null|undefined|-|--|not available)$/i.test(sku)) {
    return null;
  }

  return sku;
}

function firstSku(...values) {
  for (const value of values) {
    const sku = cleanSku(value);

    if (sku) {
      return sku;
    }
  }

  return null;
}

// ── Map raw Cosmos document → flat SQL row ────────────────────
// Each store has its own field names — normalized into one shape.
// Returns null for unknown stores or products with no SKU.
function mapProduct(product) {
  const store = String(
    product.storeName || product.store || ''
  ).toLowerCase();

  // ── Vishal Peripherals ──────────────────────────────────────
  if (store === 'vishal') {
    return {
      ScrapID: uuidv4(),
      SKU: firstSku(product.modelNumber, product.sku),
      Name: product.name || null,
      CompetitorPrice: parsePrice(product.salePrice),
      ProductURL: product.url || null,
      StockStatus: product.stockStatus || null,
      StoreName: 'vishal',
      Category: product.category || null,
      ScrapedAt: product.scrapedAt || null,
    };
  }

  // ── PC Studio ───────────────────────────────────────────────
  if (store === 'pcstudio') {
    return {
      ScrapID: uuidv4(),
      SKU: firstSku(product.modelNumber, product.sku),
      Name: product.name || null,
      CompetitorPrice: parsePrice(product.salePrice),
      ProductURL: product.url || null,
      StockStatus: product.stockStatus || null,
      StoreName: 'pcstudio',
      Category: product.category || null,
      ScrapedAt: product.scrapedAt || null,
    };
  }

  // PrimeABGB
  if (store === 'primeabgb') {
    return {
      ScrapID: uuidv4(),
      SKU: firstSku(product.sku),
      Name: product.name || null,
      CompetitorPrice: parsePrice(product.salePrice),
      ProductURL: product.url || null,
      StockStatus: product.stockStatus || null,
      StoreName: 'primeabgb',
      Category: product.category || null,
      ScrapedAt: product.scrapedAt || null,
    };
  }

  // MDComputers
  if (store === 'mdcomputers') {
    return {
      ScrapID: uuidv4(),
      SKU: firstSku(
        product.productCode,
        product.sku,
        product.model,
        product.modelNumber
      ),
      Name: product.name || null,
      CompetitorPrice: parsePrice(product.salePrice),
      ProductURL: product.url || null,
      StockStatus: product.stockStatus || null,
      StoreName: 'mdcomputers',
      Category: product.category || null,
      ScrapedAt: product.scrapedAt || null,
    };
  }

  // Vedant Computers
  if (store === 'vedant') {
    return {
      ScrapID: uuidv4(),
      SKU: firstSku(product.model, product.sku),
      Name: product.name || null,
      CompetitorPrice: parsePrice(product.salePrice),
      ProductURL: product.url || null,
      StockStatus: product.stockStatus || null,
      StoreName: 'vedant',
      Category: product.category || null,
      ScrapedAt: product.scrapedAt || null,
    };
  }

  // Unknown store
  return null;
}

// ── Upsert a single mapped row into CompetitorPrices ──────────
// MERGE key: SKU + StoreName
// On match  → update existing row
// No match  → insert new row
async function upsertCompetitorPrice(pool, row) {
  return await pool
    .request()
    .input('ScrapID', sql.NVarChar(36), row.ScrapID)
    .input('SKU', sql.NVarChar(100), row.SKU)
    .input('Name', sql.NVarChar(500), row.Name)
    .input('CompetitorPrice', sql.Decimal(10, 2), row.CompetitorPrice)
    .input('ProductURL', sql.NVarChar(sql.MAX), row.ProductURL)
    .input('StockStatus', sql.NVarChar(50), row.StockStatus)
    .input('StoreName', sql.NVarChar(100), row.StoreName)
    .input('Category', sql.NVarChar(100), row.Category)
    .input('ScrapedAt', sql.NVarChar(50), row.ScrapedAt)

    .query(`
      MERGE CompetitorPrices AS target

      USING (
        SELECT
          @SKU AS SKU,
          @StoreName AS StoreName
      ) AS source

      ON target.SKU = source.SKU
      AND target.StoreName = source.StoreName

      WHEN MATCHED THEN
        UPDATE SET
          CompetitorPrice = @CompetitorPrice,
          StockStatus     = @StockStatus,
          ScrapedAt       = @ScrapedAt

      WHEN NOT MATCHED THEN
        INSERT (
          ScrapID,
          SKU,
          Name,
          CompetitorPrice,
          ProductURL,
          StockStatus,
          StoreName,
          Category,
          ScrapedAt
        )
        VALUES (
          @ScrapID,
          @SKU,
          @Name,
          @CompetitorPrice,
          @ProductURL,
          @StockStatus,
          @StoreName,
          @Category,
          @ScrapedAt
        )

      OUTPUT $action AS Action;
    `);
}

// ── Batch upsert — used by cleanup_mapper ─────────────────────
// Takes an array of raw Cosmos documents, maps them, upserts all.
async function upsertManyFromCosmos(products) {
  let mapped = 0;
  let skipped = 0;
  let inserted = 0;
  let updated = 0;
  let failed = 0;

  const failedRows = [];

  // ── Map products first ──────────────────────────────────────
  const rows = [];

  for (const product of products) {
    const row = mapProduct(product);

    if (row && row.SKU !== null) {
      rows.push(row);
      mapped++;
    } else {
      skipped++;
    }
  }

  console.log(`   Mapped : ${mapped}`);
  console.log(`   Skipped: ${skipped} (null SKU or unknown store)`);

  // ── Connect SQL ─────────────────────────────────────────────
  const pool = await getSqlPool();

  console.log('   Connected to SQL');

  // ── Upsert rows ─────────────────────────────────────────────
  for (const row of rows) {
    try {
      const result = await upsertCompetitorPrice(pool, row);

      const action = result.recordset?.[0]?.Action;

      if (action === 'INSERT') {
        inserted++;
      } else if (action === 'UPDATE') {
        updated++;
      }
    } catch (err) {
      failed++;

      failedRows.push({
        SKU: row.SKU,
        StoreName: row.StoreName,
        Price: row.CompetitorPrice,
        Error: err.message,
      });

      console.error(
        `   ❌ Failed: ${row.SKU} | ${row.StoreName}`
      );

      console.error(err.message);
    }
  }

  await pool.close();

  return {
    mapped,
    skipped,
    inserted,
    updated,
    failed,
    failedRows,
  };
}

// ── Single upsert — used by manual refresh API ────────────────
async function upsertOneProduct(product) {
  const row = mapProduct(product);

  if (!row || !row.SKU) {
    console.log('   ⚠️ Could not map product — no SKU found');
    return null;
  }

  const pool = await getSqlPool();

  try {
    await upsertCompetitorPrice(pool, row);

    console.log(
      `   ✅ Upserted: ${row.SKU} | ${row.StoreName} | ₹${row.CompetitorPrice}`
    );

    return row;
  } finally {
    await pool.close();
  }
}

// ── Exports ───────────────────────────────────────────────────
module.exports = {
  mapProduct,
  parsePrice,
  cleanSku,
  upsertOneProduct,
  upsertManyFromCosmos,
};






























// // src/services/competitorPriceService.js
// // ─────────────────────────────────────────────────────────────
// // Reusable competitor price mapping + SQL upsert logic.
// // Extracted from cleanup_mapper.js so both:
// //   - cleanup_mapper.js (full batch CLI)
// //   - api_server.js     (single product manual refresh)
// // can call the same functions without duplication.
// // ─────────────────────────────────────────────────────────────

// const { v4: uuidv4 } = require('uuid');
// const sql            = require('mssql');
// const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

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

// // ── Price parser ──────────────────────────────────────────────
// // Strips currency symbols, commas, whitespace → returns float or null
// function parsePrice(priceStr) {
//   if (!priceStr) return null;
//   return parseFloat(String(priceStr).replace(/[^0-9.]/g, '').trim()) || null;
// }

// function cleanSku(value) {
//   if (Array.isArray(value)) value = value[0];
//   if (value === undefined || value === null) return null;

//   const sku = String(value).trim();
//   if (!sku) return null;

//   if (/^(n\/?a|none|null|undefined|-|--|not available)$/i.test(sku)) {
//     return null;
//   }

//   return sku;
// }

// function validModelSku(value) {
//   const sku = cleanSku(value);
//   if (!sku) return null;

//   // These are labels, not product identifiers.
//   if (/^(amd|intel|corsair|adata|crucial|processor|ram)$/i.test(sku)) {
//     return null;
//   }

//   if (/^bxYRhb3D6x$/i.test(sku)) {
//     return null;
//   }

//   // Real part numbers in this data set include at least one digit.
//   if (!/[0-9]/.test(sku)) return null;

//   return sku;
// }

// function firstSku(...values) {
//   for (const value of values) {
//     const sku = validModelSku(value);
//     if (sku) return sku;
//   }
//   return null;
// }

// // ── Map raw Cosmos document → flat SQL row ────────────────────
// // Each store has its own field names — normalised here into one shape.
// // Returns null for unknown stores or products with no SKU.
// function mapProduct(product) {
//   const store = product.store;

//   if (store === 'primeabgb') {
//     return {
//       ScrapID         : uuidv4(),
//       SKU             : firstSku(product.sku),
//       Name            : product.name || null,
//       CompetitorPrice : parsePrice(product.salePrice),
//       ProductURL      : product.url,
//       StockStatus     : product.stockStatus || null,
//       StoreName       : 'primeabgb',
//       Category        : product.category || null,
//       ScrapedAt       : product.scrapedAt,
//     };
//   }

//   if (store === 'mdcomputers') {
//     return {
//       ScrapID         : uuidv4(),
//       SKU             : firstSku(product.productCode, product.sku, product.model, product.modelNumber),
//       Name            : product.name || null,
//       CompetitorPrice : parsePrice(product.salePrice),
//       ProductURL      : product.url,
//       StockStatus     : product.stockStatus || null,
//       StoreName       : 'mdcomputers',
//       Category        : product.category || null,
//       ScrapedAt       : product.scrapedAt,
//     };
//   }

//   // if (store === 'pickpcparts') {
//   //   const lowestRetailer = product.lowestPrice?.retailer;
//   //   const lowestEntry    = product.retailerPrices?.find(r => r.retailer === lowestRetailer);
//   //   const sku            = product.partId || product.partIds?.[0] || null;

//   //   return {
//   //     ScrapID         : uuidv4(),
//   //     SKU             : sku,
//   //     Name            : product.name || null,
//   //     CompetitorPrice : parsePrice(product.lowestPrice?.price),
//   //     ProductURL      : product.url,
//   //     StockStatus     : lowestEntry?.available || null,
//   //     StoreName       : 'pickpcparts',
//   //     Category        : product.category || null,
//   //     ScrapedAt       : product.scrapedAt,
//   //   };
//   // }

//   if (store === 'vedant') {
//     return {
//       ScrapID         : uuidv4(),
//       SKU             : firstSku(product.model, product.sku),
//       Name            : product.name || null,
//       CompetitorPrice : parsePrice(product.salePrice),
//       ProductURL      : product.url,
//       StockStatus     : product.stockStatus || null,
//       StoreName       : 'vedant',
//       Category        : product.category || null,
//       ScrapedAt       : product.scrapedAt,
//     };
//   }

//   if (store === 'vishal') {
//     return {
//       ScrapID         : uuidv4(),
//       SKU             : firstSku(product.modelNumber, product.sku),
//       Name            : product.name || null,
//       CompetitorPrice : parsePrice(product.salePrice),
//       ProductURL      : product.url,
//       StockStatus     : product.stockStatus || null,
//       StoreName       : 'vishal',
//       Category        : product.category || null,
//       ScrapedAt       : product.scrapedAt,
//     };
//   }

//   if (store === 'pcstudio') {
//     return {
//       ScrapID         : uuidv4(),
//       SKU             : firstSku(product.modelNumber, product.sku),
//       Name            : product.name || null,
//       CompetitorPrice : parsePrice(product.salePrice),
//       ProductURL      : product.url,
//       StockStatus     : product.stockStatus || null,
//       StoreName       : 'pcstudio',
//       Category        : product.category || null,
//       ScrapedAt       : product.scrapedAt,
//     };
//   }

//   // Unknown store — caller will log/skip
//   return null;
// }

// // ── Upsert a single mapped row into CompetitorPrices ─────────
// // MERGE key: SKU + StoreName (one row per SKU per store)
// // On match  → update price, stock, scrapedAt
// // No match  → insert new row
// async function upsertCompetitorPrice(pool, row) {
//   return await pool.request()
//     .input('ScrapID',         sql.NVarChar(36),       row.ScrapID)
//     .input('SKU',             sql.NVarChar(100),      row.SKU)
//     .input('Name',            sql.NVarChar(500),      row.Name)
//     .input('CompetitorPrice', sql.Decimal(10, 2),     row.CompetitorPrice)
//     .input('ProductURL',      sql.NVarChar(sql.MAX),  row.ProductURL)
//     .input('StockStatus',     sql.NVarChar(50),       row.StockStatus)
//     .input('StoreName',       sql.NVarChar(100),      row.StoreName)
//     .input('Category',        sql.NVarChar(100),      row.Category)
//     .input('ScrapedAt',       sql.NVarChar(50),       row.ScrapedAt)
//     .query(`
//       MERGE CompetitorPrices AS target
//       USING (SELECT @SKU AS SKU, @StoreName AS StoreName) AS source
//         ON target.SKU = source.SKU AND target.StoreName = source.StoreName
//       WHEN MATCHED THEN
//         UPDATE SET
//           CompetitorPrice = @CompetitorPrice,
//           StockStatus     = @StockStatus,
//           ScrapedAt       = @ScrapedAt
//       WHEN NOT MATCHED THEN
//         INSERT (ScrapID, SKU, Name, CompetitorPrice, ProductURL, StockStatus, StoreName, Category, ScrapedAt)
//         VALUES (@ScrapID, @SKU, @Name, @CompetitorPrice, @ProductURL, @StockStatus, @StoreName, @Category, @ScrapedAt)
//       OUTPUT $action AS Action;
//     `);
// }

// // ── Batch upsert — used by cleanup_mapper (full Cosmos dump) ──
// // Takes an array of raw Cosmos documents, maps them, upserts all.
// // Returns summary stats.
// async function upsertManyFromCosmos(products) {
//   let mapped   = 0;
//   let skipped  = 0;
//   let inserted = 0;
//   let updated  = 0;
//   let failed   = 0;
//   const failedRows = [];

//   // Map all products first
//   const rows = [];
//   for (const product of products) {
//     const row = mapProduct(product);
//     if (row && row.SKU !== null) {
//       rows.push(row);
//       mapped++;
//     } else {
//       skipped++;
//     }
//   }

//   console.log(`   Mapped : ${mapped}`);
//   console.log(`   Skipped: ${skipped} (null SKU or unknown store)`);

//   // Connect + upsert
//   const pool = await getSqlPool();
//   console.log('   Connected to SQL');

//   for (const row of rows) {
//     try {
//       const result = await upsertCompetitorPrice(pool, row);
//       const action = result.recordset?.[0]?.Action;
//       if (action === 'INSERT') inserted++;
//       else if (action === 'UPDATE') updated++;
//     } catch (err) {
//       failed++;
//       failedRows.push({
//         SKU      : row.SKU,
//         StoreName: row.StoreName,
//         Price    : row.CompetitorPrice,
//         Error    : err.message,
//       });
//     }
//   }

//   await pool.close();

//   return { mapped, skipped, inserted, updated, failed, failedRows };
// }

// // ── Single upsert — used by manual refresh API ────────────────
// // Takes one raw scraped product object, maps it, upserts it.
// // Returns the mapped row or null if SKU was missing.
// async function upsertOneProduct(product) {
//   const row = mapProduct(product);

//   if (!row || !row.SKU) {
//     console.log('   ⚠️  Could not map product — no SKU found');
//     return null;
//   }

//   const pool = await getSqlPool();

//   try {
//     await upsertCompetitorPrice(pool, row);
//     console.log(`   ✅ Upserted: ${row.SKU} | ${row.StoreName} | ₹${row.CompetitorPrice}`);
//     return row;
//   } finally {
//     await pool.close();
//   }
// }

// module.exports = {
//   mapProduct,
//   parsePrice,
//   cleanSku,
//   upsertOneProduct,
//   upsertManyFromCosmos,
// };
