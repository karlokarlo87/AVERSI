// Two-step scraper: Download with Puppeteer, Parse with Cheerio
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const XLSX = require('xlsx');

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Step 1: Download HTML files with Puppeteer
async function downloadPageHTML(browser, pageNum) {
    const url = `https://shop.aversi.ge/ka/medication/page-${pageNum}/?items_per_page=192`;
    let page;
    
    try {
        page = await browser.newPage();
        
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        console.log(`Downloading page ${pageNum}...`);
        
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        
        await delay(2000);
        
        // Get HTML content
        const html = await page.content();
        
        // Save HTML file
        const filename = `page_${pageNum}.html`;
        fs.writeFileSync(filename, html);
        console.log(`✓ Saved: ${filename} (${Math.round(html.length / 1024)} KB)`);
        
        // Take screenshot
        await page.screenshot({ path: `screenshot_page_${pageNum}.png` });
        
        await page.close();
        return filename;
        
    } catch (error) {
        console.error(`✗ Error downloading page ${pageNum}:`, error.message);
        if (page) await page.close();
        return null;
    }
}

// Step 2: Parse HTML file with Cheerio
function parseHTMLFile(filename, pageNum) {
    try {
        console.log(`Parsing ${filename}...`);
        
        const html = fs.readFileSync(filename, 'utf-8');
        const $ = cheerio.load(html);
        
        const products = [];
        
        // Find all .col-tile elements
        $('.col-tile').each((index, element) => {
            const $el = $(element);
            
            // Get title
            const title = $el.find('.product-title').text().trim() || '';
            
            // Get old price
            const priceOld = $el.find('.ty-list-price:last-child').text().trim() || '';
            
            // Get current price
            let price = $el.find('.ty-price-num').text().trim();
        
            // Get product code
            const productCode = $el.find('input[name$="[product_code]"]').val() || ''; 
       
            const product = {
                pageNum: pageNum,
                title: title,
                price: price.replace('ლ', '').replace('₾', '').replace(',', '.').trim(),
                priceOld: priceOld.replace('ლ', '').replace('₾', '').replace(',', '.').trim(),
                productCode: productCode,
            };
            
            products.push(product);
        });
        
        console.log(`✓ Parsed ${products.length} products from ${filename}`);
        return products;
        
    } catch (error) {
        console.error(`✗ Error parsing ${filename}:`, error.message);
        return [];
    }
}

// Main scraping function
async function scrapeAllPages(startPage = 1, endPage = 32) {
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║    STEP 1: Downloading HTML files with Puppeteer         ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const htmlFiles = [];
    
    // Download all HTML files
    for (let page = startPage; page <= endPage; page++) {
        console.log(`\n[${page}/${endPage}] Downloading page ${page}...`);
        
        const filename = await downloadPageHTML(browser, page);
        
        if (filename) {
            htmlFiles.push({ page, filename });
        }
        
        // Delay between requests
        if (page < endPage) {
            console.log(`Waiting 3 seconds...`);
            await delay(3000);
        }
    }
    
    await browser.close();
    console.log('\n✓ All HTML files downloaded!');
    
    // Parse all HTML files
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║    STEP 2: Parsing HTML files with Cheerio               ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    
    const allProducts = [];
    let successfulPages = 0;
    let failedPages = [];
    
    for (const { page, filename } of htmlFiles) {
        console.log(`\n[${page}/${endPage}] Parsing page ${page}...`);
        
        const products = parseHTMLFile(filename, page);
        
        if (products && products.length > 0) {
            allProducts.push(...products);
            successfulPages++;
            console.log(`✓ Total so far: ${allProducts.length} products from ${successfulPages} pages`);
        } else {
            console.log(`✗ No products found on page ${page}`);
            failedPages.push(page);
        }
    }
    
    return { allProducts, successfulPages, failedPages, totalPages: htmlFiles.length };
}

