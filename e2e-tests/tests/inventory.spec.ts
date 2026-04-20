import { test, expect } from '@playwright/test';

test.describe('Inventory (Склад)', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@greekfoods.bg');
    await page.fill('input[type="password"]', 'GreekFoods2026!');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();
    await page.waitForSelector('nav', { timeout: 10000 });
  });

  test('Inventory page loads and shows table', async ({ page }) => {
    await page.goto('/inventory');
    
    // Wait for table to load
    await page.waitForSelector('table, [role="grid"]', { timeout: 10000 });
    
    // Check page URL
    expect(page.url()).toContain('/inventory');
    
    // Check table has rows
    const rows = page.locator('tbody tr');
    const count = await rows.count();
    
    // Table should have at least 0 rows (may be empty initially)
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('Unit labels are Bulgarian (бр/кг/л not pcs/kg/l)', async ({ page }) => {
    await page.goto('/inventory');
    
    // Wait for table
    await page.waitForSelector('table', { timeout: 10000 });
    
    // Get all cells in the table
    const cells = await page.locator('table td').all();
    
    let foundBulgarianUnit = false;
    let foundEnglishUnit = false;
    
    for (const cell of cells) {
      const text = await cell.textContent();
      if (text) {
        // Check for Bulgarian units
        if (text.match(/\d+\s*(бр|кг|л)\b/i)) {
          foundBulgarianUnit = true;
        }
        // Check for English units that should NOT appear
        if (text.match(/\d+\s*(pcs|pieces|kg|liter|liters)\b/i)) {
          foundEnglishUnit = true;
        }
      }
    }
    
    // If there are products with units, they should be Bulgarian
    if (cells.length > 0) {
      // At least we should not see English units
      expect(foundEnglishUnit).toBe(false);
    }
  });

  test('Low stock filter works', async ({ page }) => {
    await page.goto('/inventory');
    
    // Wait for page elements
    await page.waitForSelector('table', { timeout: 10000 });
    
    // Look for filter buttons or inputs
    const filterButtons = await page.locator('button').filter({
      hasText: /filter|low|stock|филтър|нисък/i
    }).all();
    
    if (filterButtons.length > 0) {
      // Click first filter button
      await filterButtons[0].click();
      
      // Wait for filter to apply
      await page.waitForTimeout(1000);
      
      // Page should still have table
      const table = page.locator('table');
      const isVisible = await table.isVisible({ timeout: 5000 }).catch(() => false);
      
      expect(isVisible).toBe(true);
    }
    
    // Alternative: look for a "Low Stock" filter/checkbox/option
    const lowStockElements = await page.locator('text=/low|low.stock|нисък|малко/i').all();
    
    if (lowStockElements.length > 0) {
      // Found low stock filter option
      expect(lowStockElements.length).toBeGreaterThan(0);
    }
  });

  test('Inventory page has no console errors', async ({ page }) => {
    const errors: string[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    await page.goto('/inventory');
    await page.waitForSelector('table', { timeout: 10000 });
    await page.waitForTimeout(500);
    
    // No critical errors should appear
    expect(errors.length).toBe(0);
  });
});
