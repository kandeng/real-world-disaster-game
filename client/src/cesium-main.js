import config from '../config.json';
import { useAppSettings } from '@shared-composables/useAppSettings.js';

Cesium.GoogleMaps.defaultApiKey = config.googleApiKey;
Cesium.Ion.defaultAccessToken = config.cesiumIonToken;

// Initialize with standard terrain mapping configuration profiles
let googleTileset = null;
const viewer = new Cesium.Viewer('cesiumContainer', {
    timeline: false,
    animation: false,
    baseLayerPicker: false,
    infoBox: false,
    selectionIndicator: false,
    // Hide default Cesium toolbar widgets
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    // Provide baseline imagery mapping vectors to map standard ground heights
    imageryProvider: new Cesium.TileMapServiceImageryProvider({
        url: Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')
    })
});

// Explicitly hide the underlying base globe surface to expose clean Google Meshes.
// If the photorealistic tileset fails to load, we re-enable the globe as a fallback.
viewer.scene.globe.show = false;

// ── WebGL context-loss detection ──
// If the GPU kills the WebGL context (memory pressure, driver reset), the
// canvas keeps showing its last frame while the rest of the app (physics,
// HUD, street view) keeps running — the 3D scene looks "frozen" even though
// nothing in the JS logic is broken. Surface it loudly instead of failing
// silently, and reload once the browser restores the context.
function showContextLostBanner() {
    if (document.getElementById('webgl-context-lost-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'webgl-context-lost-banner';
    banner.style.cssText =
        'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100000;' +
        'background:rgba(185,28,28,0.95);color:#fff;padding:12px 18px;border-radius:10px;' +
        'font:14px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,0.45);' +
        'display:flex;gap:14px;align-items:center;';
    const text = document.createElement('span');
    text.textContent = 'The 3D graphics context was lost (GPU overloaded), so the scene is frozen.';
    const button = document.createElement('button');
    button.textContent = 'Reload';
    button.style.cssText =
        'background:#fff;color:#b91c1c;border:none;border-radius:6px;' +
        'padding:6px 14px;font-weight:600;cursor:pointer;';
    button.onclick = () => location.reload();
    banner.appendChild(text);
    banner.appendChild(button);
    document.body.appendChild(banner);
}

viewer.canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); // allow the browser to attempt restoration
    console.error('[Cesium] WebGL context lost — the 3D canvas is frozen.');
    showContextLostBanner();
});
viewer.canvas.addEventListener('webglcontextrestored', () => {
    console.warn('[Cesium] WebGL context restored — reloading for a clean state.');
    location.reload();
});

// Cesium swallows render errors when rethrowRenderErrors is false (default),
// which can also leave the canvas showing a stale frame. Log them so a
// dying render pipeline is visible in the console.
viewer.scene.renderError.addEventListener((scene, error) => {
    console.error('[Cesium] Render error:', error);
});

/**
 * Resolve once the tileset reports tilesLoaded (all tiles needed for the
 * current view are loaded and drawn), or after a safety timeout.
 * Without a tileset (fallback path), proceed after a short fixed delay.
 */
function waitForTilesRendered(tileset, timeoutMs = 45000) {
    return new Promise((resolve) => {
        if (!tileset) {
            setTimeout(resolve, 3000);
            return;
        }
        const start = performance.now();
        function check() {
            if (tileset.tilesLoaded) {
                console.log('[Cesium] Initial view fully rendered (tilesLoaded).');
                resolve();
                return;
            }
            if (performance.now() - start > timeoutMs) {
                console.warn(`[Cesium] Tile render wait timeout (${timeoutMs / 1000}s), proceeding.`);
                resolve();
                return;
            }
            requestAnimationFrame(check);
        }
        // Give the traversal a moment to start loading before the first check.
        setTimeout(() => requestAnimationFrame(check), 1000);
    });
}

