# МЕРТ-М Owner App

Отделно мобилно приложение за собственика (Android-first), което използва същия backend и auth като основната система.

## Scope

- Analytics: KPI + графика за приходи + топ продукти
- Incoming stock acceptance: преглед на доставки, оперативно приемане, потвърждение към API (`/incoming/:id/confirm`)

## Local run

1. `cp .env.example .env`
2. Задай `EXPO_PUBLIC_API_BASE_URL` към backend URL-а
3. `npm install`
4. `npm run android` (или `npm start` и после `a`)

## APK (preview)

`eas build --platform android --profile preview`
