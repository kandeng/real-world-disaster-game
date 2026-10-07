/**
 * copy-cesium.js — vendor the self-hosted CesiumJS build into client/public/cesium.
 *
 * WHY: CesiumJS (Cesium.js ~5 MB + Workers/Assets/Widgets) used to be pulled
 * from https://cesium.com at runtime by a blocking <script> in index.html. That
 * made EVERY page — including the Plaza, which never renders a globe — depend on
 * a third-party CDN we do not control and cannot cache on our own edge, and it
 * sent that ~5 MB leg through the visitor's VPN/proxy exit node. We now serve
 * Cesium from our OWN origin at /cesium/ (see src/loadCesium.js), so it is
 * cacheable by our CDN and immune to a cesium.com outage or a slow third-party
 * hop.
 *
 * HOW: the `cesium` npm package (devDependency, version pinned in package.json)
 * ships the full prebuilt library under node_modules/cesium/Build/Cesium. Vite
 * copies public/ verbatim into dist/, so mirroring that build into public/cesium
 * exposes it at /cesium/... in BOTH `npm run dev` and `npm run build`.
 *
 * public/cesium/ is gitignored: it is ~20 MB of generated, version-pinned vendor
 * output, fully reproducible from package.json, so it is never committed. This
 * script runs on every predev/prebuild and SKIPS the copy when the vendored
 * build already matches the installed version (marker file below).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = resolve(here, '..');

// `cesium` is a direct devDependency, so npm installs it at client/node_modules/
// cesium. Resolve the prebuilt directory from there rather than via
// require.resolve, which a package's `exports` map can block for subpaths.
const pkgDir = join(clientDir, 'node_modules', 'cesium');
const srcDir = join(pkgDir, 'Build', 'Cesium');
const destDir = join(clientDir, 'public', 'cesium');
const markerFile = join(destDir, '.cesium-version');

if (!existsSync(join(srcDir, 'Cesium.js'))) {
  console.error(
    '[copy-cesium] CesiumJS prebuilt files not found at ' + srcDir + '.\n' +
    '              Run `npm install` in client/ first (cesium is a devDependency).'
  );
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;

// Skip the ~20 MB copy when the vendored build already matches the installed
// version, so predev/prebuild stay fast on every run after the first.
if (
  existsSync(markerFile) &&
  existsSync(join(destDir, 'Cesium.js')) &&
  readFileSync(markerFile, 'utf8').trim() === version
) {
  console.log('[copy-cesium] public/cesium already at v' + version + ' — skipping copy.');
  process.exit(0);
}

console.log('[copy-cesium] vendoring CesiumJS v' + version + ' -> public/cesium/');
rmSync(destDir, { recursive: true, force: true });
mkdirSync(destDir, { recursive: true });
cpSync(srcDir, destDir, { recursive: true });
writeFileSync(markerFile, version + '\n');
console.log('[copy-cesium] done — Cesium now serves from our own origin at /cesium/.');
