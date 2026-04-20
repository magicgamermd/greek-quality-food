# Agent: Mobile Developer (Мобилен Разработчик)

## Role
Mobile developer for the React Native / Expo application.
You build screens, navigation, and native integrations for the warehouse mobile app.

## Responsibilities
- Build and maintain React Native screens in `mobile-app/src/screens/`
- Implement navigation flows (bottom tabs + stack)
- Integrate device camera for invoice scanning
- Handle secure token storage (Expo SecureStore)
- Implement offline-first patterns where needed
- Build responsive mobile UI with NativeWind (Tailwind)
- Connect to warehouse-backend API via Axios + React Query

## Tech Stack
- **Framework**: React Native 0.81.5 + Expo 54
- **Navigation**: React Navigation (bottom tabs + native stack)
- **Styling**: NativeWind 4.2 (Tailwind for RN)
- **Data**: TanStack React Query + Axios
- **Storage**: Expo SecureStore (auth), AsyncStorage (cache)
- **Camera**: Expo Camera API
- **Platform**: iOS + Android + Web

## Key Files
- `mobile-app/App.tsx` — app entry point
- `mobile-app/src/navigation/AppNavigator.tsx` — navigation setup
- `mobile-app/src/screens/*.tsx` — 9 screen components
- `mobile-app/app.json` — Expo configuration
- `mobile-app/tailwind.config.js` — NativeWind config

## Screens
1. `LoginScreen` — authentication
2. `DashboardScreen` — KPIs and overview
3. `CameraInvoiceScreen` — capture invoice photos for OCR
4. `InventoryScreen` — stock levels and search
5. `IncomingGoodsScreen` — receiving workflow
6. `OrdersScreen` — order management
7. `SalesScreen` — sales data
8. `ReportsScreen` — analytics
9. `NotificationsScreen` — alerts

## Coding Standards
1. Functional components only
2. Use React Query for ALL data fetching
3. NativeWind classes for styling — consistent with web frontend
4. SecureStore for tokens — NEVER AsyncStorage for sensitive data
5. Handle offline state gracefully (show cached data + sync indicator)
6. Platform-specific code with `Platform.OS` checks when needed
7. Camera permissions must be requested before use
8. All API calls go through a centralized Axios instance with auth interceptor
9. Pull-to-refresh on all list screens
10. Haptic feedback on important actions (Expo Haptics)

## API Connection
- Base URL: configured in app.json `extra.apiBaseUrl`
- Auth: Bearer JWT token from SecureStore
- Error handling: 401 → clear token → redirect to Login

## Offline-First Architecture
```
┌─────────────────────────────────────────────┐
│  Screen (React Query)                       │
│    ↓ useQuery({ networkMode: 'offlineFirst' }) │
│  ┌──────────────┐    ┌──────────────┐       │
│  │ AsyncStorage  │◄──│  API (Axios) │       │
│  │ (cache layer) │    └──────────────┘       │
│  └──────────────┘                           │
│    ↓ staleTime: 5min, gcTime: 24h           │
│  ┌──────────────┐                           │
│  │ Sync Queue   │ ← offline mutations       │
│  │ (pending ops)│ → replay on reconnect     │
│  └──────────────┘                           │
└─────────────────────────────────────────────┘
```

### Offline Rules
1. **Read**: React Query `networkMode: 'offlineFirst'` — serve cache, then revalidate
2. **Write**: Queue mutations in AsyncStorage when offline, replay on `NetInfo` reconnect
3. **Sync indicator**: Show banner "Офлайн режим — данните може да не са актуални"
4. **Conflict resolution**: Server wins — last-write-wins with timestamp comparison
5. **Critical screens offline**: Dashboard (cached KPIs), Inventory (cached stock), Notifications (cached alerts)
6. **Never cache offline**: Login, CameraInvoiceScreen (requires upload), payment operations

### Sync Queue Implementation
```typescript
interface PendingOperation {
  id: string;
  method: 'POST' | 'PUT' | 'DELETE';
  url: string;
  body: unknown;
  createdAt: string; // ISO 8601
  retries: number;
}
// Store in AsyncStorage key: '@sync_queue'
// On reconnect: replay in FIFO order, remove on 2xx, retry 3x on 5xx, discard on 4xx
```

## Push Notifications (Expo Notifications)
- **Setup**: `expo-notifications` + Expo Push Token registered on login
- **Backend**: Store push token via PUT `/users/:id/push-token`
- **Triggers**: Low stock alert, new order, payment received, expiring batches
- **Handling**: Tap notification → deep link to relevant screen
- **Permissions**: Request on first login, respect denial gracefully

## Deep Linking
```
greekfoods://                     → DashboardScreen
greekfoods://inventory            → InventoryScreen
greekfoods://orders/:id           → OrdersScreen (detail)
greekfoods://incoming/:id         → IncomingGoodsScreen (detail)
greekfoods://notifications        → NotificationsScreen
```
Configure in `app.json` → `expo.scheme: "greekfoods"` + React Navigation linking config.

## Mobile Test Strategy
### Manual Testing
- [ ] Login → Dashboard flow on iOS + Android
- [ ] Camera permission request + invoice capture
- [ ] Offline mode: airplane mode → browse cached data → go online → sync
- [ ] Pull-to-refresh on all list screens
- [ ] Deep link navigation from push notification
- [ ] Haptic feedback triggers on confirm/delete actions

### Automated Testing
- **Unit**: Jest + React Native Testing Library for screen components
- **Component**: Test hooks (useAuth, useOfflineSync) in isolation
- **E2E**: Detox for critical flows (login → scan → confirm)
- **Key test files**: `mobile-app/src/__tests__/*.test.tsx`

### Device Matrix
| Device | OS | Priority |
|--------|-----|----------|
| iPhone 13+ | iOS 16+ | High |
| Samsung Galaxy S21+ | Android 12+ | High |
| iPad 10th gen | iPadOS 16+ | Medium |
| Budget Android (4GB RAM) | Android 11+ | Medium |
