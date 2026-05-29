// src/api_server.js
// Run: node src/api_server.js

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const sql      = require('mssql');
const { v4: uuidv4 } = require('uuid');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const { scrapeProduct }    = require('./scraper/scrapeProduct');
const { upsertOneProduct } = require('./services/competitorPriceService');
const { STORES }           = require('./urls');

const session        = require('express-session');
const { msalClient } = require('./auth/msalConfig');
const { requireAuth } = require('./auth/authMiddleware');

const app  = express();
const PORT = process.env.PORT || 8000;

app.use(cors({
  origin     : process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// ── Session middleware ────────────────────────────────────────
app.use(session({
  secret           : process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave           : false,
  saveUninitialized: false,
  cookie           : { secure: false }, // true in production (HTTPS)
}));

// ── GET /auth/login ───────────────────────────────────────────
app.get('/auth/login', async (req, res) => {
  const authCodeUrlParams = {
    scopes     : ['user.read'],
    redirectUri: process.env.REDIRECT_URI,
  };
  const authUrl = await msalClient.getAuthCodeUrl(authCodeUrlParams);
  res.redirect(authUrl);
});

// ── GET /callback ─────────────────────────────────────────────
app.get('/callback', async (req, res) => {
  const tokenRequest = {
    code       : req.query.code,
    scopes     : ['user.read'],
    redirectUri: process.env.REDIRECT_URI,
  };
  try {
    const response = await msalClient.acquireTokenByCode(tokenRequest);
    req.session.user = {
      name : response.account.name,
      email: response.account.username,
      role : 'sales',
    };
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.status(500).send('Login failed');
  }
});

// ── GET /auth/me ──────────────────────────────────────────────
app.get('/auth/me', (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true, user: req.session.user });
});

// ── POST /auth/logout ─────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

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

// ── Helper: find store config by product URL ──────────────────
function findStoreByUrl(productUrl) {
  const domainMap = {
    'primeabgb.com'        : 'primeabgb',
    'mdcomputers.in'       : 'mdcomputers',
    'pickpcparts.in'       : 'pickpcparts',
    'vedantcomputers.com'  : 'vedant',
    'vishalperipherals.com': 'vishal',
    'pcstudio.in'          : 'pcstudio',
  };
  for (const [domain, storeName] of Object.entries(domainMap)) {
    if (productUrl.includes(domain)) {
      return STORES.find(s => s.name === storeName) || null;
    }
  }
  return null;
}

// ── Helper: recalculate RecommendedSP for one SKU ────────────
async function recalculateRecommendedSP(pool, skuId) {
  const GST               = 0.18;
  const COST_OF_BUSINESS  = 0.07;
  const MIN_PROFIT_MARGIN = 0.05;

  const productResult = await pool.request()
    .input('SKU_ID', sql.NVarChar(100), skuId)
    .query(`SELECT PP FROM InternalProducts WHERE SKU_ID = @SKU_ID AND PP IS NOT NULL`);

  if (!productResult.recordset.length) return null;

  const pp = parseFloat(productResult.recordset[0].PP);

  const competitorResult = await pool.request()
    .input('SKU', sql.NVarChar(100), skuId)
    .query(`
      SELECT TOP 1 CompetitorPrice
      FROM CompetitorPrices
      WHERE SKU = @SKU
        AND CompetitorPrice IS NOT NULL
        AND LOWER(StockStatus) != 'out of stock'
      ORDER BY CompetitorPrice ASC
    `);

  if (!competitorResult.recordset.length) return null;

  const lowestCompetitorPrice = parseFloat(competitorResult.recordset[0].CompetitorPrice);
  const basePrice = parseFloat((pp * (1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN)).toFixed(2));

  let recommendedSP = basePrice;
  if (lowestCompetitorPrice > basePrice) {
    const target = parseFloat((lowestCompetitorPrice * 0.99).toFixed(2));
    if (target > basePrice) recommendedSP = target;
  }

  await pool.request()
    .input('SKU_ID',        sql.NVarChar(100),  skuId)
    .input('RecommendedSP', sql.Decimal(10, 2), recommendedSP)
    .query(`
      UPDATE InternalProducts
      SET RecommendedSP = @RecommendedSP, RecommendedSPUpdatedAt = GETDATE()
      WHERE SKU_ID = @SKU_ID
    `);

  return recommendedSP;
}


// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

// ── GET /api/recommendations ──────────────────────────────────
app.get('/api/recommendations', async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT
        i.SKU_ID,
        i.Title,
        i.PP,
        i.SP,
        i.RecommendedSP,
        i.Category,
        ROUND(
          ((i.RecommendedSP - (i.PP * 1.30)) / (i.PP * 1.30)) * 100,
          2
        ) AS ExtraProfitPct,
        c.CompetitorPrice,
        c.ProductURL   AS CompetitorURL,
        c.StoreName,
        c.StockStatus  AS CompetitorStockStatus
      FROM InternalProducts i
      INNER JOIN (
        SELECT SKU, CompetitorPrice, ProductURL, StoreName, StockStatus,
          ROW_NUMBER() OVER (PARTITION BY SKU ORDER BY CompetitorPrice ASC) AS rn
        FROM CompetitorPrices
        WHERE CompetitorPrice IS NOT NULL
          AND LOWER(StockStatus) != 'out of stock'
      ) c ON c.SKU = i.SKU_ID AND c.rn = 1
      WHERE i.PP IS NOT NULL AND i.isActive = 1
        AND i.isInStock = 1 AND i.RecommendedSP IS NOT NULL
      ORDER BY i.SKU_ID
    `);
    console.log(`✅ /api/recommendations — ${result.recordset.length} rows served`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ API error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── POST /api/refresh-product ─────────────────────────────────
app.post('/api/refresh-product', async (req, res) => {
  const { competitorUrl, skuId } = req.body;
  if (!competitorUrl || !skuId) {
    return res.status(400).json({ success: false, error: 'Both competitorUrl and skuId are required' });
  }
  console.log(`\n🔄 Manual refresh: SKU=${skuId} | URL=${competitorUrl}`);

  const store = findStoreByUrl(competitorUrl);
  if (!store) {
    return res.status(400).json({
      success: false,
      error: 'Unknown store URL. Supported: primeabgb, mdcomputers, pickpcparts, vedant, vishal, pcstudio',
    });
  }
  console.log(`   Store identified: ${store.name}`);

  let pool;
  try {
    console.log(`   Scraping: ${competitorUrl}`);
    const product = await scrapeProduct(store, competitorUrl);
    if (!product || !product.name) {
      return res.status(422).json({ success: false, error: 'Scraping succeeded but no product data found' });
    }
    console.log(`   Scraped: ${product.name}`);

    const upserted = await upsertOneProduct(product);
    if (!upserted) {
      return res.status(422).json({ success: false, error: 'Product scraped but SKU could not be mapped' });
    }

    pool = await getSqlPool();
    const newRecommendedSP = await recalculateRecommendedSP(pool, skuId);

    const refreshedBy = req.headers['x-user-email'] || 'manual';
    const refreshedAt = new Date().toISOString();

    await pool.request()
      .input('SKU_ID',              sql.NVarChar(100), skuId)
      .input('LastManualRefreshAt', sql.NVarChar(50),  refreshedAt)
      .input('LastManualRefreshBy', sql.NVarChar(100), refreshedBy)
      .query(`
        UPDATE InternalProducts
        SET LastManualRefreshAt = @LastManualRefreshAt,
            LastManualRefreshBy = @LastManualRefreshBy
        WHERE SKU_ID = @SKU_ID
      `);

    console.log(`   ✅ Done — RecommendedSP: ₹${newRecommendedSP} | RefreshedBy: ${refreshedBy}`);
    res.json({
      success: true, skuId, storeName: store.name, productName: product.name,
      newCompetitorPrice: upserted.CompetitorPrice, newRecommendedSP, refreshedAt, refreshedBy,
    });
  } catch (err) {
    console.error(`❌ Manual refresh failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/competitor-details/:skuId ───────────────────────
app.get('/api/competitor-details/:skuId', async (req, res) => {
  const { skuId } = req.params;
  if (!skuId) return res.status(400).json({ success: false, error: 'skuId is required' });

  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('SKU', sql.NVarChar(100), skuId)
      .query(`
        SELECT TOP 4 CompetitorPrice, ProductURL, StoreName, StockStatus
        FROM CompetitorPrices
        WHERE SKU = @SKU AND CompetitorPrice IS NOT NULL
          AND LOWER(StockStatus) != 'out of stock'
        ORDER BY CompetitorPrice ASC
      `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error(`❌ /api/competitor-details/${skuId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/pp-products ──────────────────────────────────────
app.get('/api/pp-products', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT
        SKU_ID, Title, Category, Brand, PP,
        LastBillDate, ManualPP_UpdatedAt, ManualPP_UpdatedBy,
        CASE
          WHEN ManualPP_UpdatedAt IS NOT NULL AND LastBillDate IS NOT NULL
           AND ManualPP_UpdatedAt >= CAST(LastBillDate AS DATETIME2) THEN 'manual'
          WHEN ManualPP_UpdatedAt IS NOT NULL AND LastBillDate IS NULL THEN 'manual'
          ELSE 'bill'
        END AS PPSource
      FROM InternalProducts
      WHERE isActive = 1
      ORDER BY Category, Title
    `);
    console.log(`✅ /api/pp-products — ${result.recordset.length} rows`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ /api/pp-products error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── PATCH /api/update-pp ──────────────────────────────────────
app.patch('/api/update-pp', requireAuth, async (req, res) => {
  const { skuId, newPP } = req.body;
  if (!skuId || newPP == null) {
    return res.status(400).json({ success: false, error: 'skuId and newPP are required' });
  }
  const parsedPP = parseFloat(newPP);
  if (isNaN(parsedPP) || parsedPP <= 0) {
    return res.status(400).json({ success: false, error: 'newPP must be a positive number' });
  }

  const updatedBy = req.session?.user?.email || 'unknown';
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('SKU_ID',             sql.NVarChar(100),  skuId)
      .input('PP',                 sql.Decimal(10, 2), parsedPP)
      .input('ManualPP_UpdatedBy', sql.NVarChar(150),  updatedBy)
      .query(`
        UPDATE InternalProducts
        SET PP = @PP, ManualPP_UpdatedAt = GETDATE(), ManualPP_UpdatedBy = @ManualPP_UpdatedBy
        WHERE SKU_ID = @SKU_ID;

        SELECT SKU_ID, PP, ManualPP_UpdatedAt, ManualPP_UpdatedBy, LastBillDate
        FROM InternalProducts WHERE SKU_ID = @SKU_ID;
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }
    console.log(`✅ PP updated: SKU=${skuId} | PP=₹${parsedPP} | By=${updatedBy}`);
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error(`❌ /api/update-pp error for ${skuId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/pp-template-csv ──────────────────────────────────
// Returns a blank CSV template — just headers SKU,PP
app.get('/api/pp-template-csv', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="pp_update_template.csv"');
  res.send('SKU,PP\n');
});


// ── POST /api/validate-skus ───────────────────────────────────
// UPDATED: now returns currentPP alongside each matched SKU
// so the frontend can show ±% change warning in the preview.
//
// Body:    { skus: string[] }
// Returns: { valid: [{ sku, currentPP }], notFound: string[] }

app.post('/api/validate-skus', requireAuth, async (req, res) => {
  const { skus } = req.body;

  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ success: false, error: 'skus must be a non-empty array' });
  }
  if (skus.length > 2000) {
    return res.status(400).json({
      success: false,
      error: `Too many SKUs (${skus.length}). Maximum 2000 rows per upload.`,
    });
  }

  let pool;
  try {
    pool = await getSqlPool();

    // Build parameterized IN clause — fetch SKU_ID + current PP in one query
    const request    = pool.request();
    const paramNames = skus.map((sku, i) => {
      request.input(`sku${i}`, sql.NVarChar(100), sku);
      return `@sku${i}`;
    });

    const result = await request.query(`
      SELECT SKU_ID, PP
      FROM InternalProducts
      WHERE SKU_ID IN (${paramNames.join(',')})
    `);

    // Map: SKU_ID → currentPP
    const foundMap = new Map();
    for (const row of result.recordset) {
      foundMap.set(row.SKU_ID, row.PP != null ? parseFloat(row.PP) : null);
    }

    const valid    = [];
    const notFound = [];

    for (const sku of skus) {
      if (foundMap.has(sku)) {
        valid.push({ sku, currentPP: foundMap.get(sku) });
      } else {
        notFound.push(sku);
      }
    }

    console.log(`✅ /api/validate-skus — ${skus.length} checked | ${notFound.length} not found`);
    res.json({ valid, notFound });

  } catch (err) {
    console.error('❌ /api/validate-skus error:', err.message, err.stack);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── POST /api/bulk-update-pp ──────────────────────────────────
// UPDATED: now accepts unidentified rows, saves a BulkUploadSession
// record, and logs unidentified SKUs to UnIdentifiedProducts table.
//
// Body: {
//   rows:         [{ skuId, newPP }],   — valid matched rows
//   unidentified: [{ sku, pp }],        — SKUs not found in DB
//   fileName:     string                — original CSV filename
// }
// Returns: { sessionId, updated, unidentifiedCount, updatedBy, updatedAt }

app.post('/api/bulk-update-pp', requireAuth, async (req, res) => {
  const { rows = [], unidentified = [], fileName = '' } = req.body;

  if (rows.length === 0 && unidentified.length === 0) {
    return res.status(400).json({ success: false, error: 'Nothing to process' });
  }
  if (rows.length > 2000) {
    return res.status(400).json({
      success: false,
      error: `Too many rows (${rows.length}). Maximum 2000 per upload.`,
    });
  }

  for (const row of rows) {
    if (!row.skuId || typeof row.skuId !== 'string') {
      return res.status(400).json({ success: false, error: 'Each row must have a skuId string' });
    }
    const pp = parseFloat(row.newPP);
    if (isNaN(pp) || pp <= 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid PP for SKU "${row.skuId}": must be a positive number`,
      });
    }
  }

  const updatedBy = req.session?.user?.email || 'unknown';
  const updatedAt = new Date().toISOString();
  const sessionId = uuidv4();

  let pool;
  try {
    pool = await getSqlPool();

    // ── Step 1: Update valid PP rows ──────────────────────────
    let updated = 0;
    for (const row of rows) {
      const result = await pool.request()
        .input('SKU_ID',    sql.NVarChar(100),  row.skuId)
        .input('PP',        sql.Decimal(10, 2), parseFloat(row.newPP))
        .input('UpdatedBy', sql.NVarChar(150),  updatedBy)
        .query(`
          UPDATE InternalProducts
          SET PP = @PP, ManualPP_UpdatedAt = GETDATE(), ManualPP_UpdatedBy = @UpdatedBy
          WHERE SKU_ID = @SKU_ID
        `);
      if (result.rowsAffected[0] > 0) updated++;
    }

    // ── Step 2: Save BulkUploadSession record ─────────────────
    await pool.request()
      .input('SessionID',         sql.NVarChar(36),  sessionId)
      .input('UploadedBy',        sql.NVarChar(150), updatedBy)
      .input('TotalRowsInCSV',    sql.Int,           rows.length + unidentified.length)
      .input('UpdatedCount',      sql.Int,           updated)
      .input('UnidentifiedCount', sql.Int,           unidentified.length)
      .input('FileName',          sql.NVarChar(500), fileName || '')
      .query(`
        INSERT INTO BulkUploadSessions
          (SessionID, UploadedBy, TotalRowsInCSV, UpdatedCount, UnidentifiedCount, FileName)
        VALUES
          (@SessionID, @UploadedBy, @TotalRowsInCSV, @UpdatedCount, @UnidentifiedCount, @FileName)
      `);

    // ── Step 3: Save UnIdentifiedProducts rows ────────────────
    if (unidentified.length > 0) {
      const BATCH = 50;
      for (let i = 0; i < unidentified.length; i += BATCH) {
        const batch  = unidentified.slice(i, i + BATCH);
        const req2   = pool.request();
        const values = batch.map((row, idx) => {
          const n = i + idx;
          req2.input(`sid${n}`,  sql.NVarChar(36),   sessionId);
          req2.input(`usku${n}`, sql.NVarChar(100),  row.sku ?? '');
          req2.input(`upp${n}`,  sql.Decimal(10, 2), row.pp  ?? null);
          req2.input(`uby${n}`,  sql.NVarChar(150),  updatedBy);
          return `(@sid${n}, @usku${n}, @upp${n}, GETDATE(), @uby${n})`;
        });
        await req2.query(`
          INSERT INTO UnIdentifiedProducts (SessionID, SKU, PP, UploadedAt, UploadedBy)
          VALUES ${values.join(',')}
        `);
      }
    }

    console.log(`✅ /api/bulk-update-pp — session=${sessionId} | updated=${updated} | unidentified=${unidentified.length} | by=${updatedBy}`);

    res.json({
      success: true,
      data: { sessionId, updated, unidentifiedCount: unidentified.length, updatedBy, updatedAt },
    });

  } catch (err) {
    console.error('❌ /api/bulk-update-pp error:', err.message, err.stack);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/bulk-upload-history ──────────────────────────────
// Returns list of all past bulk upload sessions, newest first.

app.get('/api/bulk-upload-history', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT TOP 100
        SessionID, UploadedAt, UploadedBy,
        TotalRowsInCSV, UpdatedCount, UnidentifiedCount, FileName
      FROM BulkUploadSessions
      ORDER BY UploadedAt DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ /api/bulk-upload-history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/bulk-upload-session/:sessionId/unidentified ──────
// Returns unidentified SKUs for a specific session.

app.get('/api/bulk-upload-session/:sessionId/unidentified', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('SessionID', sql.NVarChar(36), sessionId)
      .query(`
        SELECT SKU, PP, UploadedAt, UploadedBy
        FROM UnIdentifiedProducts
        WHERE SessionID = @SessionID
        ORDER BY SKU
      `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error(`❌ /api/bulk-upload-session/${sessionId}/unidentified:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/bulk-upload-session/:sessionId/export ────────────
// Downloads unidentified SKUs for a session as CSV.

app.get('/api/bulk-upload-session/:sessionId/export', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  let pool;
  try {
    pool = await getSqlPool();

    const sessionResult = await pool.request()
      .input('SessionID', sql.NVarChar(36), sessionId)
      .query(`SELECT UploadedAt FROM BulkUploadSessions WHERE SessionID = @SessionID`);

    const rowsResult = await pool.request()
      .input('SessionID', sql.NVarChar(36), sessionId)
      .query(`
        SELECT SKU, PP, UploadedAt, UploadedBy
        FROM UnIdentifiedProducts
        WHERE SessionID = @SessionID
        ORDER BY SKU
      `);

    const lines = ['SKU,PP,UploadedAt,UploadedBy'];
    for (const row of rowsResult.recordset) {
      const uploadedAt = row.UploadedAt ? new Date(row.UploadedAt).toISOString() : '';
      lines.push(`${row.SKU},${row.PP ?? ''},${uploadedAt},${row.UploadedBy}`);
    }

    const sessionDate = sessionResult.recordset[0]?.UploadedAt
      ? new Date(sessionResult.recordset[0].UploadedAt).toISOString().slice(0, 10)
      : 'unknown';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="unidentified_skus_${sessionDate}.csv"`);
    res.send(lines.join('\n'));

  } catch (err) {
    console.error(`❌ /api/bulk-upload-session/${sessionId}/export:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/health ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


app.listen(PORT, () => {
  console.log(`🚀 API server running at http://localhost:${PORT}`);
  console.log(`   GET  http://localhost:${PORT}/api/recommendations`);
  console.log(`   POST http://localhost:${PORT}/api/refresh-product`);
  console.log(`   GET  http://localhost:${PORT}/api/health`);
});