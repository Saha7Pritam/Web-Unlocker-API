// src/api_server.js
// Run: node src/api_server.js

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const sql      = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const { scrapeProduct }    = require('./scraper/scrapeProduct');
const { upsertOneProduct } = require('./services/competitorPriceService');
const { STORES }           = require('./urls');

const session    = require('express-session');
const { msalClient } = require('./auth/msalConfig');
const { requireAuth } = require('./auth/authMiddleware');

const app  = express();
const PORT = process.env.PORT || 8000;

app.use(cors({
  origin     : process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());


// ── Session middleware (add near top, after cors/json) ────────
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }, // true in production (HTTPS)
}));

// ── GET /auth/login ───────────────────────────────────────────
// Generates Microsoft login URL and redirects browser to it
app.get('/auth/login', async (req, res) => {
  const authCodeUrlParams = {
    scopes      : ['user.read'],
    redirectUri : process.env.REDIRECT_URI,
  };
  const authUrl = await msalClient.getAuthCodeUrl(authCodeUrlParams);
  res.redirect(authUrl);
});

// ── GET /callback ────────────────────────────────────────
// Microsoft redirects here after login with a code
app.get('/callback', async (req, res) => {
  const tokenRequest = {
    code        : req.query.code,
    scopes      : ['user.read'],
    redirectUri : process.env.REDIRECT_URI,
  };

  try {
    const response = await msalClient.acquireTokenByCode(tokenRequest);

    // Store user info in session
    req.session.user = {
      name  : response.account.name,
      email : response.account.username,  // this is their @tpstech.in email
      role  : 'sales', // hardcode for now — replace with Azure AD group check later
    };

    res.redirect(process.env.FRONTEND_URL || 'http://localhost:5173');

  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.status(500).send('Login failed');
  }
});

// ── GET /auth/me ──────────────────────────────────────────────
// Frontend calls this on load to check if user is logged in
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
// Matches the URL domain against known store names in urls.js
function findStoreByUrl(productUrl) {
  const domainMap = {
    'primeabgb.com'         : 'primeabgb',
    'mdcomputers.in'        : 'mdcomputers',
    'pickpcparts.in'        : 'pickpcparts',
    'vedantcomputers.com'   : 'vedant',
    'vishalperipherals.com' : 'vishal',
    'pcstudio.in'           : 'pcstudio',
  };

  for (const [domain, storeName] of Object.entries(domainMap)) {
    if (productUrl.includes(domain)) {
      return STORES.find(s => s.name === storeName) || null;
    }
  }
  return null;
}

// ── Helper: recalculate RecommendedSP for one SKU ────────────
// Mirrors the recommendation engine logic for a single product.
// Called after manual refresh so the UI shows the updated price immediately.
async function recalculateRecommendedSP(pool, skuId) {
  const GST               = 0.18;
  const COST_OF_BUSINESS  = 0.07;
  const MIN_PROFIT_MARGIN = 0.05;

  // Get PP for this SKU
  const productResult = await pool.request()
    .input('SKU_ID', sql.NVarChar(100), skuId)
    .query(`
      SELECT PP FROM InternalProducts
      WHERE SKU_ID = @SKU_ID AND PP IS NOT NULL
    `);

  if (!productResult.recordset.length) return null;

  const pp = parseFloat(productResult.recordset[0].PP);

  // Get lowest in-stock competitor price for this SKU
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

  // Update InternalProducts
  await pool.request()
    .input('SKU_ID',        sql.NVarChar(100),  skuId)
    .input('RecommendedSP', sql.Decimal(10, 2), recommendedSP)
    .query(`
      UPDATE InternalProducts
      SET RecommendedSP          = @RecommendedSP,
          RecommendedSPUpdatedAt = GETDATE()
      WHERE SKU_ID = @SKU_ID
    `);

  return recommendedSP;
}

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
        c.ProductURL      AS CompetitorURL,
        c.StoreName,
        c.StockStatus     AS CompetitorStockStatus

      FROM InternalProducts i

      INNER JOIN (
        SELECT
          SKU,
          CompetitorPrice,
          ProductURL,
          StoreName,
          StockStatus,
          ROW_NUMBER() OVER (
            PARTITION BY SKU
            ORDER BY CompetitorPrice ASC
          ) AS rn
        FROM CompetitorPrices
        WHERE CompetitorPrice IS NOT NULL
          AND LOWER(StockStatus) != 'out of stock'
      ) c ON c.SKU = i.SKU_ID AND c.rn = 1

      WHERE i.PP          IS NOT NULL
        AND i.isActive    = 1
        AND i.isInStock   = 1
        AND i.RecommendedSP IS NOT NULL

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
// Manual single-product refresh triggered from UI.
//
// Body: { competitorUrl: string, skuId: string }
//   competitorUrl — the competitor product page URL to re-scrape
//   skuId         — our internal SKU_ID to update RecommendedSP for
//
// Flow:
//   1. Identify store from URL domain
//   2. Scrape the product page via Web Unlocker
//   3. Upsert new price into CompetitorPrices SQL table
//   4. Recalculate RecommendedSP for this SKU
//   5. Update LastManualRefreshAt + LastManualRefreshBy
//   6. Return updated product data to UI
//
// Does NOT touch LastScrapedAt / NextScrapDueAt (auto scheduler only).


