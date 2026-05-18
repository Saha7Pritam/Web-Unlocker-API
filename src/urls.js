// ─────────────────────────────────────────────────────────────
//  urls.js  —  Master store + category config
//
//  To add a new store:
//    1. Add a new entry to STORES array below
//    2. Create src/parsers/<storename>.js with 3 exports:
//         parseProductLinks(html)            → string[]
//         getNextPageUrl(html, currentUrl)   → string | null
//         parseProductDetails(html, url)     → object
//    3. No freeScrapable flag needed — Web Unlocker handles everything
// ─────────────────────────────────────────────────────────────

const STORES = [
  {
    name: "primeabgb",
    parser: require("./parsers/primeabgb"),
    categories: [
      {
        slug: "cpu-processor",
        url: "https://www.primeabgb.com/buy-online-price-india/cpu-processor/",
      },
      {
        slug: "ram-memory",
        url: "https://www.primeabgb.com/buy-online-price-india/ram-memory/",
      },
      // { slug: 'motherboards',  url: 'https://www.primeabgb.com/buy-online-price-india/motherboards/' },
      // { slug: 'graphic-cards', url: 'https://www.primeabgb.com/buy-online-price-india/graphic-cards-gpu/' },
      // { slug: 'hdd',           url: 'https://www.primeabgb.com/buy-online-price-india/internal-hard-drive/' },
    ],
  },

  {
    name: "mdcomputers",
    parser: require("./parsers/mdcomputers"),
    categories: [
      {
        slug: "cpu-processor",
        url: "https://mdcomputers.in/catalog/processor",
      },
      // { slug: 'motherboards',  url: 'https://mdcomputers.in/catalog/motherboard' },
      { slug: "ram-memory", url: "https://mdcomputers.in/catalog/ram" },
    ],
  },

  // {
  //   name  : 'pickpcparts',
  //   parser: require('./parsers/pickpcparts'),
  //   categories: [
  //     { slug: 'cpu-processor', url: 'https://pickpcparts.in/processors/' },
  //     { slug: 'ram-memory',    url: 'https://pickpcparts.in/rams/' },
  //     // { slug: 'motherboards',  url: 'https://pickpcparts.in/motherboards/' },
  //     // { slug: 'graphic-cards', url: 'https://pickpcparts.in/graphics_cards/' },
  //     // { slug: 'storages',      url: 'https://pickpcparts.in/storages/' },
  //     // { slug: 'keyboards',     url: 'https://pickpcparts.in/keyboards/' },
  //     // { slug: 'mice',          url: 'https://pickpcparts.in/mice/' },
  //   ],
  // },

  {
    name: "vedant",
    parser: require("./parsers/vedant"),
    categories: [
      {
        slug: "cpu-processor",
        url: "https://www.vedantcomputers.com/pc-components/processor",
      },
      {
        slug: "ram-memory",
        url: "https://www.vedantcomputers.com/pc-components/memory",
      },
    ],
  },

  {
    name: "vishal",
    parser: require("./parsers/vishal"),
    categories: [
      {
        slug: "cpu-processor",
        url: "https://vishalperipherals.com/collections/processors",
      },
      {
        slug: "ram-memory",
        url: "https://vishalperipherals.com/collections/ram",
      },
    ],
  },

  // {
  //   name  : 'computechstore',
  //   parser: require('./parsers/computechstore'),
  //   categories: [
  //     {
  //       slug: 'cpu-processor',
  //       url : 'https://computechstore.in/product-category/processor'
  //     },
  //   ],
  // },

  // To add a new store Example:
  // {
  //   name  : 'vedant',
  //   parser: require('./parsers/vedant'),
  //   categories: [
  //     { slug: 'cpu-processor', url: 'https://www.vedantcomputers.com/...' },
  //   ],
  // },

  {
    name: "pcstudio",
    parser: require("./parsers/pcstudio"),
    categories: [
      {
        slug: "cpu-processor",
        url: "https://www.pcstudio.in/product-category/processor/",
      },
      {
        slug: "ram-memory",
        url: "https://www.pcstudio.in/product-category/ram/",
      },
    ],
  },

  // {
  //   name  : 'elitehubs',
  //   parser: require('./parsers/elitehubs'),
  //   categories: [
  //     {
  //       slug: 'cpu-processor',
  //       url : 'https://elitehubs.com/collections/processor'
  //     },
  //   ],
  // },
];

module.exports = { STORES };
