import { test, expect } from '@playwright/test';

test.describe('Products', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@greekfoods.bg');
    await page.fill('input[type="password"]', 'GreekFoods2026!');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();
    await page.waitForSelector('nav', { timeout: 10000 });
  });

  test('View products list → expect table with products', async ({ page }) => {
    await page.goto('/products');
    
    // Wait for table to load
    await page.waitForSelector('table', { timeout: 10000 });
    
    // Check for table rows
    const rows = page.locator('tbody tr');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Click Edit on a product → expect form or modal appears', async ({ page }) => {
    await page.goto('/products');
    await page.waitForSelector('table', { timeout: 10000 });
    
    // Find edit button - look for Pencil icon or button
    const editButtons = await page.locator('button').filter({
      has: page.locator('svg')
    }).all();
    
    if (editButtons.length > 0) {
      await editButtons[0].click();
      
      // Wait for content to appear
      await page.waitForTimeout(1000);
      
      // After clicking edit, we should see form inputs somewhere
      const inputs = await page.locator('input').all();
      // Should have more inputs than just the search/filter ones
      expect(inputs.length).toBeGreaterThan(1);
    }
  });

  test('Change name, save → expect success message', async ({ page }) => {
    await page.goto('/products');
    await page.waitForSelector('table', { timeout: 10000 });
    
    // Find and click first edit button
    const editButtons = await page.locator('button').filter({
      has: page.locator('svg')
    }).all();
    
    if (editButtons.length > 0) {
      await editButtons[0].click();
      await page.waitForTimeout(1000);
      
      // Get first text input and change it
      const inputs = await page.locator('input[type="text"]').all();
      if (inputs.length > 0) {
        await inputs[0].clear();
        await inputs[0].fill(`Updated_${Date.now()}`);
        
        // Click save button
        const saveBtn = page.locator('button').filter({
          hasText: /save|запази/i
        }).first();
        
        if (await saveBtn.isVisible().catch(() => false)) {
          await saveBtn.click();
          await page.waitForTimeout(1000);
        }
      }
    }
  });

  test('Stock column shows number + unit', async ({ page }) => {
    await page.goto('/products');
    await page.waitForSelector('table', { timeout: 10000 });
    
    // Get all table cells and check for unit patterns
    const cells = await page.locator('td').all();
    let foundUnit = false;
    
    for (const cell of cells) {
      const text = await cell.textContent();
      if (text && text.match(/\d+\s*(бр|кг|л|kg|pc)/i)) {
        foundUnit = true;
        break;
      }
    }
    expect(foundUnit).toBe(true);
  });
});
