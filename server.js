const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const XLSX = require('xlsx');
const { all } = require('axios');

const app = express();
const PORT = 3000;

// Serve static files
app.use(express.static('public'));
app.use(express.json());


async function  getRandomNumber() {   
    const numbers = [
  840, 1430, 96491, 90414, 1466, 66872, 14893, 65022, 36365, 10337, 23566,
  134819, 25699, 65244, 22390, 82202, 97431, 25015, 127792, 571, 14668, 14666,
  36919, 5724, 15945, 28072, 28137, 77087, 138462, 9321, 26991, 28558, 128831,
  8311, 75884, 77116, 66869, 79097, 80418, 80416, 999, 85636, 97628, 89579,
  89581, 71410, 50033, 89966, 469, 29621, 70160, 146981, 90147, 7216, 90116,
  15222, 89049, 71587, 76882, 84113, 66145, 85390, 32261, 796, 42353, 42353,
  427, 76435, 71524, 52533, 147086, 24964, 81341, 146583, 68526, 129110,
  129109, 6669, 95878, 42301, 85354, 97659, 2807, 42547, 80464, 65449, 65465,
  93761, 2618, 347, 97808, 36357, 36356, 49372, 9486, 1365, 2131, 17186, 77882,
  89108, 89061, 37891, 82964, 126938, 133507, 86790, 14098, 292, 1534, 87241,
  42036, 83338, 92818, 135572, 91694, 78392, 83452, 95782, 88777, 97200, 70560,
  74765, 74767, 129957, 69013, 137348, 72396, 82695, 82526, 76144, 55076,
  125736, 69624, 93324, 13017, 88254, 49841, 145, 125745, 873, 6129, 88327,
  12388, 136440, 136441, 12887, 75821, 72031, 30485, 2341, 80576, 97027, 73779,
  86380, 134314, 19506, 75905, 78423, 140424, 129333, 75826, 11539, 8393,
  69931, 93447, 80616, 31021, 89843, 92644, 80585, 130112, 143475, 11687,
  66041, 77717, 123743, 73959, 92272, 128592, 97272, 29131, 130768, 82920,
  3718, 8356, 71104, 135757, 11267, 134837, 4628, 29687, 126930, 22836, 80636,
  96760, 23848, 17152, 86364, 86363, 96475, 130115, 89377, 26984, 148602,
  74264, 50631, 6932, 90846, 82865, 82091, 72222, 51799, 38642, 80568, 97178,
  97179, 86381, 97180, 37399
];
    const allProducts = [];
    for (let matid of numbers) {
      const data = await getscrapeSingleMatID(matid);
      if (data.success && data.product) {
        allProducts.push(data.product);
        
      }
      
    }
    return allProducts;
}
async function getscrapeSingleMatID(matID, page) {
  const url = `https://www.aversi.ge/ka/aversi/act/drugDet/?MatID=${matID}`;
  const context = `MatID ${matID}`;

  return await safeRetry(async () => {
    await safeGoto(page, url, context);
    
    const hasProduct = await safeWaitForSelector(page, ".product-summary", 10000);
    if (!hasProduct) {
      console.log(`⚠️ No .product-summary found for MatID ${matID}`);
      return null;
    }

    const data = await page.evaluate((matID) => {
      const div = document.querySelector(".product-summary");
      if (!div) return null;

      const title = div?.querySelector(".product-title")?.innerText.trim() || "";
      const priceOld = div?.querySelector(".price del")?.innerText.replace("ლარი", "").replace(",", ".").trim() || "";
      const price = div?.querySelector(".price .amount.text-theme-colored")?.innerText.replace("ლარი", "").replace(",", ".").trim() || "";
      
      return { 
        matID, 
        title, 
        priceOld: priceOld || price, 
        price 
      };
    }, matID);

    return data;
  }, context);
}
// Store scraping status
let scrapingStatus = {
    isRunning: false,
    progress: 0,
    totalPages: 0,
    currentPage: 0,
    currentCategory: '',
    productsFound: 0,
    medicationProducts: 0,
    careProducts: 0,
    message: 'Ready to start',
    startTime: null,
    endTime: null
};

