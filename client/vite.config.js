import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          // Recognize the <model-viewer> web component (@google/model-viewer,
          // used by Content -> 3D Asset) as a native custom element so the
          // SFC compiler emits it verbatim instead of resolving a component.
          isCustomElement: (tag) => tag === 'model-viewer',
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'components'),
      '@shared-composables': resolve(__dirname, 'composables'),
      'vue-i18n': resolve(__dirname, 'node_modules/vue-i18n/dist/vue-i18n.esm-bundler.js'),
      'vue': resolve(__dirname, 'node_modules/vue/dist/vue.esm-bundler.js'),
      'vue-router': resolve(__dirname, 'node_modules/vue-router/dist/vue-router.esm-bundler.js'),
    },
  },
  server: {
    port: 5173,
    host: true,
    fs: {
      allow: ['./'],
    },
    proxy: {
      // Same-origin reachability to the local Synapse homeserver — the SPA
      // never talks to Matrix anywhere else (Caddy mirrors this in prod).
      '/_matrix': {
        target: 'http://127.0.0.1:8008',
        changeOrigin: true,
      },
    },
  },
});
