const cheerio = require('cheerio');

const BASE = 'https://www.pcstudio.in';

function cleanText(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

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

  $('a').each((_, el) => {
    const href = absoluteUrl(
      $(el).attr('href')
    );

    if (!href) return;

    if (
      href.includes('/product/') &&
      !href.includes('/product-category/') &&
      !href.includes('/tag/') &&
      !href.includes('/page/')
    ) {
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

  let nextUrl = null;

  $('.next.page-numbers').each((_, el) => {
    const href = $(el).attr('href');

    if (href) {
      nextUrl = absoluteUrl(href);
    }
  });

  return nextUrl;
}

/*
|--------------------------------------------------------------------------
| PRODUCT DETAILS
|--------------------------------------------------------------------------
*/

function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  /*
  |--------------------------------------------------------------------------
  | NAME
  |--------------------------------------------------------------------------
  */

  const name =
    cleanText($('.product_title').first().text()) ||
    cleanText($('h1').first().text());

/*
|--------------------------------------------------------------------------
| PRICES
|--------------------------------------------------------------------------
*/

const salePrice =
  cleanText(
    $('p.price ins .woocommerce-Price-amount')
      .first()
      .text()
  ) ||
  cleanText(
    $('p.price .woocommerce-Price-amount')
      .last()
      .text()
  ) ||
  null;

const originalPrice =
  cleanText(
    $('p.price del .woocommerce-Price-amount')
      .first()
      .text()
  ) ||
  null;

  /*
  |--------------------------------------------------------------------------
  | STOCK
  |--------------------------------------------------------------------------
  */

  const stockText =
    cleanText($('.stock').first().text()) ||
    $('body').text();

  const stockStatus =
    /out of stock/i.test(stockText)
      ? 'Out of Stock'
      : 'In Stock';

  /*
  |--------------------------------------------------------------------------
  | BRAND
  |--------------------------------------------------------------------------
  */

  let brand =
    cleanText($('.posted_in a').first().text()) ||
    null;

  if (!brand && name) {
    brand = name.split(' ')[0];
  }

  /*
  |--------------------------------------------------------------------------
  | CATEGORY
  |--------------------------------------------------------------------------
  */

  const category =
    cleanText($('.posted_in a').last().text()) ||
    'Processor';

  /*
  |--------------------------------------------------------------------------
  | SKU
  |--------------------------------------------------------------------------
  */

  const sku =
    cleanText($('.sku').first().text()) ||
    null;

 /*
|--------------------------------------------------------------------------
| MODEL NUMBER
|--------------------------------------------------------------------------
*/

let modelNumber = null;

/*
|--------------------------------------------------------------------------
| 1. Extract from explicit "Model No"
|--------------------------------------------------------------------------
*/

$('span, p, div').each((_, el) => {
  const text = cleanText($(el).text());

  if (
    text &&
    /model\s*no/i.test(text)
  ) {
    const match = text.match(
      /model\s*no\s*:?\s*([A-Z0-9-]+)/i
    );

    if (match) {
      modelNumber = match[1];
      return false;
    }
  }
});

/*
|--------------------------------------------------------------------------
| 2. Fallback from product name
|--------------------------------------------------------------------------
*/

if (!modelNumber && name) {
  const match = name.match(
    /\(([A-Z0-9-]+)\)/
  );

  if (match) {
    modelNumber = match[1];
  }
}

  /*
  |--------------------------------------------------------------------------
  | DESCRIPTION
  |--------------------------------------------------------------------------
  */

  const shortDescription =
    cleanText($('.woocommerce-product-details__short-description').text()) ||
    cleanText($('#tab-description').text()) ||
    null;

  /*
  |--------------------------------------------------------------------------
  | IMAGES
  |--------------------------------------------------------------------------
  */

  const images = new Set();

  $('.woocommerce-product-gallery img').each((_, el) => {
    let src =
      $(el).attr('src') ||
      $(el).attr('data-src');

    if (!src) return;

    if (src.startsWith('//')) {
      src = 'https:' + src;
    }

    images.add(src.split('?')[0]);
  });

  /*
  |--------------------------------------------------------------------------
  | SPECS
  |--------------------------------------------------------------------------
  */

  const specs = {};

  $('table tr').each((_, row) => {
    const key = cleanText(
      $(row).find('th').text()
    );

    const value = cleanText(
      $(row).find('td').text()
    );

    if (key && value) {
      specs[key] = value;
    }
  });

  /*
  |--------------------------------------------------------------------------
  | TAGS
  |--------------------------------------------------------------------------
  */

  const tags = [];

  $('.tagged_as a').each((_, el) => {
    const tag = cleanText($(el).text());

    if (tag) {
      tags.push(tag);
    }
  });

  return {
    url,
    store: 'pcstudio',
    name,
    modelNumber,
    sku,
    brand,
    category,
    stockStatus,
    salePrice,
    originalPrice,
    shortDescription,
    tags,
    images: [...images],
    specs,
    scrapedAt: new Date().toISOString(),
  };
}

module.exports = {
  parseProductLinks,
  getNextPageUrl,
  parseProductDetails,
};