// Helper function for delay
async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to clean text (removes multiple spaces, tabs, newlines)
function cleanText(text) {
    if (!text) return '';
    return text
        .replace(/\r\n/g, ' ')     // Replace Windows newlines
        .replace(/\n/g, ' ')        // Replace Unix newlines
        .replace(/\r/g, ' ')        // Replace old Mac newlines
        .replace(/\t/g, ' ')        // Replace tabs with space
        .replace(/\s+/g, ' ')       // Replace multiple spaces with single space
        .replace(/\s+#/g, ' #')     // Fix spacing before #
        .replace(/^\s+|\s+$/g, ''); // Trim start and end
}

// Helper function to clean and format prices
function cleanPrice(priceText) {
    if (!priceText) return '';
    
    // First clean the text
    let price = cleanText(priceText);
    
    // Remove currency symbols
    price = price.replace(/₾/g, '').replace(/ლ/g, '');
    
    // Determine if comma is thousands separator or decimal separator
    // If we have both comma and dot, comma is thousands separator
    // If we only have comma with 2 digits after, it's decimal separator
    if (price.includes(',') && price.includes('.')) {
        // Comma is thousands separator, remove it
        price = price.replace(/,/g, '');
    } else if (price.match(/,\d{2}$/)) {
        // Comma is decimal separator (e.g., "15,90")
        price = price.replace(',', '.');
    } else {
        // Remove any other commas (thousands separators)
        price = price.replace(/,/g, '');
    }
    
    // Trim any remaining spaces
    price = price.trim();
    
    // Remove .00 at the end to get whole numbers
    if (price.endsWith('.00')) {
        price = price.slice(0, -3);
    }
    
    return price;
}

// Download HTML with Puppeteer
async function downloadPageHTML(browser, category, pageNum,perpage=192) {
    const url = `${category}page-${pageNum}/?items_per_page=${perpage}&sort_by=product&sort_order=asc`;
    let page;
    
    try {
        page = await browser.newPage();
        
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log(`Downloading ${category} page ${pageNum}...`);
        scrapingStatus.message = `Downloading ${category} page ${pageNum}...`;
        
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        await delay(2000);
        
        // Get HTML content
        const html = await page.content();
        
        // Save HTML file to temp directory
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
        console.log(`Parsing ${path.basename(filename)}...`);
        
        const html = fs.readFileSync(filename, 'utf-8');
        const $ = cheerio.load(html);
        
        const products = [];
        
        // Find all .col-tile elements
        $('.col-tile').each((index, element) => {
            const $el = $(element);
            
            // Get title and clean it up
            const titleRaw = $el.find('.product-title').text() || '';
            const title = cleanText(titleRaw);
            
            // Get old price
            const priceOldRaw = $el.find('.ty-list-price:last-child').text() || '';
            const priceOld = cleanPrice(priceOldRaw);
            
            // Get current price
            const priceRaw = $el.find('.ty-price-num').text() || '';
            const price = cleanPrice(priceRaw);
        
            // Get product code
            const productCode = $el.find('input[name$="[product_code]"]').val() || ''; 
       
            const product = {
                productCode: cleanText(productCode),
                title: title,
                category: category,
                price: price,
                priceOld: priceOld,
                pageNum: pageNum,
            };
            
            products.push(product);
        });
        
        console.log(`✓ Parsed ${products.length} products from ${path.basename(filename)}`);
        
        // Update category-specific counters
      
        scrapingStatus.medicationProducts += products.length;
      
        scrapingStatus.productsFound += products.length;
        return products;
        
    } catch (error) {
        console.error(`✗ Error parsing ${filename}:`, error.message);
        return [];
    }
}

// Main scraping function for multiple categories
async function scrapeAllCategories(browser,categories) {
    scrapingStatus.isRunning = true;
    scrapingStatus.startTime = Date.now();
    scrapingStatus.currentPage = 0;
    scrapingStatus.productsFound = 0;
    scrapingStatus.medicationProducts = 0;
    scrapingStatus.careProducts = 0;
    

    

    
    const allProducts = [];
    let successfulPages = 0;
    let failedPages = [];
    let pagesProcessed = 0;
   

            // Calculate total pages

    let totalPagesToScrape = 0;
    categories.forEach(cat => {
        totalPagesToScrape += cat.pages;
    });
     console.log('Discovered categories 123:', categories);
    scrapingStatus.totalPages = totalPagesToScrape;
    const staticProducts = await getRandomNumber();
    allProducts.push(...staticProducts);
    console.log(`✓ Added ${staticProducts.length} static products`);
    // Process each category
    for (const categoryConfig of categories) {
        const { category, startPage, endPage, perpage } = categoryConfig;
        
        console.log(`\n╔═══════════════════════════════════════════════════════════╗`);
        console.log(`║  Scraping Category: ${category.toUpperCase().padEnd(38)} ║`);
        console.log(`╚═══════════════════════════════════════════════════════════╝\n`);
        
        scrapingStatus.currentCategory = category;
        
        // Scrape pages for this category
        for (let page = startPage; page <= endPage; page++) {
            pagesProcessed++;
            scrapingStatus.currentPage = pagesProcessed;
            scrapingStatus.progress = Math.round((pagesProcessed / totalPagesToScrape) * 100);
            
            console.log(`\n[${pagesProcessed}/${totalPagesToScrape}] Processing ${category} page ${page}...`);
            
            const filename = await downloadPageHTML(browser, category, page,perpage);
            
            if (filename) {
                scrapingStatus.message = `Parsing ${category} page ${page}...`;
                const products = parseHTMLFile(filename, category, page);
                
                if (products && products.length > 0) {
                    allProducts.push(...products);
                    successfulPages++;
                    console.log(`✓ Total so far: ${allProducts.length} products from ${successfulPages} pages`);
                } else {
                    console.log(`✗ No products found on ${category} page ${page}`);
                    failedPages.push(`${category}-${page}`);
                                // Delay between requests
                    if (pagesProcessed < totalPagesToScrape) {
                        console.log(`Waiting 3 seconds...`);
                        await delay(3000);
                    }
                    break; // Stop further pages in this category
                }
                
                // Clean up temp file
                fs.unlinkSync(filename);
                if (products && products.length > 0&& products.length<perpage) break; // Stop if less than 192 products found
            } else {
                failedPages.push(`${category}-${page}`);
            }
            

        }
    }
    
    await browser.close();
    
    scrapingStatus.endTime = Date.now();
    scrapingStatus.isRunning = false;
    scrapingStatus.progress = 100;
    
    return { allProducts, successfulPages, failedPages, totalPages: totalPagesToScrape };
}

async function getCategories(browser) {
 

    const page = await browser.newPage();
            await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://shop.aversi.ge/ka/', {
        waitUntil: 'networkidle2',
        timeout: 60000
    });

        await delay(2000);
        
        // Get HTML content
        const html = await page.content();
        
        // Save HTML file to temp directory
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        const filename = path.join(tempDir, `categories.html`);
        fs.writeFileSync(filename, html);



        await page.close();
  

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
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
        // Configure categories to scrape
        const categorie123s = [
            { category: 'medication', startPage: 1, endPage: 35, pages: 35 },
            { category: 'care-products', startPage: 1, endPage: 70, pages: 70 }
        ];
        await getCategories(browser);
        const tempDir = path.join(__dirname, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir);
        }
        
        const filename = path.join(tempDir, `categories.html`);
        const html = fs.readFileSync(filename, 'utf-8');
        const $ = cheerio.load(html);
        const categories = [];
        $('.ty-menu__submenu-item .ty-menu__submenu-link').each((i, el) => {
            const href = $(el).attr('href');
             console.log(href)
            if (href && href.includes('/ka/')) {
                const match = href.match(/\/ka\/([^/]+)/);
               
                if (match && match[1]) {
                    if(href.includes('medication')){
                        if(href  !== "https://shop.aversi.ge/ka/medication/for-cardiovascular-diseases/pressure-regulators/")
                    categories.push({category:href,startPage: 1, endPage: 12, perpage: 192,pages:12});
                    }
                    
                }
            }
        });
        categories.push({category: 'https://shop.aversi.ge/ka/medication/მედიკამენტები-სხვადასხვა/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/homeopathic-remedies/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/for-cardiovascular-diseases/pressure-regulators/', startPage: 1, endPage: 16, perpage: 24,pages:16});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/various-medicinal-products/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/child-care/child-care-hygiene-products/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/oral-care/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/skin-care-products/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/drugs-stimulating-the-production-of-blood-cells', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/care-products/deodorant-antiperspirant/', startPage: 1, endPage: 12, perpage: 192,pages:12});
        categories.push({category: 'https://shop.aversi.ge/ka/medication/drugs-stimulating-the-production-of-blood-cells/', startPage: 1, endPage: 12, perpage: 192,pages:12});
