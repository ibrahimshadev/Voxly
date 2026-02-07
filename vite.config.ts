import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  base: './',
  server: {
    port: 1420,
    strictPort: true
  },
  clearScreen: false
});
