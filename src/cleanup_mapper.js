// src/cleanup_mapper.js
// ─────────────────────────────────────────────────────────────
// CLI runner — reads all documents from Cosmos, maps them,
// and bulk upserts into CompetitorPrices SQL table.
//
// Run: node src/cleanup_mapper.js
//
// The actual logic lives in src/services/competitorPriceService.js
// This file is just the entry point.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const { CosmosClient }          = require('@azure/cosmos');
const { upsertManyFromCosmos }  = require('./services/competitorPriceService');

const client    = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const database  = client.database('ScraperDB');
const container = database.container('scrap_results');

async function run() {
  console.log('📖 Reading from Cosmos...');

  const { resources } = await container.items
    .query('SELECT * FROM c')
    .fetchAll();

  console.log(`   Found ${resources.length} documents`);

  console.log('\n🔌 Connecting to Azure SQL...');
  const { mapped, skipped, inserted, updated, failed, failedRows } =
    await upsertManyFromCosmos(resources);

  console.log('\n🎉 Done!');
  console.log(`   Mapped  : ${mapped}`);
  console.log(`   Skipped : ${skipped}`);
  console.log(`   Inserted: ${inserted}`);
  console.log(`   Updated : ${updated}`);
  console.log(`   Failed  : ${failed}`);

  if (failedRows.length > 0) {
    console.log('\n❌ Failed rows:');
    failedRows.forEach(r => {
      console.log(`   SKU=${r.SKU} | Store=${r.StoreName} | Price=${r.Price} | Error=${r.Error}`);
    });
  }
}

run().catch(err => {
  console.error('❌ Fatal error:', err.message);
  process.exit(1);
});