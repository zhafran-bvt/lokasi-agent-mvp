import { chromium } from 'playwright';
import { config } from './src/config.js';
import { login } from './src/browser.js';
import fs from 'fs';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  
  console.log(`Logging in...`);
  await login(page);
  
  // Now let's run a sample test that includes openAnalysisBase
  // First, create a URL that navigates to Analysis with a dataset already selected
  // Looking at the failed test, it should have a URL
  
  // Let's just manually navigate to the Analysis view since workflowBaseUrl was undefined
  console.log('Navigating to Analysis view...');
  await page.goto(config.appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  
  // Click on Analysis nav item
  await page.click('button:has-text("Analysis")');
  await page.waitForTimeout(3000);
  
  // Take screenshot to see what's on the page
  await page.screenshot({ path: '/tmp/analysis-view.png', fullPage: false });
  console.log('Analysis view screenshot saved');
  
  // Now let's directly check what elements are visible that match "Data Selection"
  const investigateDOM = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    
    // Find Data Selection heading
    const allElements = Array.from(document.querySelectorAll('*'));
    const dataSelectionItems = allElements.filter(el => 
      visible(el) && normalize(el.textContent).toLowerCase().includes('data selection')
    );
    
    console.log('[DOM Investigation - Data Selection References Found]');
    return dataSelectionItems.map((el, idx) => ({
      index: idx,
      tag: el.tagName,
      class: el.className.substring(0, 100),
      text: normalize(el.textContent || '').substring(0, 100),
      rect: {
        top: Math.round(el.getBoundingClientRect().top),
        left: Math.round(el.getBoundingClientRect().left),
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height)
},
      hasDataTestid: !!el.getAttribute('data-testid')
    }));
  });
  
  console.log('\nElements mentioning "Data Selection":');
  console.table(investigateDOM);
  
  // Look for edit/delete buttons
  const buttonInvestigation = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    
    // Look for elements with data-testid attributes (which the function looks for)
    const editButtons = Array.from(document.querySelectorAll('[data-testid="edit-button"]'))
      .filter(el => visible(el));
    
    const trashButtons = Array.from(document.querySelectorAll('[data-testid="trash-button"]'))
      .filter(el => visible(el));
    
    return {
      editButtonCount: editButtons.length,
      trashButtonCount: trashButtons.length,
      editButtons: editButtons.slice(0, 5).map(btn => ({
        tag: btn.tagName,
        parent: btn.parentElement?.tagName,
        parentClass: btn.parentElement?.className.substring(0, 100),
        rect: {
          top: Math.round(btn.getBoundingClientRect().top),
          left: Math.round(btn.getBoundingClientRect().left)
        }
      }))
    };
  });
  
  console.log('\nButton investigation:');
  console.log(JSON.stringify(buttonInvestigation, null, 2));
  
  // Check for datasets that might be loaded
  const datasetRows = await page.evaluate(() => {
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    
    // Look for dataset-related keywords
    const keywords = ['household', 'expenditure', 'jakarta', '2024', 'Bank', 'Financial'];
    const matches = [];
    
    Array.from(document.querySelectorAll('*')).forEach(el => {
      if (!visible(el)) return;
      const text = normalize(el.textContent || '').toLowerCase();
      const hasKeyword = keywords.some(kw => text.includes(kw.toLowerCase()));
      if (hasKeyword && text.length < 300) {
        matches.push({
          tag: el.tagName,
          class: el.className.substring(0, 80),
          text: text.substring(0, 80),
          dataTestid: el.getAttribute('data-testid'),
          rect: {
            top: Math.round(el.getBoundingClientRect().top),
            height: Math.round(el.getBoundingClientRect().height)
          }
        });
      }
    });
    
    return matches.slice(0, 20);
  });
  
  console.log('\nDataset-related elements:');
  console.table(datasetRows);
  
  await browser.close();
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
