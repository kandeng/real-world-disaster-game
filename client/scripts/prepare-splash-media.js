/**
 * Splash media synchronizer
 *
 * The web-optimized splash clips are tracked in git under
 * client/assets/media/ (pristine masters live in assets/media/original/).
 * client/public/splash/ is gitignored except the essential video_00.mp4 +
 * background_music_00.mp3, so a fresh clone (e.g. the ECS01 production
 * server) would miss most clips and splash.js would 404 on them.
 *
 * This script mirrors the tracked clips into public/splash/ — renaming
 * drone_earth_milkway.mp4 to the splash name video_00.mp4 — whenever the
 * destination is missing or out of sync (size differs). It runs from
 * `npm run prebuild` / `npm run predev`, BEFORE generate-splash-manifest.js
 * so playlist.json always reflects the synced directory. Deployment then
 * needs no manual copy step: `npm run build` produces a complete
 * dist/splash/ ready to ship to /var/www/drone-navigation/client/dist/.
 *
 * The background music needs no syncing: splash.js only plays
 * /splash/background_music_00.mp3, which IS tracked in git.
 */
import { copyFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEDIA_DIR = join(__dirname, '..', 'assets', 'media');
const SPLASH_DIR = join(__dirname, '..', 'public', 'splash');

// assets/media source -> public/splash destination. The first clip keeps
// its legacy splash name video_00.mp4 (splash.js / playlist.json expect it).
const COPY_MAP = {
  'drone_earth_milkway.mp4': 'video_00.mp4',
  'kevtoe_worldview.mp4': 'kevtoe_worldview.mp4',
  'palantir_maven.mp4': 'palantir_maven.mp4',
  'vantor_world3d.mp4': 'vantor_world3d.mp4',
};

for (const [src, dst] of Object.entries(COPY_MAP)) {
  const from = join(MEDIA_DIR, src);
  const to = join(SPLASH_DIR, dst);
  if (!existsSync(from)) {
    console.warn(`[splash-media] missing source ${src} — skipped`);
    continue;
  }
  // Already in sync when the sizes match (same tracked master).
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  console.log(`[splash-media] synced ${src} -> public/splash/${dst}`);
}
