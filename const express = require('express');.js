const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cheerio = require('cheerio');
const fs = require('fs');
const XLSX = require('xlsx');

// Use stealth plugin to bypass Cloudflare
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 3000;

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Store scraping status
let scrapingStatus = {
    isRunning: false,
    progress: 0,
    totalCategories: 0,
    completedCategories: 0,
    currentCategory: '',
    currentCategoryProgress: '',
    productsFound: 0,
    medicationProducts: 0,
    careProducts: 0,
    message: 'Ready to start',
    startTime: null,
    endTime: null
};

// MatIDs that need to be scraped from old aversi.ge site
// These MatIDs don't exist or have different structure on shop.aversi.ge
const OLD_SITE_MATIDS = [
    // Original confirmed old site MatIDs
    90414, 36365, 77087, 138462, 9321, 28558, 79097, 999, 469, 15222,
    42353, 6669, 2807, 36357, 36356, 292, 125745, 86380, 80616,
    82920, 135757, 134837, 4628, 29687, 22836, 148602, 50631, 80568, 72737
];

// Helper function to detect and wait for Cloudflare challenge
async function waitForCloudflare(page) {
    try {
        // Check if we're on a Cloudflare challenge page
        const title = await page.title();
        
        if (title.includes('Just a moment') || title.includes('Verify you are human')) {
            console.log(`  ⚠️ Cloudflare challenge detected, waiting...`);
            
            // Wait for the challenge to complete (max 30 seconds)
            await page.waitForFunction(
                () => !document.title.includes('Just a moment') && 
                      !document.title.includes('Verify you are human'),
                { timeout: 30000 }
            ).catch(() => {
                console.log(`  ⚠️ Cloudflare challenge timeout - continuing anyway`);
            });
            
            // Additional wait after challenge
            await delay(3000);
            console.log(`  ✅ Cloudflare challenge passed`);
            return true;
        }
        
        return false;
    } catch (error) {
        console.log(`  ⚠️ Error checking Cloudflare: ${error.message}`);
        return false;
    }
}

