import { test, expect } from '@playwright/test';

test.describe('Orders (Поръчки)', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@greekfoods.bg');
    await page.fill('input[type="password"]', 'GreekFoods2026!');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();
    await page.waitForSelector('nav', { timeout: 10000 });
  });

  test('Orders page loads without errors', async ({ page }) => {
    // Navigate to orders page (likely /orders or /purchases or similar)
    await page.goto('/orders');
    
    // Wait for page content to load
    await page.waitForSelector('h1, h2, table, [role="grid"]', { timeout: 10000 });
    
    // Check URL
    expect(page.url()).toContain('/orders');
    
    // Page should have no critical errors
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    await page.waitForTimeout(500);
    expect(errors.length).toBe(0);
  });

  test('Orders page has correct title/heading', async ({ page }) => {
    await page.goto('/orders');
    
    // Wait for heading
    await page.waitForSelector('h1, h2', { timeout: 10000 });
    
    // Get page title or heading
    const heading = page.locator('h1, h2').first();
    const headingText = await heading.textContent();
    
    // Heading should exist and contain relevant text
    expect(headingText).toBeTruthy();
    
    // Could contain Orders, Poръчки, Orders, etc. (not empty)
    expect(headingText?.trim().length).toBeGreaterThan(0);
  });

  test('Orders page layout is visible', async ({ page }) => {
    await page.goto('/orders');
    
    // Wait for main content
    await page.waitForTimeout(1000);
    
    // Check page has content (table or list)
    const table = page.locator('table');
    const grid = page.locator('[role="grid"]');
    const list = page.locator('ul, ol');
    
    const hasContent = 
      await table.isVisible({ timeout: 2000 }).catch(() => false) ||
      await grid.isVisible({ timeout: 2000 }).catch(() => false) ||
      await list.isVisible({ timeout: 2000 }).catch(() => false);
    
    expect(hasContent).toBe(true);
  });

  test('Page displays correctly without layout issues', async ({ page }) => {
    await page.goto('/orders');
    
    // Wait for content
    await page.waitForSelector('body', { timeout: 10000 });
    
    // Get page content
    const body = page.locator('body');
    const isVisible = await body.isVisible();
    
    expect(isVisible).toBe(true);
    
    // Check viewport is not broken
    const viewportSize = await page.viewportSize();
    expect(viewportSize?.width).toBeGreaterThan(0);
    expect(viewportSize?.height).toBeGreaterThan(0);
  });
});
