import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'favicon.ico'],
      manifest: {
        name: 'Termly',
        short_name: 'Termly',
        description: 'The School Management System for modern Kenya.',
        start_url: '/',
        display: 'standalone',
        background_color: '#0C0E0D',
        theme_color: '#0C0E0D',
        orientation: 'portrait',
        categories: ['education', 'productivity'],
        icons: [
          { src: '/assets/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/assets/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/assets/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/assets/icon.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,woff2}'],
        // This file is installation-specific and must never be trapped in the precache.
        globIgnores: ['termly-runtime-config.js'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 5 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }
            }
          }
        ]
      }
    })
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom', 'react-helmet-async', 'papaparse'],
          supabase: ['@supabase/supabase-js', 'dexie'],
        }
      }
    },
    chunkSizeWarningLimit: 800
  }
})
