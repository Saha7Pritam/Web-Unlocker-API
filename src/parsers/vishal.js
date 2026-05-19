const cheerio = require('cheerio');

const BASE = 'https://vishalperipherals.com';

function cleanText(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/*
|--------------------------------------------------------------------------
| IMPORTANT
|--------------------------------------------------------------------------
| DO NOT remove query params here.
| Shopify pagination uses ?page=2
|--------------------------------------------------------------------------
*/

function absoluteUrl(href) {
  if (!href) return null;

  if (href.startsWith('http')) {
    return href;
  }

  if (href.startsWith('/')) {
    return BASE + href;
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| PRODUCT LINKS
|--------------------------------------------------------------------------
*/

function parseProductLinks(html) {
  const $ = cheerio.load(html);

  const links = new Set();

  $('a[href*="/products/"]').each((_, el) => {
    const href = absoluteUrl(
      $(el).attr('href')
    );

    if (
      href &&
      href.includes('/products/')
    ) {
      // remove query only for product URLs
      links.add(href.split('?')[0]);
    }
  });

  return [...links];
}

/*
|--------------------------------------------------------------------------
| PAGINATION
|--------------------------------------------------------------------------
*/

function getNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);

  const current = new URL(currentUrl);

  const currentPage = parseInt(
    current.searchParams.get('page') || '1',
    10
  );

  let nextHref = null;

  $('a[href*="?page="]').each((_, el) => {
    const href = $(el).attr('href');

    if (!href) return;

    const match = href.match(/page=(\d+)/);

    if (!match) return;

    const pageNum = parseInt(match[1], 10);

    if (pageNum === currentPage + 1) {
      nextHref = href;
    }
  });

  if (!nextHref) {
    return null;
  }

  return absoluteUrl(nextHref);
}

/*
|--------------------------------------------------------------------------
| PRODUCT DETAILS
|--------------------------------------------------------------------------
*/

function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  const bodyText = $('body').text();

  /*
  |--------------------------------------------------------------------------
  | NAME
  |--------------------------------------------------------------------------
  */

  const name =
    cleanText($('h1').first().text()) ||
    null;

 /*
|--------------------------------------------------------------------------
| PRICES
|--------------------------------------------------------------------------
*/

const salePrice =
  cleanText(
    $('#js-product-price').first().text()
  ) ||
  cleanText(
    $('.price--sale .current').first().text()
  ) ||
  null;

const originalPrice =
  cleanText(
    $('.price--sale .compare').first().text()
  ) ||
  null;

  /*
  |--------------------------------------------------------------------------
  | STOCK
  |--------------------------------------------------------------------------
  */

  const stockStatus =
    bodyText.includes('Out of stock') ||
    bodyText.includes('Sold out')
      ? 'Out of Stock'
      : 'In Stock';

  /*
  |--------------------------------------------------------------------------
  | BRAND
  |--------------------------------------------------------------------------
  */

  let brand = null;

  if (name) {
    if (name.toUpperCase().includes('INTEL')) {
      brand = 'Intel';
    }

    if (name.toUpperCase().includes('AMD')) {
      brand = 'AMD';
    }
  }

  
  /*
  |--------------------------------------------------------------------------
  | MODEL NUMBER
  |--------------------------------------------------------------------------
  */


let modelNumber = null;

// Vishal structure:
// <label class="label">Model Number:</label>
// <span>CT8G48C40S5</span>

$('label').each((_, el) => {
  const labelText = cleanText($(el).text());

  if (
    labelText &&
    labelText.toLowerCase().includes('model number')
  ) {
    const value = cleanText(
      $(el).next('span').text()
    );

    if (value) {
      modelNumber = value;
    }
  }
});

  /*
  |--------------------------------------------------------------------------
  | SKU
  |--------------------------------------------------------------------------
  */

  let sku = null;

  const skuMatch =
    bodyText.match(/SKU:\s*([0-9]+)/i);

  if (skuMatch) {
    sku = skuMatch[1];
  }

  /*
  |--------------------------------------------------------------------------
  | DESCRIPTION
  |--------------------------------------------------------------------------
  */

  let shortDescription = null;

  $('.rte, .product-description, p').each((_, el) => {
    const txt = cleanText($(el).text());

    if (
      txt &&
      txt.length > 120 &&
      !shortDescription
    ) {
      shortDescription = txt;
    }
  });

  /*
  |--------------------------------------------------------------------------
  | IMAGES
  |--------------------------------------------------------------------------
  */

  const images = new Set();

  $('img').each((_, el) => {
    let src =
      $(el).attr('src') ||
      $(el).attr('data-src');

    if (!src) return;

    if (src.startsWith('//')) {
      src = 'https:' + src;
    }

    if (
      src.includes('/products/') ||
      src.includes('/cdn/shop/files/')
    ) {
      images.add(src.split('?')[0]);
    }
  });

  /*
  |--------------------------------------------------------------------------
  | SPECS
  |--------------------------------------------------------------------------
  */

  const specs = {};

  $('table tr').each((_, row) => {
    const key = cleanText(
      $(row).find('td, th').eq(0).text()
    );

    const value = cleanText(
      $(row).find('td, th').eq(1).text()
    );

    if (key && value) {
      specs[key] = value;
    }
  });

  return {
    url,
    store: 'vishal',
    name,
    modelNumber,
    sku,
    brand,
    category: 'Processor',
    stockStatus,
    salePrice,
    originalPrice,
    shortDescription,
    tags: [],
    images: [...images],
    specs,
    scrapedAt: new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = {
  parseProductLinks,
  getNextPageUrl,
  parseProductDetails,
};

