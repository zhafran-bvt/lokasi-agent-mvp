import { chromium } from 'playwright';
import { config } from './src/config.js';
import { login } from './src/browser.js';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log(`Navigating to ${config.appUrl}`);
  
  // Use the built-in login function
  await login(page);
  
  // Navigate to Dataset Explorer
  console.log('Navigating to Dataset Explorer...');
  await page.click('button:has-text("Dataset Explorer")');
  await page.waitForTimeout(3000);
  
  // Take screenshot
  await page.screenshot({ path: '/tmp/data-selection-panel.png', fullPage: true });
  console.log('Screenshot saved to /tmp/data-selection-panel.png');
  
  // Inspect Data Selection panel
  console.log('\n=== Inspecting Data Selection Panel ===');
  
  // Find the Data Selection heading
  const dataSelectionHeading = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('*')).find(e => 
      e.textContent?.includes('Data Selection') && e.textContent.length < 100
    );
    return el ? el.outerHTML.substring(0, 200) : 'not found';
  });
  console.log('Data Selection heading:', dataSelectionHeading);
  
  // Find all visible rows/items in Data Selection area
  console.log('\n=== Finding loaded dataset rows ===');
  const rows = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('button, [role="button"], div[class*="item"], div[class*="row"], li, section, article')).filter(el => {
      const rect = el.getBoundingClientRect();
      const text = (el.textContent || '').trim();
      const isVisible = rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
      return isVisible && text.length > 0 && text.length < 500;
    });
    
    return elements.slice(0, 50).map((el, idx) => ({
      index: idx,
      tag: el.tagName,
      class: el.className.substring(0, 100),
      text: (el.textContent || '').trim().substring(0, 100),
      rect: {
        top: Math.round(el.getBoundingClientRect().top),
        left: Math.round(el.getBoundingClientRect().left),
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height)
      }
    }));
  });
  
  console.log('Visible elements around Data Selection:');
  console.table(rows);
  
  // Look specifically for rows that might contain dataset names
  console.log('\n=== Looking for dataset row patterns ===');
  const datasetRows = await page.evaluate(() => {
    const allDivs = Array.from(document.querySelectorAll('div, button, li, article, section'));
    
    // Look for elements that contain edit, delete, or trash icons
    const rowsWithActions = allDivs.filter(el => {
      const html = el.innerHTML || '';
      const text = el.textContent || '';
      const hasEditIcon = html.includes('edit') || html.includes('pencil') || text.includes('Edit') || text.includes('✎') || text.includes('✏');
      const hasDelete = html.includes('trash') || html.includes('delete') || text.includes('Delete') || text.includes('🗑');
      const rect = el.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0;
      return isVisible && (hasEditIcon || hasDelete);
    });
    
    return rowsWithActions.slice(0, 30).map((el, idx) => ({
      index: idx,
      tag: el.tagName,
      class: el.className.substring(0, 150),
      html: el.innerHTML.substring(0, 200),
      text: (el.textContent || '').trim().substring(0, 100),
      rect: {
        top: Math.round(el.getBoundingClientRect().top),
        left: Math.round(el.getBoundingClientRect().left),
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height)
      }
    }));
  });
  
  console.log('Elements with edit/delete actions:');
  console.table(datasetRows);
  
  // Check what the scanRoot would be
  console.log('\n=== Checking scanRoot candidates ===');
  const scanRootInfo = await page.evaluate(() => {
    const main = document.querySelector('main');
    const container = document.querySelector('[class*="container"], [class*="panel"], [class*="section"]');
    const viewport = document.querySelector('[class*="viewport"]');
    
    return {
      hasMain: !!main,
      mainClass: main?.className.substring(0, 100),
      container: {
        found: !!container,
        class: container?.className.substring(0, 100),
        childCount: container?.children.length || 0
      },
      viewport: {
        found: !!viewport,
        class: viewport?.className.substring(0, 100)
      }
    };
  });
  
  console.log('scanRoot candidates:', JSON.stringify(scanRootInfo, null, 2));
  
  await browser.close();
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
