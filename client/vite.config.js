import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve, extname, sep } from 'path';
import { createReadStream, statSync } from 'fs';

/**
 * Dev-only stand-in for Caddy's `handle /games/*`.
 *
 * Game packages live in the repo-root `games/` workspace, deliberately
 * OUTSIDE client/: they are the mutable half of the site and must not become
 * part of the engine build or be bundled into dist. Production serves them
 * from /var/www/drone-navigation/games/; this mirrors the identical URLs on
 * the Vite dev server so `npm run dev` renders the Plaza with no extra
 * process and no path rewrite in the client.
 *
 * `apply: 'serve'` keeps the whole thing out of `npm run build`.
 *
 * Registered directly from configureServer (not via a returned post hook),
 * so it runs BEFORE Vite's internal middlewares — otherwise the SPA fallback
 * would answer /games/catalog.json with index.html, exactly the trap the
 * production Caddyfile avoids by matching /games/* ahead of the catch-all.
 */
function staticWorkspaceDev(pluginName, urlPrefix, root) {
  const MIME = {
    '.json': 'application/json; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    // Package dev tools (e.g. controller_viewer.html) must render in-place,
    // not download: octet-stream would make the browser save the page.
    '.html': 'text/html; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.woff2': 'font/woff2',
  };

  return {
    name: pluginName,
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith(urlPrefix)) return next();

        let rel;
        try {
          rel = decodeURIComponent(req.url.slice(urlPrefix.length).split('?')[0]);
        } catch {
          res.statusCode = 400;
          return res.end('bad request');
        }

        const file = resolve(root, rel);
        // Containment: a ../ sequence must not reach the rest of the repo.
        if (file !== root && !file.startsWith(root + sep)) {
          res.statusCode = 403;
          return res.end('forbidden');
        }

        let st;
        try {
          st = statSync(file);
        } catch {
          res.statusCode = 404;
          return res.end('not found');
        }
        if (!st.isFile()) {
          res.statusCode = 404;
          return res.end('not found');
        }

        const ext = extname(file).toLowerCase();
        res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');
        // Same split as production: the catalog and each package's card.json
        // are mutable and must revalidate; package media is cacheable.
        res.setHeader(
          'Cache-Control',
          ext === '.json' ? 'no-cache' : 'public, max-age=86400'
        );

        // Single-range support: <video controls preload="metadata"> reads the
        // moov box first and then seeks with Range requests, so without this
        // a trailer would only play from the top after buffering whole.
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (m && (m[1] || m[2])) {
          const suffix = !m[1] && m[2];
          let start = suffix ? st.size - parseInt(m[2], 10) : parseInt(m[1], 10);
          let end = suffix || !m[2] ? st.size - 1 : parseInt(m[2], 10);
          if (start < 0) start = 0;
          if (end > st.size - 1) end = st.size - 1;
          if (start > end) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${st.size}`);
            return res.end();
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
          res.setHeader('Content-Length', end - start + 1);
          return createReadStream(file, { start, end }).pipe(res);
        }

        res.setHeader('Content-Length', st.size);
        createReadStream(file).pipe(res);
      });
    },
  };
}

// Game packages (mutable half of the site) and developer tools both live
// OUTSIDE client/ and must never enter the engine bundle. Production serves
// /games/* from Caddy; /tools/* is DEV-ONLY and simply does not exist there.
const gamesWorkspaceDev = () =>
  staticWorkspaceDev('games-workspace-dev', '/games/', resolve(__dirname, '..', 'games'));
const toolsWorkspaceDev = () =>
  staticWorkspaceDev('tools-workspace-dev', '/tools/', resolve(__dirname, '..', 'tools'));

export default defineConfig({
  plugins: [
    vue(),
    gamesWorkspaceDev(),
    toolsWorkspaceDev(),
  ],
  // NOTE: no assetsInclude for .glb — the fleet machine meshes moved out of
  // client/ into the games/<id>/ packages and are fetched at runtime by URL
  // (useFleet.js), so the engine bundle never imports a binary asset again.
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'components'),
      '@shared-composables': resolve(__dirname, 'composables'),
      'vue-i18n': resolve(__dirname, 'node_modules/vue-i18n/dist/vue-i18n.esm-bundler.js'),
      'vue': resolve(__dirname, 'node_modules/vue/dist/vue.esm-bundler.js'),
      // NO 'vue-router' alias: vue-router 4.6 turned dist/vue-router.esm-bundler.js
      // into a 2-line shim that only console.warns and re-exports vue-router.mjs.
      // Letting the package's own `exports` map resolve 'vue-router' gives the
      // exact same module without the deprecation warning. (The vue / vue-i18n
      // aliases above stay: those esm-bundler files are the REAL builds that
      // honour the feature flags.)
    },
  },
  server: {
    port: 5173,
    host: true,
    fs: {
      allow: ['./'],
    },
  },
});
