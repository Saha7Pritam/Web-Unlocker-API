// src/scraper/fetchPage.js
// Web Unlocker REST API fetch — replaces all Playwright browser management.
// Single responsibility: take a URL, return HTML. Retry on failure.

const https = require('https');

const API_KEY = process.env.BRIGHT_DATA_API_KEY;
const ZONE    = process.env.BRIGHT_DATA_ZONE;

if (!API_KEY) throw new Error('Missing BRIGHT_DATA_API_KEY in .env');
if (!ZONE)    throw new Error('Missing BRIGHT_DATA_ZONE in .env');

/**
 * Fetches a URL via Bright Data Web Unlocker API.
 * Returns raw HTML string.
 *
 * @param {string} targetUrl  - The page to fetch
 * @param {number} retries    - Max attempts (default 3)
 * @returns {Promise<string>} - HTML content
 */
function fetchPage(targetUrl, retries = 3) {
  const attempt = (n) => new Promise((resolve, reject) => {
    const body = JSON.stringify({
      url   : targetUrl,
      zone  : ZONE,
      format: 'raw',
    });

    const options = {
      hostname: 'api.brightdata.com',
      path    : '/request',
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.setTimeout(120_000, () => {
      req.destroy(new Error('Request timeout after 120s'));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });

  // Retry with exponential backoff
  const run = async (n) => {
    try {
      return await attempt(n);
    } catch (err) {
      if (n < retries) {
        const wait = n * 4000;
        console.log(`  ⏳ Attempt ${n} failed (${err.message.substring(0, 60)}) — retrying in ${wait / 1000}s`);
        await new Promise(r => setTimeout(r, wait));
        return run(n + 1);
      }
      throw err;
    }
  };

  return run(1);
}

module.exports = { fetchPage };