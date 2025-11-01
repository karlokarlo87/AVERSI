const express = require('express');
const path = require('path');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = 3000;

// Serve static files
app.use(express.static('public'));
app.use(express.json());

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
    return text.replace(/\s+/g, " ").trim();
       
}

// Download HTML with Puppeteer
async function downloadPageHTML(browser, category, pageNum) {
    const url = `https://shop.aversi.ge/ka/${category}/page-${pageNum}/?items_per_page=192`;
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
            const priceOld = cleanText(priceOldRaw).replace("₾", "").trim();;
            
            // Get current price
            const priceRaw = $el.find('.ty-price-num').text() || '';
            const price = cleanText(priceRaw);
        
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
        if (category === 'medication') {
            scrapingStatus.medicationProducts += products.length;
        } else if (category === 'care-products') {
            scrapingStatus.careProducts += products.length;
        }
        
        scrapingStatus.productsFound += products.length;
        return products;
        
    } catch (error) {
        console.error(`✗ Error parsing ${filename}:`, error.message);
        return [];
    }
}

// Main scraping function for multiple categories
async function scrapeAllCategories(categories) {
    scrapingStatus.isRunning = true;
    scrapingStatus.startTime = Date.now();
    scrapingStatus.currentPage = 0;
    scrapingStatus.productsFound = 0;
    scrapingStatus.medicationProducts = 0;
    scrapingStatus.careProducts = 0;
    
    // Calculate total pages
    let totalPagesToScrape = 0;
    categories.forEach(cat => {
        totalPagesToScrape += cat.pages;
    });
    scrapingStatus.totalPages = totalPagesToScrape;
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const allProducts = [];
    let successfulPages = 0;
    let failedPages = [];
    let pagesProcessed = 0;
    
    // Process each category
    for (const categoryConfig of categories) {
        const { category, startPage, endPage, pages } = categoryConfig;
        
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
            
            const filename = await downloadPageHTML(browser, category, page);
            
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
                }
                
                // Clean up temp file
                fs.unlinkSync(filename);
            } else {
                failedPages.push(`${category}-${page}`);
            }
            
            // Delay between requests
            if (pagesProcessed < totalPagesToScrape) {
                console.log(`Waiting 3 seconds...`);
                await delay(3000);
            }
        }
    }
    
    await browser.close();
    
    scrapingStatus.endTime = Date.now();
    scrapingStatus.isRunning = false;
    scrapingStatus.progress = 100;
    
    return { allProducts, successfulPages, failedPages, totalPages: totalPagesToScrape };
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
        // Configure categories to scrape
        const categories = [
            { category: 'medication', startPage: 1, endPage: 32, pages: 32 },
            { category: 'care-products', startPage: 1, endPage: 17, pages: 17 }
        ];
        
        // Start scraping in background
        res.json({
            message: 'Scraping started for multiple categories',
            categories: categories,
            status: scrapingStatus
        });
        
        // Run scraping asynchronously
        scrapeAllCategories(categories).then(({ allProducts, successfulPages, failedPages, totalPages }) => {
            const duration = ((scrapingStatus.endTime - scrapingStatus.startTime) / 1000 / 60).toFixed(2);
            
            if (allProducts.length > 0) {
                // Clean up all products data one more time
                const cleanedProducts = allProducts.map(product => ({
                    ...product,
                    title: cleanText(product.title),
                    productCode: cleanText(product.productCode),
                    price: cleanText(product.price),
                    priceOld: cleanText(product.priceOld)
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
                if (medications.length > 0) {
                    const medWorksheet = XLSX.utils.json_to_sheet(medications);
                    XLSX.utils.book_append_sheet(workbook, medWorksheet, 'Medications');
                }
                
                // Add sheet for care products only
                const careProducts = cleanedProducts.filter(p => p.category === 'care-products');
                if (careProducts.length > 0) {
                    const careWorksheet = XLSX.utils.json_to_sheet(careProducts);
                    XLSX.utils.book_append_sheet(workbook, careWorksheet, 'Care Products');
                }
                
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
║         Aversi Pharmacy Scraper Web Service              ║
║                                                           ║
║  Server running at: http://localhost:${PORT}                 ║
║                                                           ║
║  API Endpoints:                                           ║
║  GET  /aversi         - Start scraping                   ║
║  GET  /aversi/status  - Check scraping status            ║
║  GET  /aversi/data    - Get scraped data                 ║
║  GET  /aversi/download/json  - Download JSON file        ║
║  GET  /aversi/download/excel - Download Excel file       ║
╚═══════════════════════════════════════════════════════════╝
    `);
});