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
        theme_color: '#45334f',
        background_color: '#faf7f2',
        icons: [],
      },
    }),
  ],
});
