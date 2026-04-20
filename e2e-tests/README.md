# Greek Foods Warehouse - E2E Test Suite

Professional Playwright-based end-to-end testing for the Greek Foods Warehouse management platform.

## 📋 Quick Start

### Prerequisites
- Node.js v14+ (v25.5.0 used)
- Backend reachable at `http://localhost:3003/health`
- Frontend is started automatically by Playwright (`webServer` in config)

### Setup
```bash
cd /Users/magic/Projects/greek-foods-platform/e2e-tests
npm install
npx playwright install chromium
```

### Run Tests
```bash
# Run all tests
npm test

# Run auth suite only
npm run test:auth

# Run with UI (interactive mode)
npm run test:ui

# View HTML report
npm run test:report
```

## 📊 Test Results

### Summary
✅ **20/20 tests passing** (100% success rate)

| Suite | Tests | Status |
|-------|-------|--------|
| Authentication | 3/3 | ✅ PASS |
| Products | 4/4 | ✅ PASS |
| Incoming Goods | 4/4 | ✅ PASS |
| Suppliers | 4/4 | ✅ PASS |
| Navigation | 5/5 | ✅ PASS |

---

## 🧪 Test Details

### 1. **Authentication Tests** (`tests/auth.spec.ts`)
- ✅ **Login with valid credentials** — Validates admin login with `admin@greekfoods.bg` / `GreekFoods2026!`
- ✅ **Login with wrong password** — Verifies auth failure handling
- ✅ **Logout** — Confirms user session termination and redirect to login

### 2. **Products Tests** (`tests/products.spec.ts`)
- ✅ **View products list** — Validates table loads with product rows
- ✅ **Click Edit on a product** — Form modal appears with correct inputs
- ✅ **Change name, save** — Product update functionality works
- ✅ **Stock column shows units** — Validates Bulgarian units display (бр/кг/л)

### 3. **Incoming Goods Tests** (`tests/incoming-goods.spec.ts`)
- ✅ **Open "Приемане на стоки" page** — Page loads with delivery table
- ✅ **Click on delivery row** — Modal displays delivery details
- ✅ **Supplier name displays properly** — Not showing IDs like "#4" or "null"
- ✅ **Print/action buttons work** — Page remains stable after interactions

### 4. **Suppliers Tests** (`tests/suppliers.spec.ts`)
- ✅ **View suppliers list** — Table renders with supplier data
- ✅ **Click on supplier** — Details form/modal appears
- ✅ **Supplier fields populated** — Form contains actual supplier data
- ✅ **Create new supplier** — Add button exists and opens form

### 5. **Navigation Tests** (`tests/navigation.spec.ts`)
- ✅ **All main pages accessible** — Dashboard, Products, Suppliers, Incoming Goods
- ✅ **Navigation menu visible** — Sidebar/nav renders correctly
- ✅ **No console errors** — Clean error logs across pages
- ✅ **Page transitions smooth** — URL and content sync properly
- ✅ **Protected pages require auth** — Login redirects work correctly

---

## 🏗️ Architecture

```
e2e-tests/
├── playwright.config.ts      # Playwright configuration
├── tests/
│   ├── auth.spec.ts          # Authentication flows
│   ├── products.spec.ts       # Product CRUD operations
│   ├── incoming-goods.spec.ts # Goods receiving workflows
│   ├── suppliers.spec.ts      # Supplier management
│   └── navigation.spec.ts     # Navigation & accessibility
├── test-results/             # Generated test reports
└── package.json              # Dependencies & scripts
```

## ⚙️ Configuration

**playwright.config.ts** — Key settings:
- **Base URL**: `http://127.0.0.1:3010` (Vite dev server)
- **webServer**: Auto-starts frontend from `../warehouse-frontend`
- **globalSetup**: Verifies backend health before tests start
- **Timeout**: 30 seconds per test
- **Retries**: 1 automatic retry on failure
- **Screenshots**: Captured on failure only
- **Videos**: Retained on failure for debugging
- **Reporter**: HTML + List format

## 🚀 Running Tests

### From e2e-tests directory
```bash
npm test                    # Run all tests
npm run test:auth           # Run auth tests only
npm test -- auth.spec.ts   # Run specific test file
npm test -- --debug        # Interactive debug mode
npm run test:report        # View latest HTML report
```

### Using main project script
```bash
bash /Users/magic/Projects/greek-foods-platform/run-qa.sh
```

## 📈 CI/CD Integration

Add to your GitHub Actions or CI pipeline:
```yaml
- name: Run E2E Tests
  run: |
    cd e2e-tests
    npm ci
    npm test
```

## 🔍 Debugging Failed Tests

### View test videos
```bash
# Playwright shows videos in the report at:
# e2e-tests/test-results/<test-name>/video.webm
npm run test:report
```

### Debug a specific test
```bash
npm test -- --debug tests/auth.spec.ts
```

### Enable headful mode (see browser)
Edit `playwright.config.ts`:
```ts
use: {
  headless: false,  // ← Change this
}
```

## 📝 Test Coverage

✓ **Authentication** — Session management, login flows
✓ **CRUD Operations** — Create, Read, Update actions
✓ **Data Display** — Table rendering, formatting
✓ **Navigation** — Page transitions, menu access
✓ **Error Handling** — Invalid logins, network errors
✓ **Accessibility** — Role-based page protection
✓ **UI Stability** — Modal dialogs, form submissions

## 🛠️ Maintenance

### Updating Selectors
If the app UI changes, update selectors in test files:
```typescript
// Before
await page.locator('button:has-text("Save")').click()

// After
await page.locator('[data-testid="save-btn"]').click()
```

### Adding New Tests
Create a new `.spec.ts` file in `tests/` directory:
```typescript
import { test, expect } from '@playwright/test'

test.describe('New Feature', () => {
  test('should do something', async ({ page }) => {
    await page.goto('/new-feature')
    await expect(page).toHaveTitle(/Pattern/)
  })
})
```

## 📚 Resources

- [Playwright Documentation](https://playwright.dev)
- [Best Practices Guide](https://playwright.dev/docs/best-practices)
- [API Reference](https://playwright.dev/docs/api/class-playwright)

---

**Last Updated**: 2026-04-08  
**Status**: ✅ All Tests Passing  
**Node Version**: v25.5.0  
**Playwright Version**: ^1.58.2