// Helper function for delay
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to clean text (removes multiple spaces, tabs, newlines)
function cleanText(text) {
    if (!text) return '';
    // Convert to string if it's a number
    if (typeof text === 'number') return String(text);
    // Return as-is if not a string
    if (typeof text !== 'string') return text;
    
    return text
        .replace(/\r\n/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\r/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+#/g, ' #')
        .replace(/^\s+|\s+$/g, '');
}

// Helper function to clean and format prices
function cleanPrice(priceText) {
    if (!priceText) return '';

    // Convert to string and clean spaces
    let price = String(priceText).replace(/\s+/g, '').replace(/₾|ლარი/g, '');

    // Replace comma with dot if needed
    if (price.includes(',') && !price.includes('.')) {
        price = price.replace(',', '.');
    } else {
        price = price.replace(/,/g, '');
    }

    // Parse to float
    let priceNumber = parseFloat(price);
    if (isNaN(priceNumber)) return '';

    // Round to 2 decimals
    priceNumber = Math.round(priceNumber * 100) / 100;

    // Return formatted as string with 2 decimals
    return priceNumber.toFixed(2);
}
// Parse OLD site (aversi.ge) HTML file with Cheerio
async function parseOldSiteMatID(filename, matID) {
    try {
        console.log(`  🔍 Parsing OLD SITE MatID ${matID}...`);
        
        const html = fs.readFileSync(filename, 'utf-8');
        const $ = await cheerio.load(html);
         
        // Check if product-summary exists (old site structure)
        const productSummary = $('.product-summary');
         
        if (productSummary.length === 0) {
            console.log(`  ⚠️ No .product-summary found for MatID ${matID}`);
            
            // Debug: Save HTML to check what we received
            const debugDir = path.join(__dirname, 'debug');
            if (!fs.existsSync(debugDir)) {
                fs.mkdirSync(debugDir);
            }
            const debugFile = path.join(debugDir, `failed_old_${matID}.html`);
            fs.writeFileSync(debugFile, html);
            console.log(`  📝 Saved debug HTML to: ${debugFile}`);
            
            return null;
        }
      
        const title = $('.product-title').text().trim() || '';
        const priceOldRaw = $('.price del').text().trim() || '';
        const priceRaw = $('.price .amount.text-theme-colored').text().trim() || '';
        
        if (!title) {
            console.log(`  ⚠️ No title found for MatID ${matID}`);
            return null;
        }
        
        const product = {
            productCode: String(matID),  // Convert to string
            title: title,
            price: priceRaw,
            priceOld: priceOldRaw,
            category: '',
            pageNum: '',
            source: 'aversi.ge'
        };
        
        console.log(`  ✓ Extracted from OLD SITE: ${title.substring(0, 40)}...`);
        return product;
        
    } catch (error) {
        console.error(`  ✗ Error parsing OLD SITE MatID ${matID}:`, error.message);
        return null;
    }
}

// Parse NEW site (shop.aversi.ge) HTML file with Cheerio
async function parseNewSiteMatID(filename, matID) {
    try {
        console.log(`  🔍 Parsing NEW SITE MatID ${matID}...`);
        
        const html = fs.readFileSync(filename, 'utf-8');
        const $ = await cheerio.load(html);
         
        // Check if product-title exists (new site structure)
        const productSummary = $('.ty-product-block-title');
         
        if (productSummary.length === 0) {
            console.log(`  ⚠️ No .ty-product-block-title found for MatID ${matID}`);
            return null;
        }
        
        const el = $('[data-ca-product-id]');
        const id = el.attr('data-ca-product-id');
        
        const title = $('.ty-product-block-title > bdi').text().trim() || '';
        const priceOldRaw = $('#sec_list_price_' + id).text().trim() || '';
        const priceRaw = $('#sec_discounted_price_' + id).text().trim() || '';
        
        if (!title) {
            console.log(`  ⚠️ No title found for MatID ${matID}`);
            return null;
        }
        
        const product = {
            productCode: String(matID),  // Convert to string
            title: title,
            price: priceRaw,
            priceOld: priceOldRaw,
            category: '',
            pageNum: '',
            source: 'shop.aversi.ge'
        };
        
        console.log(`  ✓ Extracted from NEW SITE: ${title.substring(0, 40)}...`);
        return product;
        
    } catch (error) {
        console.error(`  ✗ Error parsing NEW SITE MatID ${matID}:`, error.message);
        return null;
    }
}

// Scrape OLD SITE MatIDs separately
 async function scrapeOldSiteMatIDs(matIDs) {
     const allProducts = [];
         let successCount = 0;
    let failCount = 0;
  const browser = await puppeteer.launch({
    headless: false, // for debugging; later can use "new" headless
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36"
  );

for (const id of matIDs) {
  const url = `https://www.aversi.ge/ka/aversi/act/drugDet/?MatID=${id}`;

  try {
    console.log(`Scraping MatID ${id}...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 🧠 Check if we're on a Cloudflare waiting page
    const title = await page.title();
    if (title.includes("Just a moment")) {
      console.log(`⚠️ Cloudflare challenge detected for MatID ${id}, waiting...`);
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 120000 }).catch(() => {});
      await new Promise(res => setTimeout(res, 3000));
    }

    const html = await page.content();
    if (html.includes("Please unblock challenges.cloudflare.com")) {
      console.warn(`🚫 Blocked by Cloudflare on ${url}`);
      continue;
    }

            const tempDir = path.join(__dirname, 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir);
            }
            
            filename = path.join(tempDir, `new_matid_${id}.html`);
            fs.writeFileSync(filename, html);

            // ✅ Successfully loaded
            console.log(`✅ Successfully scraped ${id}`);
            // parse or save HTML here

                const product = await parseOldSiteMatID(filename, id);
            
            if (product) {
                allProducts.push(product);
                successCount++;
                console.log(`  ✅ Success (${successCount}/${id + 1})`);
            } else {
                failCount++;
                console.log(`  ❌ Failed to extract (${failCount}/${id + 1})`);
            }
            
            // Clean up
            try {
                fs.unlinkSync(filename);
            } catch (e) {}


  } catch (err) {
    console.error(`❌ Error scraping ${id}:`, err.message);
  }

  await new Promise(res => setTimeout(res, 3000));
}


  await browser.close();
   return allProducts;
}

// Scrape NEW SITE MatIDs separately
async function scrapeNewSiteMatIDs(browser, matIDs) {
    console.log(`\n🆕 ═══════════════════════════════════════════════════════`);
    console.log(`🆕  NEW SITE Scraping (shop.aversi.ge)`);
    console.log(`🆕  Total MatIDs: ${matIDs.length}`);
    console.log(`🆕 ═══════════════════════════════════════════════════════\n`);
    
    const allProducts = [];
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < matIDs.length; i++) {
        const matid = matIDs[i];
        console.log(`\n[${i + 1}/${matIDs.length}] 🆕 NEW SITE MatID: ${matid}`);
        
        const url = `https://shop.aversi.ge/?dispatch=aversi.redirect&matid=${matid}`;
        let page;
        let filename;
        
        try {
            // Download HTML
            page = await browser.newPage();
            
            // Enhanced Cloudflare bypass settings
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            // Set additional headers
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            });
            
            // Override navigator properties
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => false,
                });
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
            });
            
            console.log(`  📥 Downloading from shop.aversi.ge...`);
            
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            // Wait for Cloudflare challenge
            await waitForCloudflare(page);
            
            await delay(3000); // Longer delay for Cloudflare
            
            const html = await page.content();
            
            const tempDir = path.join(__dirname, 'temp');
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir);
            }
            
            filename = path.join(tempDir, `new_matid_${matid}.html`);
            fs.writeFileSync(filename, html);
            
            await page.close();
            
            // Parse HTML
            const product = await parseNewSiteMatID(filename, matid);
            
            if (product) {
                allProducts.push(product);
                successCount++;
                console.log(`  ✅ Success (${successCount}/${i + 1})`);
            } else {
                failCount++;
                console.log(`  ❌ Failed to extract (${failCount}/${i + 1})`);
            }
            
            // Clean up
            try {
                fs.unlinkSync(filename);
            } catch (e) {}
            
        } catch (error) {
            console.error(`  ✗ Error:`, error.message);
            if (page) await page.close();
            failCount++;
        }
        
        // Longer delay between requests to avoid being blocked
        //await delay(2000);
    }
    
    console.log(`\n🆕 ═══════════════════════════════════════════════════════`);
    console.log(`🆕  NEW SITE Scraping Complete!`);
    console.log(`🆕  Success: ${successCount}`);
    console.log(`🆕  Failed: ${failCount}`);
    console.log(`🆕  Total: ${allProducts.length} products`);
    console.log(`🆕 ═══════════════════════════════════════════════════════\n`);
    
    return allProducts;
}