// Main execution
(async () => {
    const startTime = Date.now();
    
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║         Aversi Pharmacy Scraper - 2-Step Version         ║');
    console.log('║    Step 1: Download HTML | Step 2: Parse with Cheerio    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    
    const { allProducts, successfulPages, failedPages, totalPages } = await scrapeAllPages(1, 32);
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000 / 60).toFixed(2);
    
    console.log('\n' + '='.repeat(60));
    console.log('SCRAPING COMPLETE!');
    console.log('='.repeat(60));
    console.log(`Total products: ${allProducts.length}`);
    console.log(`Pages downloaded: ${totalPages}`);
    console.log(`Pages with products: ${successfulPages}`);
    console.log(`Failed pages: ${failedPages.length > 0 ? failedPages.join(', ') : 'None'}`);
    console.log(`Duration: ${duration} minutes`);
    console.log('='.repeat(60));
    
    if (allProducts.length > 0) {
        // Save JSON (single file only)
        fs.writeFileSync('aversi_all_products.json', JSON.stringify(allProducts, null, 2));
        console.log('\n✓ Saved: aversi_all_products.json');
        
        // Create Excel file
        console.log('\nCreating Excel file...');
        const worksheet = XLSX.utils.json_to_sheet(allProducts);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Products');
        
        // Auto-size columns
        const maxWidth = 50;
        const wscols = [
            { wch: 10 },  // pageNum
            { wch: maxWidth },  // title
            { wch: 10 },  // price
            { wch: 10 },  // priceOld
            { wch: 15 },  // productCode
        ];
        worksheet['!cols'] = wscols;
        
        XLSX.writeFile(workbook, 'aversi_all_products.xlsx');
        console.log('✓ Saved: aversi_all_products.xlsx');
    
        // Statistics
        console.log('\n' + '='.repeat(60));
        console.log('STATISTICS');
        console.log('='.repeat(60));
        
        const withPrice = allProducts.filter(p => p.price).length;
        const withDiscount = allProducts.filter(p => p.priceOld && p.priceOld !== p.price).length;
        const withProductCode = allProducts.filter(p => p.productCode).length;
        const avgPerPage = (allProducts.length / successfulPages).toFixed(1);
        
        console.log(`Average per page: ${avgPerPage}`);
        console.log(`Products with Price: ${withPrice} (${(withPrice/allProducts.length*100).toFixed(1)}%)`);
        console.log(`Products with Discount: ${withDiscount} (${(withDiscount/allProducts.length*100).toFixed(1)}%)`);
        console.log(`Products with Code: ${withProductCode} (${(withProductCode/allProducts.length*100).toFixed(1)}%)`);
        
        // Products per page breakdown
        const productsPerPage = {};
        allProducts.forEach(p => {
            productsPerPage[p.pageNum] = (productsPerPage[p.pageNum] || 0) + 1;
        });
        
        console.log('\nProducts per page (first 15):');
        Object.entries(productsPerPage)
            .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
            .slice(0, 15)
            .forEach(([page, count]) => {
                console.log(`  Page ${page}: ${count} products`);
            });
        
        if (Object.keys(productsPerPage).length > 15) {
            console.log(`  ... and ${Object.keys(productsPerPage).length - 15} more pages`);
        }
        
        // Sample products
        console.log('\n' + '='.repeat(60));
        console.log('SAMPLE PRODUCTS');
        console.log('='.repeat(60));
        
        console.log('\nFirst product:');
        console.log(JSON.stringify(allProducts[0], null, 2));
        
        if (allProducts.length > 1) {
            console.log('\nLast product:');
            console.log(JSON.stringify(allProducts[allProducts.length - 1], null, 2));
        }
        
        console.log('\n✅ SCRAPING SUCCESSFUL!');
        console.log('\n📁 Files created:');
        console.log('  • aversi_all_products.json');
        console.log('  • aversi_all_products.xlsx');
        
        // Cleanup: Delete HTML files and screenshots
        console.log('\n🧹 Cleaning up temporary files...');
        let deletedCount = 0;
        
        for (let i = 1; i <= 32; i++) {
            const htmlFile = `page_${i}.html`;
            const screenshotFile = `screenshot_page_${i}.png`;
            
            if (fs.existsSync(htmlFile)) {
                fs.unlinkSync(htmlFile);
                deletedCount++;
            }
            
            if (fs.existsSync(screenshotFile)) {
                fs.unlinkSync(screenshotFile);
                deletedCount++;
            }
        }
        
        console.log(`✓ Deleted ${deletedCount} temporary files (HTML pages and screenshots)`);
        
    } else {
        console.log('\n❌ No products were scraped.');
        console.log('\nTroubleshooting:');
        console.log('1. Check page_1.html - open it in a browser');
        console.log('2. Look for elements with class="col-tile"');
        console.log('3. The HTML structure might be different');
    }
})();