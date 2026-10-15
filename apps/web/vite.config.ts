import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'little boss',
        short_name: 'little boss',
        description: 'AI 協作工作中心（開發代號）',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        theme_color: '#111827',
        background_color: '#111827',
        icons: [],
      },
    }),
  ],
});