// Main MatID scraping function - calls separate functions for each site
async function getRandomNumber(browser) {   
    // Numbers array - contains only NEW SITE MatIDs
    // OLD SITE MatIDs are defined in OLD_SITE_MATIDS constant
    const numbers = [
        840, 1430, 96491, 66872, 14893, 65022, 10337, 23566,
        134819, 25699, 65244, 22390, 82202, 97431, 25015, 127792, 571, 14668, 14666,
        36919, 5724, 15945, 28072, 28137, 26991, 128831,
        8311, 75884, 77116, 66869, 80418, 80416, 85636, 97628, 89579,
        89581, 71410, 50033, 89966, 29621, 70160, 146981, 90147, 7216, 90116,
        89049, 71587, 76882, 84113, 66145, 85390, 32261, 796,
        427, 76435, 71524, 52533, 147086, 24964, 81341, 146583, 68526, 129110,
        129109, 95878, 42301, 85354, 97659, 42547, 80464, 65449, 65465,
        93761, 2618, 347, 97808, 49372, 9486, 1365, 2131, 17186, 77882,
        89108, 89061, 37891, 82964, 126938, 133507, 86790, 14098, 1534, 87241,
        42036, 83338, 92818, 135572, 91694, 78392, 83452, 95782, 88777, 97200, 70560,
        74765, 74767, 129957, 69013, 137348, 72396, 82695, 82526, 76144, 55076,
        125736, 69624, 93324, 13017, 88254, 49841, 145, 873, 6129, 88327,
        12388, 136440, 136441, 12887, 75821, 72031, 30485, 2341, 80576, 97027, 73779,
        134314, 19506, 75905, 78423, 140424, 129333, 75826, 11539, 8393,
        69931, 93447, 31021, 89843, 92644, 80585, 130112, 143475, 11687,
        66041, 77717, 123743, 73959, 92272, 128592, 97272, 29131, 130768,
        3718, 8356, 71104, 11267, 126930, 80636,
        96760, 23848, 17152, 86364, 86363, 96475, 130115, 89377, 26984,
        74264, 6932, 90846, 82865, 82091, 72222, 51799, 38642, 97178,
        97179, 86381, 97180, 37399, 78125, 74768, 143132,661,1466,82756
    ];

    // Total MatIDs = OLD_SITE_MATIDS + numbers
    const totalMatIDs = OLD_SITE_MATIDS.length + numbers.length;
    
    console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║          MatID Scraping - SEPARATE SITE FUNCTIONS        ║`);
    console.log(`╠═══════════════════════════════════════════════════════════╣`);
    console.log(`║  Total MatIDs: ${totalMatIDs}                                       ║`);
    console.log(`║  🏛️  OLD SITE (aversi.ge): ${OLD_SITE_MATIDS.length} MatIDs                   ║`);
    console.log(`║  🆕 NEW SITE (shop.aversi.ge): ${numbers.length} MatIDs              ║`);
    console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
    
    const allProducts = [];
    
    // Scrape OLD SITE MatIDs separately
    if (OLD_SITE_MATIDS.length > 0) {
        const oldSiteProducts = await scrapeOldSiteMatIDs(OLD_SITE_MATIDS);
        allProducts.push(...oldSiteProducts);
    }
    
    // Scrape NEW SITE MatIDs separately (from numbers array)
    if (numbers.length > 0) {
        const newSiteProducts = await scrapeNewSiteMatIDs(browser, numbers);
        allProducts.push(...newSiteProducts);
    }
    
    console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
    console.log(`║          MatID Scraping - FINAL SUMMARY                  ║`);
    console.log(`╠═══════════════════════════════════════════════════════════╣`);
    console.log(`║  🏛️  OLD SITE: ${allProducts.filter(p => p.source === 'aversi.ge').length} products                            ║`);
    console.log(`║  🆕 NEW SITE: ${allProducts.filter(p => p.source === 'shop.aversi.ge').length} products                           ║`);
    console.log(`║  📦 TOTAL: ${allProducts.length} products                               ║`);
    console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
    
    return allProducts;
}

// Download HTML with Puppeteer
async function downloadPageHTML(browser, category, pageNum, perpage = 192) {
    const url = `${category}page-${pageNum}/?items_per_page=${perpage}&sort_by=product&sort_order=asc`;
    let page;
    
    try {
        page = await browser.newPage();
        
        // Enhanced Cloudflare bypass settings
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Set additional headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });
        
        // Override navigator properties
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
        });
        
        console.log(`Downloading ${category} page ${pageNum}...`);
        scrapingStatus.message = `Downloading ${category} page ${pageNum}...`;
        
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        // Wait for Cloudflare challenge
        await waitForCloudflare(page);
        
        await delay(3000);
        
        const html = await page.content();
        
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        const filename = path.join(tempDir, `page_${pageNum}.html`);
        fs.writeFileSync(filename, html);
        console.log(`✓ Saved: ${filename} (${Math.round(html.length / 1024)} KB)`);
        
        await page.close();
        return filename;
        
    } catch (error) {
        console.error(`✗ Error downloading page ${pageNum}:`, error.message);
        if (page) await page.close();
        return null;
    }
}

// Parse HTML file with Cheerio
function parseHTMLFile(filename, category, pageNum) {
    try {
        console.log(`🔍 Parsing ${path.basename(filename)}...`);
        
        const html = fs.readFileSync(filename, 'utf-8');
        const $ = cheerio.load(html);
        
        const products = [];
        
        const colTiles = $('.col-tile');
        console.log(`   Found ${colTiles.length} .col-tile elements on page`);
        
        $('.col-tile').each((index, element) => {
            const $el = $(element);
            
            const titleRaw = $el.find('.product-title').text() || '';
            const title = cleanText(titleRaw);
            
            const priceOldRaw = $el.find('.ty-list-price:last-child').text() || '';
            const priceOld = cleanPrice(priceOldRaw);
            
            const priceRaw = $el.find('.ty-price-num').text() || '';
            const price = cleanPrice(priceRaw);
        
            const productCode = $el.find('input[name$="[product_code]"]').val() || ''; 
       
            const product = {
                productCode: cleanText(productCode),
                title: title,
                price: price,
                priceOld: priceOld,
                category: category,
                pageNum: String(pageNum),  // Convert to string
                source: 'shop.aversi.ge'
            };
            
            // Only add products with titles
            if (title && title.length > 0) {
                products.push(product);
            }
        });
        
        console.log(`   ✓ Extracted ${products.length} valid products with titles`);
        
        scrapingStatus.medicationProducts += products.length;
        scrapingStatus.productsFound += products.length;
        
        return products;
        
    } catch (error) {
        console.error(`✗ Error parsing ${filename}:`, error.message);
        return [];
    }
}

// Get categories from main page
async function getCategories(browser) {
    let page;
    
    try {
        page = await browser.newPage();
        
        // Enhanced Cloudflare bypass settings
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Set additional headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        });
        
        // Override navigator properties
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            Object.defineProperty(navigator, 'plugins', {
                get: () => [1, 2, 3, 4, 5],
            });
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en'],
            });
        });
        
        console.log('🔍 Fetching categories from main page...');
        
        await page.goto('https://shop.aversi.ge/ka/', {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        // Wait for Cloudflare challenge
        await waitForCloudflare(page);
        
        await delay(3000);
        
        const html = await page.content();
        
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        const filename = path.join(tempDir, `categories.html`);
        fs.writeFileSync(filename, html);
        
        await page.close();
        
        // Parse categories
        const $ = cheerio.load(html);
        const categories = [];
        
        $('.ty-menu__submenu-item .ty-menu__submenu-link').each((i, el) => {
            const href = $(el).attr('href');
            
            if (href && href.includes('/ka/')) {
                const match = href.match(/\/ka\/([^/]+)/);
               
                if (match && match[1]) {
                    if(href.includes('medication')){
                        if(href !== "https://shop.aversi.ge/ka/medication/for-cardiovascular-diseases/pressure-regulators/")
                        categories.push({category:href,startPage: 1, endPage: 50, perpage: 192,pages:50});
                    }
                }
            }
        });
        
        console.log(`✓ Found ${categories.length} categories from dynamic scraping`);
 
        categories.push({category: 'https://shop.aversi.ge/ka/medication/მედიკამენტები-სხვადასხვა/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/homeopathic-remedies/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/for-cardiovascular-diseases/pressure-regulators/', startPage: 1, endPage: 20, perpage: 24,pages:20});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/various-medicinal-products/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/child-care/child-care-hygiene-products/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/oral-care/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/skin-care-products/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/drugs-stimulating-the-production-of-blood-cells/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/deodorant-antiperspirant/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/oral-care/toothpaste/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/oral-care/denture-adhesive/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/care-items-and-products/care-products-and-equipment/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/skin-care-products/skin-care-products-ka-17/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/skin-care-products/skin-care-products-ka-13/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        // Remove duplicates
        const uniqueCategories = categories.filter(
            (item, index, self) =>
                index === self.findIndex(obj => obj.category === item.category)
        );
        
        console.log(`✓ ${uniqueCategories.length} unique categories after deduplication`);
        
        return uniqueCategories;
        
    } catch (error) {
        console.error('❌ Error fetching categories:', error.message);
        if (page) await page.close();
        return [];
    }
}

// Main scraping function for multiple categories
async function scrapeAllCategories(browser, categories) {
    scrapingStatus.isRunning = true;
    scrapingStatus.startTime = Date.now();
    scrapingStatus.completedCategories = 0;
    scrapingStatus.totalCategories = categories.length;
    scrapingStatus.productsFound = 0;
    scrapingStatus.medicationProducts = 0;
    scrapingStatus.careProducts = 0;
    scrapingStatus.progress = 0;
    
    const allProducts = [];
    let successfulPages = 0;
    let failedPages = [];
    let totalPagesScraped = 0;
    
    console.log('📊 Discovered categories:', categories.length);
    
    // Scrape MatID products first
    console.log('🔍 Starting MatID scraping (DUAL SITE)...');
    const staticProducts = await getRandomNumber(browser);
    allProducts.push(...staticProducts);
    console.log(`✓ Added ${staticProducts.length} MatID products to results`);
    
    console.log('\n🚀 Starting category scraping...');
    
    // Process each category
    for (let catIndex = 0; catIndex < categories.length; catIndex++) {
        const categoryConfig = categories[catIndex];
        const { category, startPage, endPage, perpage } = categoryConfig;
        
        console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
        console.log(`║  Category [${catIndex + 1}/${categories.length}]: ${category.substring(0, 30).padEnd(30)} ║`);
        console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
        
        scrapingStatus.currentCategory = category;
        scrapingStatus.currentCategoryProgress = `Page 0/${endPage - startPage + 1}`;
        
        // Update progress at the start of each category
        scrapingStatus.completedCategories = catIndex;
        scrapingStatus.progress = Math.round((catIndex / categories.length) * 100);
        
        for (let page = startPage; page <= endPage; page++) {
            const currentPageInCategory = page - startPage + 1;
            const totalPagesInCategory = endPage - startPage + 1;
            
            scrapingStatus.currentCategoryProgress = `Page ${currentPageInCategory}/${totalPagesInCategory}`;
            
            console.log(`\n[Category ${catIndex + 1}/${categories.length}] [Page ${currentPageInCategory}/${totalPagesInCategory}] Processing ${category} page ${page}...`);
            
            const filename = await downloadPageHTML(browser, category, page, perpage);
            
            if (filename) {
                scrapingStatus.message = `Category ${catIndex + 1}/${categories.length} - Page ${currentPageInCategory}/${totalPagesInCategory}`;
                const products = parseHTMLFile(filename, category, page);
                
                console.log(`📦 Parsed ${products.length} products from this page`);
                
                if (products && products.length > 0) {
                    allProducts.push(...products);
                    successfulPages++;
                    totalPagesScraped++;
                    console.log(`✓ Total so far: ${allProducts.length} products from ${successfulPages} pages`);
                    
                    // Stop if less than perpage products found (last page)
                    if (products.length < perpage) {
                        console.log(`⚠️ Found ${products.length} < ${perpage} products, stopping this category (reached last page)`);
                        fs.unlinkSync(filename);
                        break;
                    }
                } else {
                    console.log(`✗ No products found on ${category} page ${page} - stopping category`);
                    failedPages.push(`${category}-${page}`);
                    fs.unlinkSync(filename);
                    break;
                }
                
                // Clean up temp file
                try {
                    fs.unlinkSync(filename);
                } catch (e) {
                    console.log(`⚠️ Could not delete temp file: ${filename}`);
                }
            } else {
                console.log(`❌ Failed to download page ${page} of ${category}`);
                failedPages.push(`${category}-${page}`);
                break; // Stop this category if download fails
            }
            
            // Delay between requests (skip on last page of category)
            if (page < endPage) {
                console.log(`⏳ Waiting 3 seconds...`);
                await delay(3000);
            }
        }
        
        // Category completed - update progress
        scrapingStatus.completedCategories = catIndex + 1;
        scrapingStatus.progress = Math.round(((catIndex + 1) / categories.length) * 100);
        console.log(`\n✓ Category ${catIndex + 1}/${categories.length} completed! Progress: ${scrapingStatus.progress}%`);
    }
    
    await browser.close();
    
    scrapingStatus.endTime = Date.now();
    scrapingStatus.isRunning = false;
    scrapingStatus.progress = 100;
    
    return { allProducts, successfulPages, failedPages, totalPages: totalPagesScraped };
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// GET /aversi - Main scraping endpoint
app.get('/aversi', async (req, res) => {
    if (scrapingStatus.isRunning) {
        return res.status(400).json({
            error: 'Scraping is already in progress',
            status: scrapingStatus
        });
    }
    
    try {
        const browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--flag-switches-begin --disable-site-isolation-trials --flag-switches-end'
            ],
            ignoreDefaultArgs: ['--enable-automation'],
            ignoreHTTPSErrors: false
        });
        
        // Get categories dynamically
        const categories = await getCategories(browser);
        
        if (categories.length === 0) {
            return res.status(404).json({ error: 'No categories found' });
        }
        
        // Save categories to file
        const dataDir = path.join(__dirname, 'public', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        
        const jsonPath = path.join(dataDir, 'categories.json');
        fs.writeFileSync(jsonPath, JSON.stringify(categories, null, 2));
        
        // Start scraping in background
        res.json({
            message: `Found ${categories.length} categories. Scraping started.`,
            categories: categories,
            status: scrapingStatus
        });
        
        // Run scraping asynchronously
        scrapeAllCategories(browser, categories).then(({ allProducts, successfulPages, failedPages, totalPages }) => {
            const duration = ((scrapingStatus.endTime - scrapingStatus.startTime) / 1000 / 60).toFixed(2);
            
            if (allProducts.length > 0) {
                const cleanedProducts = allProducts.map(product => ({
                    ...product,
                    title: cleanText(product.title),
                    productCode: cleanText(product.productCode),
                    price: cleanPrice(product.price),
                    priceOld: cleanPrice(product.priceOld)
                }));
                
                // Save JSON
                const jsonPath = path.join(dataDir, 'aversi_products.json');
                fs.writeFileSync(jsonPath, JSON.stringify(cleanedProducts, null, 2));
                
                // Create Excel file
                const workbook = XLSX.utils.book_new();
                
                const allWorksheet = XLSX.utils.json_to_sheet(cleanedProducts);
                XLSX.utils.book_append_sheet(workbook, allWorksheet, 'All Products');
                
                const medications = cleanedProducts.filter(p => p.category && p.category.includes('medication'));
                const medWorksheet = XLSX.utils.json_to_sheet(medications);
                XLSX.utils.book_append_sheet(workbook, medWorksheet, 'Medications');
                
                const careProducts = cleanedProducts.filter(p => p.category && p.category.includes('care-products'));
                const careWorksheet = XLSX.utils.json_to_sheet(careProducts);
                XLSX.utils.book_append_sheet(workbook, careWorksheet, 'Care Products');
                
                // Add source column info
                const oldSiteProducts = cleanedProducts.filter(p => p.source === 'aversi.ge');
                if (oldSiteProducts.length > 0) {
                    const oldSiteWorksheet = XLSX.utils.json_to_sheet(oldSiteProducts);
                    XLSX.utils.book_append_sheet(workbook, oldSiteWorksheet, 'Old Site Products');
                }
                
                const wscols = [
                    { wch: 15 },  // productCode
                    { wch: 50 },  // title
                    { wch: 15 },  // price
                    { wch: 10 },  // priceOld
                    { wch: 40 },  // category
                    { wch: 10 },  // pageNum
                    { wch: 20 }   // source
                ];
                allWorksheet['!cols'] = wscols;
                medWorksheet['!cols'] = wscols;
                careWorksheet['!cols'] = wscols;
                
                const xlsxPath = path.join(dataDir, 'aversi_products.xlsx');
                XLSX.writeFile(workbook, xlsxPath);
                
                const withPrice = cleanedProducts.filter(p => p.price).length;
                const withDiscount = cleanedProducts.filter(p => p.priceOld && p.priceOld !== p.price).length;
                const withProductCode = cleanedProducts.filter(p => p.productCode).length;
                const fromOldSite = oldSiteProducts.length;
                const fromNewSite = cleanedProducts.filter(p => p.source === 'shop.aversi.ge').length;
                
                scrapingStatus.message = `Completed! Scraped ${cleanedProducts.length} products in ${duration} minutes`;
                scrapingStatus.statistics = {
                    totalProducts: cleanedProducts.length,
                    medicationProducts: medications.length,
                    careProducts: careProducts.length,
                    pagesScraped: successfulPages,
                    failedPages: failedPages,
                    duration: duration,
                    withPrice: withPrice,
                    withDiscount: withDiscount,
                    withProductCode: withProductCode,
                    fromOldSite: fromOldSite,
                    fromNewSite: fromNewSite
                };
            } else {
                scrapingStatus.message = 'No products were scraped';
            }
        }).catch(error => {
            console.error('Scraping error:', error);
            scrapingStatus.isRunning = false;
            scrapingStatus.message = `Error: ${error.message}`;
        });
        
    } catch (error) {
        console.error('Error starting scraper:', error);
        res.status(500).json({ 
            error: 'Failed to start scraping',
            details: error.message 
        });
    }
});

// Status endpoint
app.get('/aversi/status', (req, res) => {
    res.json(scrapingStatus);
});

// Get scraped data
app.get('/aversi/data', (req, res) => {
    const jsonPath = path.join(__dirname, 'public', 'data', 'aversi_products.json');
    
    if (fs.existsSync(jsonPath)) {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        res.json({
            success: true,
            count: data.length,
            products: data.slice(0, 100),
            message: `Showing first 100 of ${data.length} products`
        });
    } else {
        res.status(404).json({
            success: false,
            message: 'No data available. Please run the scraper first.'
        });
    }
});

// Download endpoints
app.get('/aversi/download/json', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'data', 'aversi_products.json');
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

app.get('/aversi/download/excel', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'data', 'aversi_products.xlsx');
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// Clean temp directory on startup
const tempDir = path.join(__dirname, 'temp');
if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
}

// Start server
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║         Aversi Pharmacy Scraper Web Service               ║
║                   DUAL SITE SUPPORT                       ║
║                                                           ║
║  Server running at: http://localhost:${PORT}              ║
║                                                           ║
║  Scraping from:                                           ║
║  🏛️  aversi.ge (old site) - ${OLD_SITE_MATIDS.length} MatIDs                    ║
║  🆕 shop.aversi.ge (new site) - All others               ║
║                                                           ║
║  API Endpoints:                                           ║
║  GET  /aversi         - Start scraping                    ║
║  GET  /aversi/status  - Check scraping status             ║
║  GET  /aversi/data    - Get scraped data                  ║
║  GET  /aversi/download/json  - Download JSON file         ║
║  GET  /aversi/download/excel - Download Excel file        ║
╚═══════════════════════════════════════════════════════════╝
    `);
});