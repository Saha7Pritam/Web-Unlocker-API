// src/parsers/mdcomputers.js
// ─────────────────────────────────────────────────────────────
// Web Unlocker / cheerio version — synchronous, receives HTML string
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

const BASE = 'https://mdcomputers.in';

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim() || null;
}

function absoluteUrl(href) {
  if (!href) return null;
  href = href.trim();
  if (href.startsWith('http')) return href.split('?')[0];
  if (href.startsWith('//'))   return ('https:' + href).split('?')[0];
  if (href.startsWith('/'))    return (BASE + href).split('?')[0];
  return null;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT LINKS
//  Scoped to the product grid (.all-product-wrapper) to avoid
//  picking up /product/ links from the category dropdown menus.
// ─────────────────────────────────────────────────────────────
function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  // Try the product grid first; fall back to #content, then body
  const gridSelectors = [
    '.all-product-wrapper',
    '#product-category #content',
    '#content .row',
    '#content',
  ];

  let scope = null;
  for (const sel of gridSelectors) {
    if ($(sel).length) { scope = sel; break; }
  }

  const base = scope ? $(scope) : $('body');

  base.find('a[href]').each((_, el) => {
    const raw  = $(el).attr('href') || '';
    const href = absoluteUrl(raw);
    if (href && href.includes('/product/')) {
      links.add(href);
    }
  });

  return [...links];
}

// ─────────────────────────────────────────────────────────────
//  PAGINATION
//  MDComputers pagination HTML:
//    <ul class="pagination">
//      <li class="page-item active"><span class="page-link">1</span></li>
//      <li class="page-item"><a href="...?page=2" class="page-link">2</a></li>
//      <li class="page-item"><a href="...?page=2" class="page-link">></a></li>
//      <li class="page-item"><a href="...?page=3" class="page-link">>|</a></li>
//    </ul>
//  Strategy: read current page number from active li text,
//  then find the <a> whose text equals currentPage + 1.
//  This avoids the > and >| arrow buttons which share the same href.
// ─────────────────────────────────────────────────────────────
function getNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);

  const activeLi = $('ul.pagination li.page-item.active');
  if (!activeLi.length) return null;

  const currentPage = parseInt(activeLi.text().trim(), 10);
  if (isNaN(currentPage)) return null;

  const nextPage = currentPage + 1;
  let nextUrl = null;

  $('ul.pagination li.page-item a').each((_, el) => {
    const text = parseInt($(el).text().trim(), 10);
    const href = $(el).attr('href') || '';
    if (text === nextPage && href.includes('page=')) {
      nextUrl = href.startsWith('http') ? href : BASE + href;
    }
  });

  // Guard: don't return same URL as current
  if (nextUrl && nextUrl.split('?')[0] === (currentUrl || '').split('?')[0] &&
      nextUrl === currentUrl) {
    return null;
  }

  return nextUrl || null;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT DETAILS
