# Greek Foods Mobile App — Progress

## Status: ✅ Complete (Initial Build)

**Built by:** Ada-Mobile  
**Date:** 2026-02-23  
**Target:** Android SDK 28+ (read-only analytics)

---

## Architecture

```
mobile-app/
├── App.tsx                    # Root: QueryClient + AuthProvider + Navigator
├── global.css                 # NativeWind Tailwind imports
├── tailwind.config.js         # Dark theme + #6c3dff purple accent
├── babel.config.js            # NativeWind babel preset
├── metro.config.js            # NativeWind metro config
├── app.json                   # Expo config (Android SDK 28+, dark splash)
├── .env                       # EXPO_PUBLIC_API_BASE_URL=http://192.168.1.100:3000
├── .env.example               # Template for env
└── src/
    ├── types/index.ts         # All TypeScript types matching backend schema
    ├── api/
    │   ├── client.ts          # Axios client with JWT interceptors
    │   └── endpoints.ts       # All API endpoint functions
    ├── store/
    │   └── authStore.ts       # SecureStore JWT persistence
    ├── hooks/
    │   ├── useAuth.ts         # AuthContext + useAuthState
    │   └── useQueries.ts      # TanStack Query hooks for all data
    ├── utils/
    │   └── format.ts          # Currency, date, expiry formatting
    ├── components/
    │   ├── Card.tsx            # Dark card container
    │   ├── KpiCard.tsx         # Metric display card
    │   ├── LoadingSpinner.tsx  # Full-screen loading
    │   ├── ErrorView.tsx       # Error + retry
    │   ├── StatusBadge.tsx     # Order status badge (BG labels)
    │   └── PeriodSelector.tsx  # Today/Week/Month/Custom tabs
    ├── navigation/
    │   └── AppNavigator.tsx   # Stack (Login/Main) + Bottom Tab Navigator
    └── screens/
        ├── LoginScreen.tsx     # JWT login + remember me toggle
        ├── DashboardScreen.tsx # KPI cards + expiry alerts
        ├── SalesScreen.tsx     # Bar chart + top products
        ├── InventoryScreen.tsx # Product list + low stock + expiry filter
        ├── OrdersScreen.tsx    # Orders list + modal detail view
        ├── ReportsScreen.tsx   # Daily + monthly report tabs
        └── NotificationsScreen.tsx # Notifications + push registration
```

---

## Screens Built

### 1. Login Screen ✅
- JWT auth via POST /auth/login
- "Запомни ме" (Remember me) toggle
- Token stored in SecureStore (hardware-backed on Android)
- Show/hide password toggle
- Error alerts in Bulgarian

### 2. Dashboard Screen ✅
- KPI Cards: Today's orders, Stock value, Low stock count, Pending payments
- Expiring soon alert banner
- Pull-to-refresh
- Auto-refresh every 60 seconds
- Logout button

### 3. Sales Analytics Screen ✅
- Period selector: Днес / Седмица / Месец / По избор
- Bar chart using **react-native-gifted-charts** BarChart
- Total revenue + order count summary
- Top products ranked list with revenue
- Pull-to-refresh

### 4. Inventory Screen ✅
- Full product list with stock quantities
- Per-batch expiry date display
- Filter: All / Low Stock (⚠️) / Expiring (🕐)
- Search by product name or SKU
- Expiry color coding: 🔴 expired, 🟡 <30 days, 🟢 safe
- Pull-to-refresh

### 5. Orders Screen ✅
- Recent orders list with status badges (Bulgarian labels)
- Status filter chips: All / Pending / Processing / Fulfilled / Invoiced / Cancelled
- Search by order ID or partner name
- Order detail modal (slide up):
  - Partner name, status, dates, source
  - Full items list with quantities and prices
- Pull-to-refresh

### 6. Reports Screen ✅
- Daily report tab:
  - Today's orders, revenue, items sold, new stock, payments, low stock alerts
- Monthly report tab:
  - Month navigation (prev/next arrows)
  - Total orders, revenue, avg daily, payments collected
  - Top 5 products for the month

### 7. Notifications Screen ✅
- Full notification list with type-based icons and color coding:
  - ⚠️ Low stock (amber)
  - 🕐 Expiring (red)
  - 💳 Payment (green)
  - 📦 Order (purple)
  - ⚙️ System (gray)
- Tap to mark as read
- Unread count badge on tab icon
- **Push notification registration** (Expo Push):
  - Requests permission on first open
  - Sets Android notification channels: default, low_stock, expiring
  - Logs Expo Push Token (ready to send to backend)
- Auto-refresh every 30 seconds

---

## Design System
- **Background:** `#0f0f1a` (deep dark navy)
- **Cards:** `#1a1a2e`
- **Elevated surfaces:** `#252540`
- **Borders:** `#2d2d4e`
- **Primary accent:** `#6c3dff` (purple)
- **Success:** `#22c55e`
- **Warning:** `#f59e0b`
- **Danger:** `#ef4444`
- **Text primary:** `#f0f0ff`
- **Text secondary:** `#9090b8`
- All UI text in **Bulgarian**

---

## Tech Stack
- **React Native + Expo SDK 52** (TypeScript)
- **NativeWind v4** (Tailwind for RN)
- **React Navigation v7** (Stack + Bottom Tabs)
- **TanStack Query v5** (data fetching + caching)
- **Axios** (HTTP client with JWT interceptor)
- **react-native-gifted-charts** (BarChart for sales)
- **expo-secure-store** (JWT token storage)
- **expo-notifications** (push notification support)
- **@react-native-async-storage/async-storage** (user data)

---

## Configuration

### API URL
Edit `.env`:
```
EXPO_PUBLIC_API_BASE_URL=http://YOUR_SERVER_IP:3000
```

### Build for Android
```bash
# Development
npx expo start --android

# Production APK
npx expo build:android
# or with EAS:
eas build --platform android
```

### Minimum Requirements
- Android SDK 28+ (Android 9.0 Pie)
- Physical device recommended for push notifications

---

## TODO / Future
- [ ] Send push token to backend on login
- [ ] Custom date range picker for Sales (currently shows "По избор" tab without input)
- [ ] Stock forecast chart (GET /ai/forecast/:id)
- [ ] Anomaly detection screen (GET /ai/anomalies)
- [ ] Product image display
- [ ] Offline mode / local caching strategy
- [ ] EAS Build configuration (eas.json)
- [ ] Biometric auth (FaceID/Fingerprint)
