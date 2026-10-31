import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'favicon.svg'],
      manifest: {
        name: '今日菜单 · 家庭点菜',
        short_name: '今日菜单',
        description: '家人一起点菜、大厨看单、采购清单与营养建议',
        lang: 'zh-CN',
        theme_color: '#FF6B35',
        background_color: '#FFF8F3',
        display: 'standalone',
        // 不锁定方向：装到 iPad 主屏后可以横屏使用（锁 portrait 会让 PWA 永远转不过来）
        orientation: 'any',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/dishes'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'mealtime-dishes',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // 菜品实拍图等上传文件：开发时也由后端（8787）出，与线上一致
      '/uploads': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
  },
});