// ─────────────────────────────────────────────────────────────
function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  // ── Name ────────────────────────────────────────────────────
  // <h1 class="product-name-title ...">AMD Ryzen 5 5600F Desktop Processor</h1>
  const name =
    cleanText($('h1.product-name-title').first().text()) ||
    cleanText($('#product-product h1').first().text()) ||
    cleanText($('h1').first().text()) ||
    null;

  // ── Prices ──────────────────────────────────────────────────
  // <h2 class="special-price">₹11,150</h2>
  const salePrice =
    cleanText($('h2.special-price').first().text()) ||
    cleanText($('.special-price').first().text()) ||
    null;

  // <span class="price-old">₹15,000</span>
  const originalPrice =
    cleanText($('.price-old').first().text()) ||
    null;

  // <span class="discount-percentage">(26% off)</span>
  const discountBadge =
    cleanText($('.discount-percentage').first().text()) ||
    null;

  // ── Product status list ──────────────────────────────────────
  // <ul class="list-unstyled product-status">
  //   <li><span>Brand:</span> <a class="base-color ms-auto">AMD</a></li>
  //   <li><span>Product Code: </span><span class="base-color ms-auto">100-100001903BOX</span></li>
  //   <li><span>Availability:</span><span class="base-color ms-auto">In Stock</span></li>
  // </ul>
  let brand       = null;
  let productCode = null;
  let stockStatus = null;

  // Use the most specific selector — avoids nav/footer lists
  const statusListSelector = 'ul.list-unstyled.product-status li, ul.product-status li';
  $(statusListSelector).each((_, el) => {
    const text = $(el).text() || '';

    if (/brand/i.test(text) && !brand) {
      brand =
        cleanText($(el).find('a').first().text()) ||
        cleanText($(el).find('.base-color').first().text()) ||
        null;
    }

    if (/product\s*code/i.test(text) && !productCode) {
      productCode = cleanText($(el).find('.base-color').first().text()) || null;
    }

    if (/availability/i.test(text) && !stockStatus) {
      const avail = cleanText($(el).find('.base-color').first().text()) || '';
      stockStatus = /in\s*stock/i.test(avail) ? 'In Stock' : 'Out of Stock';
    }
  });

  // Fallback stock from body text
  if (!stockStatus) {
    const bodyText = $('body').text();
    stockStatus = /out of stock/i.test(bodyText) ? 'Out of Stock' : 'In Stock';
  }

  // ── Category (from breadcrumb) ───────────────────────────────
  // <ul class="breadcrumb">
  //   <li><a><i class="bi bi-house-fill"></i></a></li>
  //   <li><a href=".../processor">Processor</a></li>
  //   <li><a href=".../product/...">AMD Ryzen 5...</a></li>
  // </ul>
  // We want index 1 (the category, not Home and not the product name)
  const breadcrumbs = [];
  $('ul.breadcrumb li a').each((_, el) => {
    // Skip the home icon link (contains <i> but no real text)
    const text = cleanText($(el).clone().children().remove().end().text());
    if (text && text.length > 0) breadcrumbs.push(text);
  });
  // breadcrumbs[0] = category (e.g. "Processor"), breadcrumbs[1] = product name
  const category = breadcrumbs[0] || null;

  // ── Images — scoped to product gallery ONLY ──────────────────
  // The page has nav images (gaming keyboard, chair, etc.) loaded via
  // Swiper/slider in the header. We scope strictly to the gallery containers
  // inside #product-product to avoid picking up those nav images.
  //
  // Gallery containers:
  //   .gallery-top     — main large image slider
  //   .gallery-thumbs  — thumbnail strip
  //
  // We also filter by known product image path patterns.
  const images = [];
  const seenImages = new Set();

  // Known non-product image paths to skip
  const skipPatterns = [
    '/2025/jan/10-01-25/',   // gaming keyboard/chair banners
    '/2025/jan/09-01-25/',   // gamer zone banners
    '/2024/june/',           // india map etc
    '/2024/june/07-06-24/',
    '/Logo/',
    '/footer',
    '/brand-logo/',
    '/2025/nov/20-11-25/',   // hdfc bank banner
    '/2026/apr/',            // msi offer banners
    '/2026/may/',            // nvidia bundle banners
    '/footer-design',
  ];

  $('#product-product .gallery-top img, #product-product .gallery-thumbs img').each((_, el) => {
    const src =
      $(el).attr('src') ||
      $(el).attr('data-src') ||
      $(el).attr('data-lazy') || '';

    if (!src || src.startsWith('data:')) return;

    const absUrl = src.startsWith('http') ? src : (
      src.startsWith('//') ? 'https:' + src : BASE + src
    );

    // Skip known non-product images
    const isNavImage = skipPatterns.some(p => absUrl.includes(p));
    if (isNavImage) return;

    if (!seenImages.has(absUrl)) {
      seenImages.add(absUrl);
      images.push(absUrl);
    }
  });

  // If gallery selectors found nothing (some pages use different markup),
  // fall back to any image under .product-detail-box that looks like a
  // catalog product image
  if (images.length === 0) {
    $('.product-detail-box img, .property-images img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      if (!src || src.startsWith('data:')) return;

      const absUrl = src.startsWith('http') ? src : BASE + src;
      const isNavImage = skipPatterns.some(p => absUrl.includes(p));
      if (isNavImage) return;

      if (absUrl.includes('/image/catalog/') && !seenImages.has(absUrl)) {
        seenImages.add(absUrl);
        images.push(absUrl);
      }
    });
  }

  // ── Specs — scoped to #tab-specification ONLY ────────────────
  // The page contains multiple tables (EMI offer table, related products
  // table, spec table). We scope strictly to #tab-specification so only
  // the actual product specs are captured.
  //
  // Spec table structure:
  //   <div id="tab-specification">
  //     <table class="table">
  //       <thead><tr><td colspan="2"><strong>Processor</strong></td></tr></thead>
  //       <tbody>
  //         <tr><td>CPU</td><td>Ryzen 5</td></tr>
  //         ...
  //       </tbody>
  //     </table>
  //   </div>
  const specs = {};

  // Skip numeric-only keys — those come from the EMI table (1, 2, 3...)
  $('#tab-specification table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return; // header row with colspan

    const key   = cleanText($(cells[0]).text());
    const value = cleanText($(cells[cells.length - 1]).text());

    if (!key || !value || key === value) return;

    // Skip EMI table rows — their keys are plain numbers like "1", "2"
    if (/^\d+$/.test(key)) return;

    // Skip the heading row that spans columns (e.g. "Processor", "Memory")
    if ($(row).find('td[colspan]').length) return;

    specs[key] = value;
  });

  // ── Short Description ────────────────────────────────────────
  // <div id="tab-description"><p>...</p></div>
  // Use first meaningful paragraph (skip very short fragments)
  let shortDescription = null;
  $('#tab-description p').each((_, el) => {
    const text = cleanText($(el).text());
    if (text && text.length > 40 && !shortDescription) {
      shortDescription = text;
    }
  });

  // ── Tags ─────────────────────────────────────────────────────
  // <div id="tab-tag"><span class="tag-item"><a href="...">Ryzen-5</a></span></div>
  const tags = [];
  $('#tab-tag .tag-item a').each((_, el) => {
    const tag = cleanText($(el).text());
    if (tag) tags.push(tag);
  });

  return {
    url,
    store: 'mdcomputers',

    name,

    // All three field names kept for compatibility with competitorPriceService.js
    // which reads: product.productCode || product.sku
    sku        : productCode,
    model      : productCode,
    modelNumber: productCode,
    productCode,

    brand,
    category,   // real category from breadcrumb, NOT hardcoded "Processor"
    stockStatus,

    salePrice,
    originalPrice,
    discountBadge,

    shortDescription,
    tags,
    images,     // only real product gallery images
    specs,      // only from #tab-specification, numeric keys excluded

    scrapedAt : new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };