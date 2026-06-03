// src/api_server.js
// Run: node src/api_server.js

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const sql      = require('mssql');
const { v4: uuidv4 } = require('uuid');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const {
  loadCategorySettings,
  loadInternalProducts,
  loadCompetitorPrices,
  buildCompetitorMap,
  generateRecommendations,
  updateRecommendedSP,
} = require('./recommendation_engine');

const { scrapeProduct }    = require('./scraper/scrapeProduct');
const { upsertOneProduct } = require('./services/competitorPriceService');
const { STORES }           = require('./urls');

const session        = require('express-session');
const { msalClient } = require('./auth/msalConfig');
const { requireAuth } = require('./auth/authMiddleware');
const { requireRole } = require('./auth/authMiddleware');

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

app.get('/callback', async (req, res) => {
  const tokenRequest = {
    code       : req.query.code,
    scopes     : ['user.read'],
    redirectUri: process.env.REDIRECT_URI,
  };
  try {
    const response = await msalClient.acquireTokenByCode(tokenRequest);
    const email = response.account.username.toLowerCase();

    // Look up role in custom table
    const pool = await getSqlPool();
    const roleResult = await pool.request()
      .input('Email', sql.NVarChar(255), email)
      .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);
    await pool.close();

    if (!roleResult.recordset.length) {
      return res.status(403).send(`
        <h2>Access denied</h2>
        <p>${email} is not in the system. Ask an admin to add your account.</p>
      `);
    }

    req.session.user = {
      name : response.account.name,
      email: email,
      role : roleResult.recordset[0].Role,   // 'admin' | 'supervisor' | 'sales'
    };
    res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.status(500).send('Login failed');
  }
});

// ── GET /auth/me ──────────────────────────────────────────────
app.get('/auth/me', async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ authenticated: false });
  }

  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('Email', sql.NVarChar(255), req.session.user.email)
      .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);

    if (!result.recordset.length) {
      // User was removed from the table while session was active
      req.session.destroy();
      return res.status(401).json({ authenticated: false });
    }

    const freshRole = result.recordset[0].Role;

    // Keep session in sync so middleware also sees the latest role
    req.session.user.role = freshRole;

    res.json({
      authenticated: true,
      user: {
        name : req.session.user.name,
        email: req.session.user.email,
        role : freshRole,
      },
    });
  } catch (err) {
    // DB unreachable — fall back to cached session role rather than logging user out
    console.error('❌ /auth/me role refresh failed:', err.message);
    res.json({
      authenticated: true,
      user: req.session.user,
    });
  } finally {
    if (pool) await pool.close();
  }
});

// ── POST /auth/logout ─────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});


// ── SQL connection with token cache ──────────────────────────
// AzureCliCredential.getToken() runs `az account get-access-token`
// as a subprocess — very slow (~10-20s) on every call without caching.
// Cache the token and only refresh when it expires (within 5 min buffer).
let _cachedToken    = null;
let _tokenExpiresAt = 0;