async function loadArena() {
    const { settings } = useAppSettings();
    const targetLatitude = settings.defaultLat;
    const targetLongitude = settings.defaultLon;
    const targetHeight = settings.defaultAlt;
    const initialPosition = Cesium.Cartesian3.fromDegrees(targetLongitude, targetLatitude, targetHeight);

    // Apply default direction from settings (yaw → heading, pitch, roll)
    const initialHeading = Cesium.Math.toRadians(settings.defaultYaw);
    const initialPitch = Cesium.Math.toRadians(settings.defaultPitch);
    const initialRoll = Cesium.Math.toRadians(settings.defaultRoll);

    // Position the camera at the default location and direction immediately
    // so that tiles for the correct viewport begin downloading.
    viewer.camera.setView({
        destination: initialPosition,
        orientation: {
            heading: initialHeading,
            pitch: initialPitch,
            roll: initialRoll
        }
    });

    try {
        // Attempt to load Google Photorealistic 3D Tiles.
        // This requires a valid Google API key with the Map Tiles API enabled and
        // a Cesium ion access token that is not expired.
        googleTileset = await Cesium.createGooglePhotorealistic3DTileset();
        viewer.scene.primitives.add(googleTileset);
        console.log('[Cesium] Google Photorealistic 3D Tileset created.');
    } catch (error) {
        console.warn('[Cesium] Google Photorealistic 3D Tileset failed to load:', error);
        console.warn('[Cesium] Falling back to Cesium World Terrain + OSM Buildings.');

        // Re-enable the base globe so the map is not blank.
        viewer.scene.globe.show = true;

        // Add Cesium World Terrain for elevation data.
        try {
            const terrain = await Cesium.createWorldTerrainAsync();
            viewer.terrainProvider = terrain;
            console.log('[Cesium] Cesium World Terrain loaded.');
        } catch (terrainError) {
            console.warn('[Cesium] Cesium World Terrain failed to load:', terrainError);
        }

        // Add OSM Buildings as a fallback 3D dataset.
        try {
            const osmBuildings = await Cesium.createOsmBuildingsAsync();
            viewer.scene.primitives.add(osmBuildings);
            console.log('[Cesium] OSM Buildings loaded.');
        } catch (osmError) {
            console.warn('[Cesium] OSM Buildings failed to load:', osmError);
        }
    }

    // ── Wait until the tiles for the initial view are actually rendered ──
    // tileLoadProgressEvent is unavailable in newer Cesium releases, and even
    // when present an empty download queue is misleading: the tileset refines
    // in waves, so the queue can momentarily hit 0 between waves while finer
    // tiles are still streaming. Cesium3DTileset.tilesLoaded is the reliable
    // signal — it becomes true only when every tile needed for the current
    // view is loaded AND drawn. The splash keeps playing until then (with a
    // safety cap) so the user never lands on an empty sky.
    await waitForTilesRendered(googleTileset);

    // Signal splash screen that Cesium 3D scene is ready with tiles rendered
    window.dispatchEvent(new CustomEvent('cesiumReady'));
}

/**
 * Update the Cesium camera to match the drone state and gimbal angles.
 * Called from the Vue dashboard on every animation frame.
 */
// Expose the viewer and tileset so the Vue dashboard can run collision raycasts.
window.cesiumViewer = viewer;
window.getGoogleTileset = function() {
    return googleTileset;
};

window.updateCesiumCamera = function(state) {
    if (!viewer) return;
    const position = Cesium.Cartesian3.fromDegrees(state.lon, state.lat, state.alt);
    const heading = Cesium.Math.toRadians(((state.heading + state.gimbalYaw) % 360 + 360) % 360);
    const pitch = Cesium.Math.toRadians(state.gimbalPitch);
    const roll = Cesium.Math.toRadians(state.gimbalRoll);

    viewer.camera.setView({
        destination: position,
        orientation: { heading, pitch, roll }
    });
};

window.addEventListener('load', loadArena);
