import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Enable service worker + manifest serving in `npm run dev` too —
      // without this the manifest.webmanifest returns the SPA fallback HTML
      // and iOS can't recognize the page as a PWA when adding to home screen.
      devOptions: {
        enabled: true,
        type: "module",
        navigateFallback: "index.html",
      },
      includeAssets: [
        "vite.svg",
        "icon-192.svg",
        "icon-512.svg",
        "apple-touch-icon.svg",
      ],
      manifest: {
        name: "Greek Foods Owner PWA",
        short_name: "GF Owner",
        description:
          "Owner analytics and incoming stock acceptance for Greek Foods",
        id: "/owner",
        start_url: "/owner/dashboard",
        scope: "/owner",
        display: "standalone",
        display_override: ["standalone", "browser"],
        theme_color: "#0b1222",
        background_color: "#0b1222",
        icons: [
          {
            src: "/icon-192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icon-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
        shortcuts: [
          {
            name: "Анализи и печалба",
            short_name: "Анализи",
            url: "/owner/dashboard",
            icons: [{ src: "/icon-192.svg", sizes: "192x192" }],
          },
          {
            name: "Сканирай фактура",
            short_name: "Сканирай",
            url: "/owner/scan",
            icons: [{ src: "/icon-192.svg", sizes: "192x192" }],
          },
          {
            name: "Неплатени фактури",
            short_name: "Плащания",
            url: "/owner/payments",
            icons: [{ src: "/icon-192.svg", sizes: "192x192" }],
          },
          {
            name: "Топ продукти и партньори",
            short_name: "Топ",
            url: "/owner/top",
            icons: [{ src: "/icon-192.svg", sizes: "192x192" }],
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,svg,png,woff2}"],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Auth state must always come from network to avoid stale login/offline states.
            urlPattern: /^https:\/\/.*\/api\/auth\/.*/i,
            handler: "NetworkOnly",
          },
          {
            // Duplicate check should not use stale cached responses.
            urlPattern:
              /^https:\/\/.*\/api\/incoming\/check-duplicate(\?.*)?$/i,
            handler: "NetworkOnly",
          },
          {
            urlPattern:
              /^https:\/\/.*\/api\/(?!auth\/|incoming\/check-duplicate).*/i,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 5, // 5 minutes
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Bind to 0.0.0.0 so the dev server is reachable from LAN devices
    // (iPhone, iPad, other computers on the same Wi-Fi). Without this
    // Vite defaults to localhost only and `http://192.168.x.x:5173`
    // from a phone returns "connection refused".
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://localhost:3003",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
        secure: true,
      },
    },
  },
});