const uniqueCategories = categories.filter(
  (item, index, self) =>
    index === self.findIndex(obj => obj.category === item.category)
);

                const dataDir = path.join(__dirname, 'public', 'data');
                if (!fs.existsSync(dataDir)) {
                    fs.mkdirSync(dataDir, { recursive: true });
                }
                
                // Save JSON
                const jsonPath = path.join(dataDir, 'categories.json');
                fs.writeFileSync(jsonPath, JSON.stringify(uniqueCategories, null, 2));

                console.log('Discovered categories:', uniqueCategories);

        // ✅ Dynamically fetch category list


 
       

        // if (categories.length === 0) {
        //     return res.status(404).json({ error: 'No categories found' });
        // }

        // // Start scraping in background
        // res.json({
        //     message: `Found ${categories.length} categories. Scraping started.`,
        //     categories: categories,
        //     status: scrapingStatus
        // });        
        // // Start scraping in background
        // res.json({
        //     message: 'Scraping started for multiple categories',
        //     categories: categories,
        //     status: scrapingStatus
        // });
        
        // Run scraping asynchronously
        scrapeAllCategories(browser,uniqueCategories).then(({ allProducts, successfulPages, failedPages, totalPages }) => {
            const duration = ((scrapingStatus.endTime - scrapingStatus.startTime) / 1000 / 60).toFixed(2);
            
            if (allProducts.length > 0) {
                // Clean up all products data one more time
                const cleanedProducts = allProducts.map(product => ({
                    ...product,
                    title: cleanText(product.title),
                    productCode: cleanText(product.productCode),
                    price: cleanPrice(product.price),
                    priceOld: cleanPrice(product.priceOld)
                }));
                
                // Create data directory if it doesn't exist
                const dataDir = path.join(__dirname, 'public', 'data');
                if (!fs.existsSync(dataDir)) {
                    fs.mkdirSync(dataDir, { recursive: true });
                }
                
                // Save JSON
                const jsonPath = path.join(dataDir, 'aversi_products.json');
                fs.writeFileSync(jsonPath, JSON.stringify(cleanedProducts, null, 2));
                
                // Create Excel file with multiple sheets
                const workbook = XLSX.utils.book_new();
                
                // Add sheet with all products
                const allWorksheet = XLSX.utils.json_to_sheet(cleanedProducts);
                XLSX.utils.book_append_sheet(workbook, allWorksheet, 'All Products');
                
                // Add sheet for medications only
                const medications = cleanedProducts.filter(p => p.category === 'medication');
               // if (medications.length > 0) {
                    const medWorksheet = XLSX.utils.json_to_sheet(medications);
                    XLSX.utils.book_append_sheet(workbook, medWorksheet, 'Medications');
               // }
                
                // Add sheet for care products only
                const careProducts = cleanedProducts.filter(p => p.category === 'care-products');
               // if (careProducts.length > 0) {
                    const careWorksheet = XLSX.utils.json_to_sheet(careProducts);
                    XLSX.utils.book_append_sheet(workbook, careWorksheet, 'Care Products');
               // }
                
                // Auto-size columns for all sheets
                const wscols = [
                    { wch: 15 },  // productCode
                    { wch: 50 },  // title
                    { wch: 15 },  // category
                    { wch: 10 },  // price
                    { wch: 10 },  // priceOld
                    { wch: 10 },  // pageNum
                ];
                allWorksheet['!cols'] = wscols;
                if (medications.length > 0) medWorksheet['!cols'] = wscols;
                if (careProducts.length > 0) careWorksheet['!cols'] = wscols;
                
                const xlsxPath = path.join(dataDir, 'aversi_products.xlsx');
                XLSX.writeFile(workbook, xlsxPath);
                
                // Calculate statistics using cleaned data
                const withPrice = cleanedProducts.filter(p => p.price).length;
                const withDiscount = cleanedProducts.filter(p => p.priceOld && p.priceOld !== p.price).length;
                const withProductCode = cleanedProducts.filter(p => p.productCode).length;
                
                scrapingStatus.message = `Completed! Scraped ${cleanedProducts.length} products in ${duration} minutes`;
                scrapingStatus.statistics = {
                    totalProducts: cleanedProducts.length,
                    medicationProducts: scrapingStatus.medicationProducts,
                    careProducts: scrapingStatus.careProducts,
                    pagesScraped: successfulPages,
                    failedPages: failedPages.length,
                    duration: duration,
                    withPrice: withPrice,
                    withDiscount: withDiscount,
                    withProductCode: withProductCode
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
            products: data.slice(0, 100), // Return first 100 products
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
║                                                           ║
║  Server running at: http://localhost:${PORT}              ║
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