async function getSqlPool() {
  const now = Date.now();

  // Refresh token if missing or expiring within 5 minutes
  if (!_cachedToken || now >= _tokenExpiresAt - 5 * 60 * 1000) {
    const credential = process.env.AZURE_ENV === 'production'
      ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
      : new AzureCliCredential();

    const tokenResponse = await credential.getToken(
      'https://database.windows.net/.default'
    );

    _cachedToken    = tokenResponse.token;
    // expiresOnTimestamp is in ms; fall back to 55 min if not provided
    _tokenExpiresAt = tokenResponse.expiresOnTimestamp ?? (now + 55 * 60 * 1000);
    console.log('🔑 Azure token refreshed');
  }

  return await sql.connect({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: {
      type   : 'azure-active-directory-access-token',
      options: { token: _cachedToken },
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
app.get('/api/pp-template-csv', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="pp_update_template.csv"');
  res.send('SKU,PP\n');
});


// ── POST /api/validate-skus ───────────────────────────────────
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


// ── GET /api/category-settings ────────────────────────────────
app.get('/api/category-settings', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT
        CategoryName,
        GST,
        CostOfBusiness,
        ProfitMargin,
        ScrapFreqDays,
        IsScrapEnabled,
        UpdatedAt,
        UpdatedBy
      FROM CategorySettings
      ORDER BY CategoryName
    `);
    console.log(`✅ /api/category-settings — ${result.recordset.length} rows`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ /api/category-settings error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── PUT /api/category-settings/:category ─────────────────────
app.put('/api/category-settings/:category', requireAuth, async (req, res) => {
  const categoryName = decodeURIComponent(req.params.category);
  const { GST, CostOfBusiness, ProfitMargin, ScrapFreqDays, IsScrapEnabled } = req.body;
  const updatedBy = req.session?.user?.email || 'unknown';

  if (GST !== undefined && GST !== null) {
    const v = parseFloat(GST);
    if (isNaN(v) || v < 0 || v > 100) {
      return res.status(400).json({ success: false, error: 'GST must be between 0 and 100' });
    }
  }
  if (CostOfBusiness !== undefined && CostOfBusiness !== null) {
    const v = parseFloat(CostOfBusiness);
    if (isNaN(v) || v < 0 || v > 100) {
      return res.status(400).json({ success: false, error: 'CostOfBusiness must be between 0 and 100' });
    }
  }
  if (ProfitMargin !== undefined && ProfitMargin !== null) {
    const v = parseFloat(ProfitMargin);
    if (isNaN(v) || v < 0 || v > 100) {
      return res.status(400).json({ success: false, error: 'ProfitMargin must be between 0 and 100' });
    }
  }
  if (ScrapFreqDays !== undefined && ScrapFreqDays !== null) {
    const v = parseInt(ScrapFreqDays);
    if (isNaN(v) || v < 1 || v > 365) {
      return res.status(400).json({ success: false, error: 'ScrapFreqDays must be between 1 and 365' });
    }
  }

  let pool;
  try {
    pool = await getSqlPool();

    const result = await pool.request()
      .input('CategoryName',    sql.NVarChar(200),  categoryName)
      .input('GST',             sql.Decimal(5, 2),  GST            ?? null)
      .input('CostOfBusiness',  sql.Decimal(5, 2),  CostOfBusiness ?? null)
      .input('ProfitMargin',    sql.Decimal(5, 2),  ProfitMargin   ?? null)
      .input('ScrapFreqDays',   sql.Int,             ScrapFreqDays  ?? 7)
      .input('IsScrapEnabled',  sql.Bit,             IsScrapEnabled ?? 1)
      .input('UpdatedBy',       sql.NVarChar(150),   updatedBy)
      .query(`
        MERGE CategorySettings AS target
        USING (SELECT @CategoryName AS CategoryName) AS source
          ON target.CategoryName = source.CategoryName

        WHEN MATCHED THEN
          UPDATE SET
            GST            = @GST,
            CostOfBusiness = @CostOfBusiness,
            ProfitMargin   = @ProfitMargin,
            ScrapFreqDays  = @ScrapFreqDays,
            IsScrapEnabled = @IsScrapEnabled,
            UpdatedAt      = GETDATE(),
            UpdatedBy      = @UpdatedBy

        WHEN NOT MATCHED THEN
          INSERT (CategoryName, GST, CostOfBusiness, ProfitMargin,
                  ScrapFreqDays, IsScrapEnabled, UpdatedAt, UpdatedBy)
          VALUES (@CategoryName, @GST, @CostOfBusiness, @ProfitMargin,
                  @ScrapFreqDays, @IsScrapEnabled, GETDATE(), @UpdatedBy);

        SELECT CategoryName, GST, CostOfBusiness, ProfitMargin,
               ScrapFreqDays, IsScrapEnabled, UpdatedAt, UpdatedBy
        FROM CategorySettings
        WHERE CategoryName = @CategoryName;
      `);

    console.log(`✅ /api/category-settings/${categoryName} — updated by ${updatedBy}`);
    res.json({ success: true, data: result.recordset[0] });

  } catch (err) {
    console.error(`❌ /api/category-settings/${categoryName} error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/users ────────────────────────────────────────────
app.get('/api/users', requireRole('admin'), async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT Email, Role, AddedBy, AddedAt, UpdatedBy, UpdatedAt
      FROM UserRoles
      ORDER BY AddedAt DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ /api/users GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── POST /api/users ───────────────────────────────────────────
app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) {
    return res.status(400).json({ success: false, error: 'email and role are required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const validRoles = ['admin', 'supervisor', 'sales'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ success: false, error: `role must be one of: ${validRoles.join(', ')}` });
  }

  const addedBy = req.session.user.email;
  let pool;
  try {
    pool = await getSqlPool();
    await pool.request()
      .input('Email',   sql.NVarChar(255), normalizedEmail)
      .input('Role',    sql.NVarChar(50),  role)
      .input('AddedBy', sql.NVarChar(255), addedBy)
      .query(`
        MERGE UserRoles AS target
        USING (SELECT @Email AS Email) AS source
          ON target.Email = source.Email
        WHEN MATCHED THEN
          UPDATE SET
            Role      = @Role,
            UpdatedBy = @AddedBy,
            UpdatedAt = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (Email, Role, AddedBy)
          VALUES (@Email, @Role, @AddedBy);
      `);

    console.log(`✅ /api/users — upserted: ${normalizedEmail} as ${role} by ${addedBy}`);
    res.json({ success: true, data: { email: normalizedEmail, role } });
  } catch (err) {
    console.error('❌ /api/users POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── DELETE /api/users/:email ──────────────────────────────────
app.delete('/api/users/:email', requireRole('admin'), async (req, res) => {
  const targetEmail = decodeURIComponent(req.params.email).toLowerCase();
  const selfEmail   = req.session.user.email;

  if (targetEmail === selfEmail) {
    return res.status(400).json({ success: false, error: 'You cannot remove yourself' });
  }

  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('Email', sql.NVarChar(255), targetEmail)
      .query(`DELETE FROM UserRoles WHERE Email = @Email`);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    console.log(`✅ /api/users DELETE — removed: ${targetEmail} by ${selfEmail}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`❌ /api/users DELETE error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── POST /api/run-recommendation-engine ───────────────────────
// Triggers recommendation engine on demand.
// Returns jobId immediately; frontend polls for status.
//
// FIX: removed duplicate require() inside the IIFE — functions are
// already imported at the top of this file.
// FIX: getSqlPool() now uses a token cache so the second+ calls are
// fast (no subprocess re-authentication).

const activeJobs = new Map(); // jobId → { status, startedAt, startedBy, updatedCount, error, finishedAt }

app.post('/api/run-recommendation-engine', requireAuth, async (req, res) => {
  const id         = uuidv4();
  const startedBy  = req.session?.user?.email || 'unknown';

  // Prevent two simultaneous runs
  const alreadyRunning = [...activeJobs.values()].find(j => j.status === 'running');
  if (alreadyRunning) {
    return res.status(409).json({
      success: false,
      error  : 'Recommendation engine is already running. Wait for it to finish.'
    });
  }

  activeJobs.set(id, {
    status    : 'running',
    startedAt : new Date().toISOString(),
    startedBy,
    updatedCount: null,
    error     : null,
    finishedAt: null,
  });

  console.log(`🚀 Recommendation engine triggered by ${startedBy} | job=${id}`);

  // Fire and forget — returns jobId immediately to the client
  (async () => {
    const job = activeJobs.get(id);
    try {
      // Uses api_server's getSqlPool (with token cache) — fast after first call
      const pool = await getSqlPool();

      const categorySettings = await loadCategorySettings(pool);
      const internalProducts = await loadInternalProducts(pool);
      const competitorRows   = await loadCompetitorPrices(pool);
      const competitorMap    = buildCompetitorMap(competitorRows);
      const recommendations  = generateRecommendations(internalProducts, competitorMap, categorySettings);
      await updateRecommendedSP(pool, recommendations);
      await pool.close();

      job.status       = 'done';
      job.updatedCount = recommendations.length;
      job.finishedAt   = new Date().toISOString();
      console.log(`✅ Recommendation engine done | job=${id} | updated=${recommendations.length}`);

    } catch (err) {
      job.status     = 'error';
      job.error      = err.message;
      job.finishedAt = new Date().toISOString();
      console.error(`❌ Recommendation engine failed | job=${id}:`, err.message);
    }
  })();

  // Return jobId so client can poll
  res.json({ success: true, jobId: id });
});


// ── GET /api/recommendation-job/:jobId ────────────────────────
app.get('/api/recommendation-job/:jobId', requireAuth, (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: job });
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

































// // src/api_server.js
// // Run: node src/api_server.js

// require('dotenv').config();
// const express  = require('express');
// const cors     = require('cors');
// const sql      = require('mssql');
// const { v4: uuidv4 } = require('uuid');
// const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');


// const {
//   loadCategorySettings,
//   loadInternalProducts,
//   loadCompetitorPrices,
//   buildCompetitorMap,
//   generateRecommendations,
//   updateRecommendedSP,
// } = require('./recommendation_engine');


// const { scrapeProduct }    = require('./scraper/scrapeProduct');
// const { upsertOneProduct } = require('./services/competitorPriceService');
// const { STORES }           = require('./urls');

// const session        = require('express-session');
// const { msalClient } = require('./auth/msalConfig');
// const { requireAuth } = require('./auth/authMiddleware');
// const { requireRole } = require('./auth/authMiddleware')

// const app  = express();
// const PORT = process.env.PORT || 8000;

// app.use(cors({
//   origin     : process.env.FRONTEND_URL || 'http://localhost:5173',
//   credentials: true,
// }));
// app.use(express.json());

// // ── Session middleware ────────────────────────────────────────
// app.use(session({
//   secret           : process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
//   resave           : false,
//   saveUninitialized: false,
//   cookie           : { secure: false }, // true in production (HTTPS)
// }));

// // ── GET /auth/login ───────────────────────────────────────────
// app.get('/auth/login', async (req, res) => {
//   const authCodeUrlParams = {
//     scopes     : ['user.read'],
//     redirectUri: process.env.REDIRECT_URI,
//   };
//   const authUrl = await msalClient.getAuthCodeUrl(authCodeUrlParams);
//   res.redirect(authUrl);
// });





// app.get('/callback', async (req, res) => {
//   const tokenRequest = {
//     code       : req.query.code,
//     scopes     : ['user.read'],
//     redirectUri: process.env.REDIRECT_URI,
//   };
//   try {
//     const response = await msalClient.acquireTokenByCode(tokenRequest);
//     const email = response.account.username.toLowerCase();

//     // Look up role in custom table
//     const pool = await getSqlPool();
//     const roleResult = await pool.request()
//       .input('Email', sql.NVarChar(255), email)
//       .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);
//     await pool.close();

//     if (!roleResult.recordset.length) {
//       return res.status(403).send(`
//         <h2>Access denied</h2>
//         <p>${email} is not in the system. Ask an admin to add your account.</p>
//       `);
//     }

//     req.session.user = {
//       name : response.account.name,
//       email: email,
//       role : roleResult.recordset[0].Role,   // 'admin' | 'supervisor' | 'sales'
//     };
//     res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');
//   } catch (err) {
//     console.error('Auth callback error:', err.message);
//     res.status(500).send('Login failed');
//   }
// });






// // ── GET /auth/me ──────────────────────────────────────────────
// app.get('/auth/me', async (req, res) => {
//   if (!req.session?.user) {
//     return res.status(401).json({ authenticated: false });
//   }

//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request()
//       .input('Email', sql.NVarChar(255), req.session.user.email)
//       .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);

//     if (!result.recordset.length) {
//       // User was removed from the table while session was active
//       req.session.destroy();
//       return res.status(401).json({ authenticated: false });
//     }

//     const freshRole = result.recordset[0].Role;

//     // Keep session in sync so middleware also sees the latest role
//     req.session.user.role = freshRole;

//     res.json({
//       authenticated: true,
//       user: {
//         name : req.session.user.name,
//         email: req.session.user.email,
//         role : freshRole,
//       },
//     });
//   } catch (err) {
//     // DB unreachable — fall back to cached session role rather than logging user out
//     console.error('❌ /auth/me role refresh failed:', err.message);
//     res.json({
//       authenticated: true,
//       user: req.session.user,
//     });
//   } finally {
//     if (pool) await pool.close();
//   }
// });



// // ── POST /auth/logout ─────────────────────────────────────────
// app.post('/auth/logout', (req, res) => {
//   req.session.destroy();
//   res.json({ success: true });
// });



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

// // ── Helper: find store config by product URL ──────────────────
// function findStoreByUrl(productUrl) {
//   const domainMap = {
//     'primeabgb.com'        : 'primeabgb',
//     'mdcomputers.in'       : 'mdcomputers',
//     'pickpcparts.in'       : 'pickpcparts',
//     'vedantcomputers.com'  : 'vedant',
//     'vishalperipherals.com': 'vishal',
//     'pcstudio.in'          : 'pcstudio',
//   };
//   for (const [domain, storeName] of Object.entries(domainMap)) {
//     if (productUrl.includes(domain)) {
//       return STORES.find(s => s.name === storeName) || null;
//     }
//   }
//   return null;
// }

// // ── Helper: recalculate RecommendedSP for one SKU ────────────
// async function recalculateRecommendedSP(pool, skuId) {
//   const GST               = 0.18;
//   const COST_OF_BUSINESS  = 0.07;
//   const MIN_PROFIT_MARGIN = 0.05;

//   const productResult = await pool.request()
//     .input('SKU_ID', sql.NVarChar(100), skuId)
//     .query(`SELECT PP FROM InternalProducts WHERE SKU_ID = @SKU_ID AND PP IS NOT NULL`);

//   if (!productResult.recordset.length) return null;

//   const pp = parseFloat(productResult.recordset[0].PP);

//   const competitorResult = await pool.request()
//     .input('SKU', sql.NVarChar(100), skuId)
//     .query(`
//       SELECT TOP 1 CompetitorPrice
//       FROM CompetitorPrices
//       WHERE SKU = @SKU
//         AND CompetitorPrice IS NOT NULL
//         AND LOWER(StockStatus) != 'out of stock'
//       ORDER BY CompetitorPrice ASC
//     `);

//   if (!competitorResult.recordset.length) return null;

//   const lowestCompetitorPrice = parseFloat(competitorResult.recordset[0].CompetitorPrice);
//   const basePrice = parseFloat((pp * (1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN)).toFixed(2));

//   let recommendedSP = basePrice;
//   if (lowestCompetitorPrice > basePrice) {
//     const target = parseFloat((lowestCompetitorPrice * 0.99).toFixed(2));
//     if (target > basePrice) recommendedSP = target;
//   }

//   await pool.request()
//     .input('SKU_ID',        sql.NVarChar(100),  skuId)
//     .input('RecommendedSP', sql.Decimal(10, 2), recommendedSP)
//     .query(`
//       UPDATE InternalProducts
//       SET RecommendedSP = @RecommendedSP, RecommendedSPUpdatedAt = GETDATE()
//       WHERE SKU_ID = @SKU_ID
//     `);

//   return recommendedSP;
// }


// // ─────────────────────────────────────────────────────────────
// // ROUTES
// // ─────────────────────────────────────────────────────────────

// // ── GET /api/recommendations ──────────────────────────────────
// app.get('/api/recommendations', async (req, res) => {
//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request().query(`
//       SELECT
//         i.SKU_ID,
//         i.Title,
//         i.PP,
//         i.SP,
//         i.RecommendedSP,
//         i.Category,
//         ROUND(
//           ((i.RecommendedSP - (i.PP * 1.30)) / (i.PP * 1.30)) * 100,
//           2
//         ) AS ExtraProfitPct,
//         c.CompetitorPrice,
//         c.ProductURL   AS CompetitorURL,
//         c.StoreName,
//         c.StockStatus  AS CompetitorStockStatus
//       FROM InternalProducts i
//       INNER JOIN (
//         SELECT SKU, CompetitorPrice, ProductURL, StoreName, StockStatus,
//           ROW_NUMBER() OVER (PARTITION BY SKU ORDER BY CompetitorPrice ASC) AS rn
//         FROM CompetitorPrices
//         WHERE CompetitorPrice IS NOT NULL
//           AND LOWER(StockStatus) != 'out of stock'
//       ) c ON c.SKU = i.SKU_ID AND c.rn = 1
//       WHERE i.PP IS NOT NULL AND i.isActive = 1
//         AND i.isInStock = 1 AND i.RecommendedSP IS NOT NULL
//       ORDER BY i.SKU_ID
//     `);
//     console.log(`✅ /api/recommendations — ${result.recordset.length} rows served`);
//     res.json({ success: true, data: result.recordset });
//   } catch (err) {
//     console.error('❌ API error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── POST /api/refresh-product ─────────────────────────────────
// app.post('/api/refresh-product', async (req, res) => {
//   const { competitorUrl, skuId } = req.body;
//   if (!competitorUrl || !skuId) {
//     return res.status(400).json({ success: false, error: 'Both competitorUrl and skuId are required' });
//   }
//   console.log(`\n🔄 Manual refresh: SKU=${skuId} | URL=${competitorUrl}`);

//   const store = findStoreByUrl(competitorUrl);
//   if (!store) {
//     return res.status(400).json({
//       success: false,
//       error: 'Unknown store URL. Supported: primeabgb, mdcomputers, pickpcparts, vedant, vishal, pcstudio',
//     });
//   }
//   console.log(`   Store identified: ${store.name}`);

//   let pool;
//   try {
//     console.log(`   Scraping: ${competitorUrl}`);
//     const product = await scrapeProduct(store, competitorUrl);
//     if (!product || !product.name) {
//       return res.status(422).json({ success: false, error: 'Scraping succeeded but no product data found' });
//     }
//     console.log(`   Scraped: ${product.name}`);

//     const upserted = await upsertOneProduct(product);
//     if (!upserted) {
//       return res.status(422).json({ success: false, error: 'Product scraped but SKU could not be mapped' });
//     }

//     pool = await getSqlPool();
//     const newRecommendedSP = await recalculateRecommendedSP(pool, skuId);

//     const refreshedBy = req.headers['x-user-email'] || 'manual';
//     const refreshedAt = new Date().toISOString();

//     await pool.request()
//       .input('SKU_ID',              sql.NVarChar(100), skuId)
//       .input('LastManualRefreshAt', sql.NVarChar(50),  refreshedAt)
//       .input('LastManualRefreshBy', sql.NVarChar(100), refreshedBy)
//       .query(`
//         UPDATE InternalProducts
//         SET LastManualRefreshAt = @LastManualRefreshAt,
//             LastManualRefreshBy = @LastManualRefreshBy
//         WHERE SKU_ID = @SKU_ID
//       `);

//     console.log(`   ✅ Done — RecommendedSP: ₹${newRecommendedSP} | RefreshedBy: ${refreshedBy}`);
//     res.json({
//       success: true, skuId, storeName: store.name, productName: product.name,
//       newCompetitorPrice: upserted.CompetitorPrice, newRecommendedSP, refreshedAt, refreshedBy,
//     });
//   } catch (err) {
//     console.error(`❌ Manual refresh failed: ${err.message}`);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── GET /api/competitor-details/:skuId ───────────────────────
// app.get('/api/competitor-details/:skuId', async (req, res) => {
//   const { skuId } = req.params;
//   if (!skuId) return res.status(400).json({ success: false, error: 'skuId is required' });

//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request()
//       .input('SKU', sql.NVarChar(100), skuId)
//       .query(`
//         SELECT TOP 4 CompetitorPrice, ProductURL, StoreName, StockStatus
//         FROM CompetitorPrices
//         WHERE SKU = @SKU AND CompetitorPrice IS NOT NULL
//           AND LOWER(StockStatus) != 'out of stock'
//         ORDER BY CompetitorPrice ASC
//       `);
//     res.json({ success: true, data: result.recordset });
//   } catch (err) {
//     console.error(`❌ /api/competitor-details/${skuId}:`, err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── GET /api/pp-products ──────────────────────────────────────
// app.get('/api/pp-products', requireAuth, async (req, res) => {
//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request().query(`
//       SELECT
//         SKU_ID, Title, Category, Brand, PP,
//         LastBillDate, ManualPP_UpdatedAt, ManualPP_UpdatedBy,
//         CASE
//           WHEN ManualPP_UpdatedAt IS NOT NULL AND LastBillDate IS NOT NULL
//            AND ManualPP_UpdatedAt >= CAST(LastBillDate AS DATETIME2) THEN 'manual'
//           WHEN ManualPP_UpdatedAt IS NOT NULL AND LastBillDate IS NULL THEN 'manual'
//           ELSE 'bill'
//         END AS PPSource
//       FROM InternalProducts
//       WHERE isActive = 1
//       ORDER BY Category, Title
//     `);
//     console.log(`✅ /api/pp-products — ${result.recordset.length} rows`);
//     res.json({ success: true, data: result.recordset });
//   } catch (err) {
//     console.error('❌ /api/pp-products error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── PATCH /api/update-pp ──────────────────────────────────────
// app.patch('/api/update-pp', requireAuth, async (req, res) => {
//   const { skuId, newPP } = req.body;
//   if (!skuId || newPP == null) {
//     return res.status(400).json({ success: false, error: 'skuId and newPP are required' });
//   }
//   const parsedPP = parseFloat(newPP);
//   if (isNaN(parsedPP) || parsedPP <= 0) {
//     return res.status(400).json({ success: false, error: 'newPP must be a positive number' });
//   }

//   const updatedBy = req.session?.user?.email || 'unknown';
//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request()
//       .input('SKU_ID',             sql.NVarChar(100),  skuId)
//       .input('PP',                 sql.Decimal(10, 2), parsedPP)
//       .input('ManualPP_UpdatedBy', sql.NVarChar(150),  updatedBy)
//       .query(`
//         UPDATE InternalProducts
//         SET PP = @PP, ManualPP_UpdatedAt = GETDATE(), ManualPP_UpdatedBy = @ManualPP_UpdatedBy
//         WHERE SKU_ID = @SKU_ID;

//         SELECT SKU_ID, PP, ManualPP_UpdatedAt, ManualPP_UpdatedBy, LastBillDate
//         FROM InternalProducts WHERE SKU_ID = @SKU_ID;
//       `);

//     if (!result.recordset.length) {
//       return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
//     }
//     console.log(`✅ PP updated: SKU=${skuId} | PP=₹${parsedPP} | By=${updatedBy}`);
//     res.json({ success: true, data: result.recordset[0] });
//   } catch (err) {
//     console.error(`❌ /api/update-pp error for ${skuId}:`, err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── GET /api/pp-template-csv ──────────────────────────────────
// // Returns a blank CSV template — just headers SKU,PP
// app.get('/api/pp-template-csv', requireAuth, (req, res) => {
//   res.setHeader('Content-Type', 'text/csv');
//   res.setHeader('Content-Disposition', 'attachment; filename="pp_update_template.csv"');
//   res.send('SKU,PP\n');
// });


// // ── POST /api/validate-skus ───────────────────────────────────
// // UPDATED: now returns currentPP alongside each matched SKU
// // so the frontend can show ±% change warning in the preview.
// //
// // Body:    { skus: string[] }
// // Returns: { valid: [{ sku, currentPP }], notFound: string[] }

// app.post('/api/validate-skus', requireAuth, async (req, res) => {
//   const { skus } = req.body;

//   if (!Array.isArray(skus) || skus.length === 0) {
//     return res.status(400).json({ success: false, error: 'skus must be a non-empty array' });
//   }
//   if (skus.length > 2000) {
//     return res.status(400).json({
//       success: false,
//       error: `Too many SKUs (${skus.length}). Maximum 2000 rows per upload.`,
//     });
//   }

//   let pool;
//   try {
//     pool = await getSqlPool();

//     // Build parameterized IN clause — fetch SKU_ID + current PP in one query
//     const request    = pool.request();
//     const paramNames = skus.map((sku, i) => {
//       request.input(`sku${i}`, sql.NVarChar(100), sku);
//       return `@sku${i}`;
//     });

//     const result = await request.query(`
//       SELECT SKU_ID, PP
//       FROM InternalProducts
//       WHERE SKU_ID IN (${paramNames.join(',')})
//     `);

//     // Map: SKU_ID → currentPP
//     const foundMap = new Map();
//     for (const row of result.recordset) {
//       foundMap.set(row.SKU_ID, row.PP != null ? parseFloat(row.PP) : null);
//     }

//     const valid    = [];
//     const notFound = [];

//     for (const sku of skus) {
//       if (foundMap.has(sku)) {
//         valid.push({ sku, currentPP: foundMap.get(sku) });
//       } else {
//         notFound.push(sku);
//       }
//     }

//     console.log(`✅ /api/validate-skus — ${skus.length} checked | ${notFound.length} not found`);
//     res.json({ valid, notFound });

//   } catch (err) {
//     console.error('❌ /api/validate-skus error:', err.message, err.stack);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── POST /api/bulk-update-pp ──────────────────────────────────
// // UPDATED: now accepts unidentified rows, saves a BulkUploadSession
// // record, and logs unidentified SKUs to UnIdentifiedProducts table.
// //
// // Body: {
// //   rows:         [{ skuId, newPP }],   — valid matched rows
// //   unidentified: [{ sku, pp }],        — SKUs not found in DB
// //   fileName:     string                — original CSV filename
// // }
// // Returns: { sessionId, updated, unidentifiedCount, updatedBy, updatedAt }

// app.post('/api/bulk-update-pp', requireAuth, async (req, res) => {
//   const { rows = [], unidentified = [], fileName = '' } = req.body;

//   if (rows.length === 0 && unidentified.length === 0) {
//     return res.status(400).json({ success: false, error: 'Nothing to process' });
//   }
//   if (rows.length > 2000) {
//     return res.status(400).json({
//       success: false,
//       error: `Too many rows (${rows.length}). Maximum 2000 per upload.`,
//     });
//   }

//   for (const row of rows) {
//     if (!row.skuId || typeof row.skuId !== 'string') {
//       return res.status(400).json({ success: false, error: 'Each row must have a skuId string' });
//     }
//     const pp = parseFloat(row.newPP);
//     if (isNaN(pp) || pp <= 0) {
//       return res.status(400).json({
//         success: false,
//         error: `Invalid PP for SKU "${row.skuId}": must be a positive number`,
//       });
//     }
//   }

//   const updatedBy = req.session?.user?.email || 'unknown';
//   const updatedAt = new Date().toISOString();
//   const sessionId = uuidv4();

//   let pool;
//   try {
//     pool = await getSqlPool();

//     // ── Step 1: Update valid PP rows ──────────────────────────
//     let updated = 0;
//     for (const row of rows) {
//       const result = await pool.request()
//         .input('SKU_ID',    sql.NVarChar(100),  row.skuId)
//         .input('PP',        sql.Decimal(10, 2), parseFloat(row.newPP))
//         .input('UpdatedBy', sql.NVarChar(150),  updatedBy)
//         .query(`
//           UPDATE InternalProducts
//           SET PP = @PP, ManualPP_UpdatedAt = GETDATE(), ManualPP_UpdatedBy = @UpdatedBy
//           WHERE SKU_ID = @SKU_ID
//         `);
//       if (result.rowsAffected[0] > 0) updated++;
//     }

//     // ── Step 2: Save BulkUploadSession record ─────────────────
//     await pool.request()
//       .input('SessionID',         sql.NVarChar(36),  sessionId)
//       .input('UploadedBy',        sql.NVarChar(150), updatedBy)
//       .input('TotalRowsInCSV',    sql.Int,           rows.length + unidentified.length)
//       .input('UpdatedCount',      sql.Int,           updated)
//       .input('UnidentifiedCount', sql.Int,           unidentified.length)
//       .input('FileName',          sql.NVarChar(500), fileName || '')
//       .query(`
//         INSERT INTO BulkUploadSessions
//           (SessionID, UploadedBy, TotalRowsInCSV, UpdatedCount, UnidentifiedCount, FileName)
//         VALUES
//           (@SessionID, @UploadedBy, @TotalRowsInCSV, @UpdatedCount, @UnidentifiedCount, @FileName)
//       `);

//     // ── Step 3: Save UnIdentifiedProducts rows ────────────────
//     if (unidentified.length > 0) {
//       const BATCH = 50;
//       for (let i = 0; i < unidentified.length; i += BATCH) {
//         const batch  = unidentified.slice(i, i + BATCH);
//         const req2   = pool.request();
//         const values = batch.map((row, idx) => {
//           const n = i + idx;
//           req2.input(`sid${n}`,  sql.NVarChar(36),   sessionId);
//           req2.input(`usku${n}`, sql.NVarChar(100),  row.sku ?? '');
//           req2.input(`upp${n}`,  sql.Decimal(10, 2), row.pp  ?? null);
//           req2.input(`uby${n}`,  sql.NVarChar(150),  updatedBy);
//           return `(@sid${n}, @usku${n}, @upp${n}, GETDATE(), @uby${n})`;
//         });
//         await req2.query(`
//           INSERT INTO UnIdentifiedProducts (SessionID, SKU, PP, UploadedAt, UploadedBy)
//           VALUES ${values.join(',')}
//         `);
//       }
//     }

//     console.log(`✅ /api/bulk-update-pp — session=${sessionId} | updated=${updated} | unidentified=${unidentified.length} | by=${updatedBy}`);

//     res.json({
//       success: true,
//       data: { sessionId, updated, unidentifiedCount: unidentified.length, updatedBy, updatedAt },
//     });

//   } catch (err) {
//     console.error('❌ /api/bulk-update-pp error:', err.message, err.stack);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── GET /api/bulk-upload-history ──────────────────────────────
// // Returns list of all past bulk upload sessions, newest first.

// app.get('/api/bulk-upload-history', requireAuth, async (req, res) => {
//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request().query(`
//       SELECT TOP 100
//         SessionID, UploadedAt, UploadedBy,
//         TotalRowsInCSV, UpdatedCount, UnidentifiedCount, FileName
//       FROM BulkUploadSessions
//       ORDER BY UploadedAt DESC
//     `);
//     res.json({ success: true, data: result.recordset });
//   } catch (err) {
//     console.error('❌ /api/bulk-upload-history error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── GET /api/bulk-upload-session/:sessionId/unidentified ──────
// // Returns unidentified SKUs for a specific session.

// app.get('/api/bulk-upload-session/:sessionId/unidentified', requireAuth, async (req, res) => {
//   const { sessionId } = req.params;
//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request()
//       .input('SessionID', sql.NVarChar(36), sessionId)
//       .query(`
//         SELECT SKU, PP, UploadedAt, UploadedBy
//         FROM UnIdentifiedProducts
//         WHERE SessionID = @SessionID
//         ORDER BY SKU
//       `);
//     res.json({ success: true, data: result.recordset });
//   } catch (err) {
//     console.error(`❌ /api/bulk-upload-session/${sessionId}/unidentified:`, err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── GET /api/bulk-upload-session/:sessionId/export ────────────
// // Downloads unidentified SKUs for a session as CSV.

// app.get('/api/bulk-upload-session/:sessionId/export', requireAuth, async (req, res) => {
//   const { sessionId } = req.params;
//   let pool;
//   try {
//     pool = await getSqlPool();

//     const sessionResult = await pool.request()
//       .input('SessionID', sql.NVarChar(36), sessionId)
//       .query(`SELECT UploadedAt FROM BulkUploadSessions WHERE SessionID = @SessionID`);

//     const rowsResult = await pool.request()
//       .input('SessionID', sql.NVarChar(36), sessionId)
//       .query(`
//         SELECT SKU, PP, UploadedAt, UploadedBy
//         FROM UnIdentifiedProducts
//         WHERE SessionID = @SessionID
//         ORDER BY SKU
//       `);

//     const lines = ['SKU,PP,UploadedAt,UploadedBy'];
//     for (const row of rowsResult.recordset) {
//       const uploadedAt = row.UploadedAt ? new Date(row.UploadedAt).toISOString() : '';
//       lines.push(`${row.SKU},${row.PP ?? ''},${uploadedAt},${row.UploadedBy}`);
//     }

//     const sessionDate = sessionResult.recordset[0]?.UploadedAt
//       ? new Date(sessionResult.recordset[0].UploadedAt).toISOString().slice(0, 10)
//       : 'unknown';

//     res.setHeader('Content-Type', 'text/csv');
//     res.setHeader('Content-Disposition', `attachment; filename="unidentified_skus_${sessionDate}.csv"`);
//     res.send(lines.join('\n'));

//   } catch (err) {
//     console.error(`❌ /api/bulk-upload-session/${sessionId}/export:`, err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });





// // ─────────────────────────────────────────────────────────────
// // ADD THESE TWO ROUTES TO src/api_server.js
// // Place them just before the app.listen() call at the bottom.
// // ─────────────────────────────────────────────────────────────


// // ── GET /api/category-settings ────────────────────────────────
// // Returns all rows from CategorySettings.
// // Frontend uses this to populate both tabs in the Settings panel.

// app.get('/api/category-settings', requireAuth, async (req, res) => {
//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request().query(`
//       SELECT
//         CategoryName,
//         GST,
//         CostOfBusiness,
//         ProfitMargin,
//         ScrapFreqDays,
//         IsScrapEnabled,
//         UpdatedAt,
//         UpdatedBy
//       FROM CategorySettings
//       ORDER BY CategoryName
//     `);
//     console.log(`✅ /api/category-settings — ${result.recordset.length} rows`);
//     res.json({ success: true, data: result.recordset });
//   } catch (err) {
//     console.error('❌ /api/category-settings error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── PUT /api/category-settings/:category ─────────────────────
// // Updates one category row in CategorySettings.
// // Accepts any combination of: GST, CostOfBusiness, ProfitMargin,
// // ScrapFreqDays, IsScrapEnabled.
// // NULL values for business variables = revert to system default.
// //
// // Body example:
// //   { GST: 18, CostOfBusiness: 7, ProfitMargin: 5,
// //     ScrapFreqDays: 3, IsScrapEnabled: true }

// app.put('/api/category-settings/:category', requireAuth, async (req, res) => {
//   const categoryName = decodeURIComponent(req.params.category);
//   const { GST, CostOfBusiness, ProfitMargin, ScrapFreqDays, IsScrapEnabled } = req.body;
//   const updatedBy = req.session?.user?.email || 'unknown';

//   // Validate numeric fields when provided
//   if (GST !== undefined && GST !== null) {
//     const v = parseFloat(GST);
//     if (isNaN(v) || v < 0 || v > 100) {
//       return res.status(400).json({ success: false, error: 'GST must be between 0 and 100' });
//     }
//   }
//   if (CostOfBusiness !== undefined && CostOfBusiness !== null) {
//     const v = parseFloat(CostOfBusiness);
//     if (isNaN(v) || v < 0 || v > 100) {
//       return res.status(400).json({ success: false, error: 'CostOfBusiness must be between 0 and 100' });
//     }
//   }
//   if (ProfitMargin !== undefined && ProfitMargin !== null) {
//     const v = parseFloat(ProfitMargin);
//     if (isNaN(v) || v < 0 || v > 100) {
//       return res.status(400).json({ success: false, error: 'ProfitMargin must be between 0 and 100' });
//     }
//   }
//   if (ScrapFreqDays !== undefined && ScrapFreqDays !== null) {
//     const v = parseInt(ScrapFreqDays);
//     if (isNaN(v) || v < 1 || v > 365) {
//       return res.status(400).json({ success: false, error: 'ScrapFreqDays must be between 1 and 365' });
//     }
//   }

//   let pool;
//   try {
//     pool = await getSqlPool();

//     // MERGE: update if exists, insert if category not yet in table
//     // (handles edge case where a new category appeared in InternalProducts
//     // after the initial seed script was run)
//     const result = await pool.request()
//       .input('CategoryName',    sql.NVarChar(200),  categoryName)
//       .input('GST',             sql.Decimal(5, 2),  GST            ?? null)
//       .input('CostOfBusiness',  sql.Decimal(5, 2),  CostOfBusiness ?? null)
//       .input('ProfitMargin',    sql.Decimal(5, 2),  ProfitMargin   ?? null)
//       .input('ScrapFreqDays',   sql.Int,             ScrapFreqDays  ?? 7)
//       .input('IsScrapEnabled',  sql.Bit,             IsScrapEnabled ?? 1)
//       .input('UpdatedBy',       sql.NVarChar(150),   updatedBy)
//       .query(`
//         MERGE CategorySettings AS target
//         USING (SELECT @CategoryName AS CategoryName) AS source
//           ON target.CategoryName = source.CategoryName

//         WHEN MATCHED THEN
//           UPDATE SET
//             GST            = @GST,
//             CostOfBusiness = @CostOfBusiness,
//             ProfitMargin   = @ProfitMargin,
//             ScrapFreqDays  = @ScrapFreqDays,
//             IsScrapEnabled = @IsScrapEnabled,
//             UpdatedAt      = GETDATE(),
//             UpdatedBy      = @UpdatedBy

//         WHEN NOT MATCHED THEN
//           INSERT (CategoryName, GST, CostOfBusiness, ProfitMargin,
//                   ScrapFreqDays, IsScrapEnabled, UpdatedAt, UpdatedBy)
//           VALUES (@CategoryName, @GST, @CostOfBusiness, @ProfitMargin,
//                   @ScrapFreqDays, @IsScrapEnabled, GETDATE(), @UpdatedBy);

//         SELECT CategoryName, GST, CostOfBusiness, ProfitMargin,
//                ScrapFreqDays, IsScrapEnabled, UpdatedAt, UpdatedBy
//         FROM CategorySettings
//         WHERE CategoryName = @CategoryName;
//       `);

//     console.log(`✅ /api/category-settings/${categoryName} — updated by ${updatedBy}`);
//     res.json({ success: true, data: result.recordset[0] });

//   } catch (err) {
//     console.error(`❌ /api/category-settings/${categoryName} error:`, err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });




// // ── GET /api/users ────────────────────────────────────────────
// // Returns all users in UserRoles table. Admin only.
// app.get('/api/users', requireRole('admin'), async (req, res) => {
//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request().query(`
//       SELECT Email, Role, AddedBy, AddedAt, UpdatedBy, UpdatedAt
//       FROM UserRoles
//       ORDER BY AddedAt DESC
//     `);
//     res.json({ success: true, data: result.recordset });
//   } catch (err) {
//     console.error('❌ /api/users GET error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── POST /api/users ───────────────────────────────────────────
// // Add a new user or update an existing user's role. Admin only.
// app.post('/api/users', requireRole('admin'), async (req, res) => {
//   const { email, role } = req.body;
//   if (!email || !role) {
//     return res.status(400).json({ success: false, error: 'email and role are required' });
//   }
//   const normalizedEmail = email.trim().toLowerCase();
//   const validRoles = ['admin', 'supervisor', 'sales'];
//   if (!validRoles.includes(role)) {
//     return res.status(400).json({ success: false, error: `role must be one of: ${validRoles.join(', ')}` });
//   }

//   const addedBy = req.session.user.email;
//   let pool;
//   try {
//     pool = await getSqlPool();
//     // MERGE so re-adding an existing user just updates their role
//     await pool.request()
//       .input('Email',   sql.NVarChar(255), normalizedEmail)
//       .input('Role',    sql.NVarChar(50),  role)
//       .input('AddedBy', sql.NVarChar(255), addedBy)
//       .query(`
//         MERGE UserRoles AS target
//         USING (SELECT @Email AS Email) AS source
//           ON target.Email = source.Email
//         WHEN MATCHED THEN
//           UPDATE SET
//             Role      = @Role,
//             UpdatedBy = @AddedBy,
//             UpdatedAt = GETDATE()
//         WHEN NOT MATCHED THEN
//           INSERT (Email, Role, AddedBy)
//           VALUES (@Email, @Role, @AddedBy);
//       `);

//     console.log(`✅ /api/users — upserted: ${normalizedEmail} as ${role} by ${addedBy}`);
//     res.json({ success: true, data: { email: normalizedEmail, role } });
//   } catch (err) {
//     console.error('❌ /api/users POST error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });


// // ── DELETE /api/users/:email ──────────────────────────────────
// // Remove a user. Admin only. Admins cannot delete themselves.
// app.delete('/api/users/:email', requireRole('admin'), async (req, res) => {
//   const targetEmail = decodeURIComponent(req.params.email).toLowerCase();
//   const selfEmail   = req.session.user.email;

//   if (targetEmail === selfEmail) {
//     return res.status(400).json({ success: false, error: 'You cannot remove yourself' });
//   }

//   let pool;
//   try {
//     pool = await getSqlPool();
//     const result = await pool.request()
//       .input('Email', sql.NVarChar(255), targetEmail)
//       .query(`DELETE FROM UserRoles WHERE Email = @Email`);

//     if (result.rowsAffected[0] === 0) {
//       return res.status(404).json({ success: false, error: 'User not found' });
//     }
//     console.log(`✅ /api/users DELETE — removed: ${targetEmail} by ${selfEmail}`);
//     res.json({ success: true });
//   } catch (err) {
//     console.error(`❌ /api/users DELETE error:`, err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });







// // ── POST /api/run-recommendation-engine ───────────────────────
// // Triggers the recommendation engine on demand.
// // Runs in the background — returns immediately with a job ID.
// // Frontend polls GET /api/recommendation-job/:jobId for status.

// const activeJobs = new Map(); // jobId → { status, startedAt, log, error }

// app.post('/api/run-recommendation-engine', requireAuth, async (req, res) => {
//   const { v4: jobId } = require('uuid');
//   const id = uuidv4();
//   const startedBy = req.session?.user?.email || 'unknown';

//   // Don't allow two runs at the same time
//   const running = [...activeJobs.values()].find(j => j.status === 'running');
//   if (running) {
//     return res.status(409).json({
//       success: false,
//       error: 'Recommendation engine is already running. Wait for it to finish.'
//     });
//   }

//   activeJobs.set(id, {
//     status   : 'running',
//     startedAt: new Date().toISOString(),
//     startedBy,
//     log      : [],
//     error    : null,
//   });

//   console.log(`🚀 Recommendation engine triggered by ${startedBy} | job=${id}`);

//   // Run async — don't await, return job ID immediately
//   (async () => {
//     const job = activeJobs.get(id);
//     try {
//       // Import the engine functions directly
//       const {
//         loadCategorySettings,
//         loadInternalProducts,
//         loadCompetitorPrices,
//         buildCompetitorMap,
//         generateRecommendations,
//         updateRecommendedSP,
//       } = require('./recommendation_engine');

//       const pool = await getSqlPool();
//       const categorySettings = await loadCategorySettings(pool);
//       const internalProducts = await loadInternalProducts(pool);
//       const competitorRows   = await loadCompetitorPrices(pool);
//       const competitorMap    = buildCompetitorMap(competitorRows);
//       const recommendations  = generateRecommendations(internalProducts, competitorMap, categorySettings);
//       await updateRecommendedSP(pool, recommendations);
//       await pool.close();

//       job.status      = 'done';
//       job.updatedCount = recommendations.length;
//       job.finishedAt  = new Date().toISOString();
//       console.log(`✅ Recommendation engine done | job=${id} | updated=${recommendations.length}`);
//     } catch (err) {
//       job.status = 'error';
//       job.error  = err.message;
//       job.finishedAt = new Date().toISOString();
//       console.error(`❌ Recommendation engine failed | job=${id}:`, err.message);
//     }
//   })();

//   res.json({ success: true, jobId: id });
// });

// // ── GET /api/recommendation-job/:jobId ────────────────────────
// app.get('/api/recommendation-job/:jobId', requireAuth, (req, res) => {
//   const job = activeJobs.get(req.params.jobId);
//   if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
//   res.json({ success: true, data: job });
// });



// // ── GET /api/health ───────────────────────────────────────────
// app.get('/api/health', (req, res) => {
//   res.json({ status: 'ok', timestamp: new Date().toISOString() });
// });


// app.listen(PORT, () => {
//   console.log(`🚀 API server running at http://localhost:${PORT}`);
//   console.log(`   GET  http://localhost:${PORT}/api/recommendations`);
//   console.log(`   POST http://localhost:${PORT}/api/refresh-product`);
//   console.log(`   GET  http://localhost:${PORT}/api/health`);
// });