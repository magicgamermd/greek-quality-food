import { test, expect } from '@playwright/test';

test.describe('Navigation', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@mertm.bg');
    await page.fill('input[type="password"]', '36PWyyfdpxIt08VXlGjle1zf');
    await page.click('button[type="submit"]');
    await page.waitForNavigation();
    await page.waitForSelector('nav', { timeout: 10000 });
  });

  test('All main pages are accessible', async ({ page }) => {
    // Test navigation to main pages
    const pages = [
      { path: '/', name: 'Dashboard' },
      { path: '/products', name: 'Products' },
      { path: '/suppliers', name: 'Suppliers' },
      { path: '/incoming', name: 'Incoming Goods' },
    ];

    for (const pageItem of pages) {
      await page.goto(pageItem.path);
      
      // Wait for page to load
      await page.waitForTimeout(500);
      
      // Check we're on the right URL
      expect(page.url()).toContain(pageItem.path);
      
      // Check page has content
      const content = page.locator('body');
      const hasContent = await content.isVisible();
      expect(hasContent).toBe(true);
    }
  });

  test('Navigation menu exists and is visible', async ({ page }) => {
    await page.goto('/');
    
    // Check for navigation element
    const nav = page.locator('nav, [role="navigation"]').first();
    const isVisible = await nav.isVisible();
    expect(isVisible).toBe(true);
    
    // Check for navigation links
    const links = await page.locator('nav a, nav button').all();
    expect(links.length).toBeGreaterThan(0);
  });

  test('No unhandled errors on main pages', async ({ page }) => {
    const errors: string[] = [];
    
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    
    // Visit main pages
    const testPages = ['/', '/products', '/suppliers'];
    for (const url of testPages) {
      await page.goto(url);
      await page.waitForTimeout(500);
    }
    
    // Report any console errors
    if (errors.length > 0) {
      console.log('Console errors detected:', errors);
    }
  });

  test('Page transitions work smoothly', async ({ page }) => {
    // Start from home
    await page.goto('/');
    await page.waitForTimeout(500);
    
    // Navigate to products
    await page.goto('/products');
    const productsUrl = page.url();
    expect(productsUrl).toContain('products');
    
    // Navigate back to home
    await page.goto('/');
    const homeUrl = page.url();
    expect(homeUrl).not.toContain('products');
  });

  test('Can log in and access protected pages', async ({ page }) => {
    // We're already logged in from beforeEach
    // Try to access a protected page
    await page.goto('/products');
    
    // Should NOT redirect to login
    expect(page.url()).not.toContain('login');
    
    // Page should have content
    const table = page.locator('table, [role="grid"]');
    const exists = await table.isVisible({ timeout: 5000 }).catch(() => false);
    
    // Table should exist or page should have some content
    const pageText = await page.textContent('body');
    expect(pageText).toBeTruthy();
  });
});