app.post('/api/refresh-product', async (req, res) => {
  const { competitorUrl, skuId } = req.body;

  // ── Validation ────────────────────────────────────────────
  if (!competitorUrl || !skuId) {
    return res.status(400).json({
      success: false,
      error  : 'Both competitorUrl and skuId are required',
    });
  }

  console.log(`\n🔄 Manual refresh: SKU=${skuId} | URL=${competitorUrl}`);

  // ── Step 1: Find store config from URL ────────────────────
  const store = findStoreByUrl(competitorUrl);
  if (!store) {
    return res.status(400).json({
      success: false,
      error  : `Unknown store URL. Supported: primeabgb, mdcomputers, pickpcparts, vedant, vishal, pcstudio`,
    });
  }

  console.log(`   Store identified: ${store.name}`);

  let pool;
  try {
    // ── Step 2: Scrape the product page ───────────────────
    console.log(`   Scraping: ${competitorUrl}`);
    const product = await scrapeProduct(store, competitorUrl);

    if (!product || !product.name) {
      return res.status(422).json({
        success: false,
        error  : 'Scraping succeeded but no product data found on this page',
      });
    }

    console.log(`   Scraped: ${product.name}`);

    // ── Step 3: Upsert into CompetitorPrices ──────────────
    const upserted = await upsertOneProduct(product);

    if (!upserted) {
      return res.status(422).json({
        success: false,
        error  : 'Product scraped but SKU could not be mapped — check parser for this store',
      });
    }

    // ── Step 4: Recalculate RecommendedSP ─────────────────
    pool = await getSqlPool();
    const newRecommendedSP = await recalculateRecommendedSP(pool, skuId);

    // ── Step 5: Update manual refresh audit columns ───────
    // ONLY writes LastManualRefreshAt + LastManualRefreshBy.
    // NEVER touches LastScrapedAt or NextScrapDueAt (auto scheduler owns those).
    const refreshedBy = req.headers['x-user-email'] || 'manual'; // real email after auth added
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

    // ── Step 6: Return updated data to UI ─────────────────
    res.json({
      success          : true,
      skuId,
      storeName        : store.name,
      productName      : product.name,
      newCompetitorPrice: upserted.CompetitorPrice,
      newRecommendedSP,
      refreshedAt,
      refreshedBy,
    });

  } catch (err) {
    console.error(`❌ Manual refresh failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});



// ── ADD this block to src/api_server.js ──────────────────────
// Place it anywhere after getSqlPool() is defined,
// alongside the other app.get / app.post routes.
//
// GET /api/competitor-details/:skuId
// ─────────────────────────────────────────────────────────────
// Returns up to 4 in-stock competitors for a single SKU,
// ranked by CompetitorPrice ASC.
// Called lazily by CompetitorCell on first hover/expand.
// The /api/recommendations endpoint is NOT changed.

app.get('/api/competitor-details/:skuId', async (req, res) => {
  const { skuId } = req.params;

  if (!skuId) {
    return res.status(400).json({ success: false, error: 'skuId is required' });
  }

  let pool;
  try {
    pool = await getSqlPool();

    const result = await pool.request()
      .input('SKU', sql.NVarChar(100), skuId)
      .query(`
        SELECT TOP 4
          CompetitorPrice,
          ProductURL,
          StoreName,
          StockStatus
        FROM CompetitorPrices
        WHERE SKU             = @SKU
          AND CompetitorPrice IS NOT NULL
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




// Both routes use requireAuth middleware — already imported in api_server.js.

// ── GET /api/pp-products ──────────────────────────────────────
// Returns all internal products for the PP Update table in the UI.
// Includes PP, LastBillDate, ManualPP_UpdatedAt, ManualPP_UpdatedBy
// so the UI can show audit info next to each row.
app.get('/api/pp-products', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();

    const result = await pool.request().query(`
      SELECT
        SKU_ID,
        Title,
        Category,
        Brand,
        PP,
        LastBillDate,
        ManualPP_UpdatedAt,
        ManualPP_UpdatedBy,
        -- Effective PP source for display
        CASE
          WHEN ManualPP_UpdatedAt IS NOT NULL
           AND LastBillDate IS NOT NULL
           AND ManualPP_UpdatedAt >= CAST(LastBillDate AS DATETIME2)
            THEN 'manual'
          WHEN ManualPP_UpdatedAt IS NOT NULL AND LastBillDate IS NULL
            THEN 'manual'
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
// Manually override PP for a single SKU.
//
// Body: { skuId: string, newPP: number }
//
// Writes:
//   PP               = newPP           (overwrites bill PP)
//   ManualPP_UpdatedAt = GETDATE()     (audit: when)
//   ManualPP_UpdatedBy = user email    (audit: who)
//
// Does NOT touch LastBillDate — that is owned by internal_db_sync.
// Does NOT touch RecommendedSP — that is recalculated by recommendation_engine.
//   (Run the engine after a batch of PP updates to refresh RecommendedSP values.)

app.patch('/api/update-pp', requireAuth, async (req, res) => {
  const { skuId, newPP } = req.body;

  if (!skuId || newPP == null) {
    return res.status(400).json({ success: false, error: 'skuId and newPP are required' });
  }

  const parsedPP = parseFloat(newPP);
  if (isNaN(parsedPP) || parsedPP <= 0) {
    return res.status(400).json({ success: false, error: 'newPP must be a positive number' });
  }

  // Get the logged-in user's email from session (set during Microsoft auth callback)
  const updatedBy = req.session?.user?.email || 'unknown';

  let pool;
  try {
    pool = await getSqlPool();

    const result = await pool.request()
      .input('SKU_ID',            sql.NVarChar(100),  skuId)
      .input('PP',                sql.Decimal(10, 2), parsedPP)
      .input('ManualPP_UpdatedBy',sql.NVarChar(150),  updatedBy)
      .query(`
        UPDATE InternalProducts
        SET
          PP                 = @PP,
          ManualPP_UpdatedAt = GETDATE(),
          ManualPP_UpdatedBy = @ManualPP_UpdatedBy
        WHERE SKU_ID = @SKU_ID;

        -- Return the updated row so the UI can refresh immediately
        SELECT
          SKU_ID,
          PP,
          ManualPP_UpdatedAt,
          ManualPP_UpdatedBy,
          LastBillDate
        FROM InternalProducts
        WHERE SKU_ID = @SKU_ID;
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }

    const updated = result.recordset[0];
    console.log(`✅ PP updated: SKU=${skuId} | PP=₹${parsedPP} | By=${updatedBy}`);

    res.json({ success: true, data: updated });

  } catch (err) {
    console.error(`❌ /api/update-pp error for ${skuId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});





// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 API server running at http://localhost:${PORT}`);
  console.log(`   GET  http://localhost:${PORT}/api/recommendations`);
  console.log(`   POST http://localhost:${PORT}/api/refresh-product`);
  console.log(`   GET  http://localhost:${PORT}/api/health`);
});