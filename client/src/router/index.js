import { createRouter, createWebHistory } from 'vue-router';
import MySpaceView from '@/views/MySpaceView.vue';

const routes = [
  {
    // Home page: Plaza (public masonry feed of game-package cards).
    path: '/',
    name: 'Plaza',
    component: () => import('@/views/PlazaView.vue'),
  },
  {
    // Legacy Plaza path kept as a redirect (old links / bookmarks).
    path: '/plaza',
    redirect: '/',
  },
  {
    // Play! page (3D Exploration). Also the target of shareable play links
    // (/play?r=<16-char route id>): the query arms the route autopilot
    // (fly-along playback). The address bar keeps the /play URL so the link
    // stays copyable.
    path: '/play',
    name: 'Play',
    // Lazy: keeps the heavy Cesium bundle out of the Plaza landing page.
    component: () => import('@/views/AerialView.vue'),
    // Bootstrap the shared Cesium viewer WITHOUT blocking the navigation. Fire
    // the two lazy steps — load the self-hosted CesiumJS library
    // (src/loadCesium.js), then import the module that creates the viewer
    // (src/cesium-main.js, which touches the Cesium global at module scope) —
    // and let them run in the BACKGROUND while /play renders and the intro splash
    // covers the scene. The old guard AWAITED both, so the router held the
    // transition on the ~5 MB download: clicking "Play the game" appeared to
    // freeze on the Plaza and only jumped to /play AFTER Cesium arrived. That is
    // backwards — the splash IS the loading UI, so the page must show first and
    // download behind it, exactly what the hard-load gate in index.html already
    // does in parallel with the Vue boot. On a client-side navigation from Plaza
    // neither step has run yet, so kick them here (non-blocking).
    //
    // Mounting AerialView before the viewer exists is safe: the viewer is created
    // on the GLOBAL #cesiumContainer (index.html), not inside the route
    // component, and every consumer reads window.cesiumViewer lazily (getViewer())
    // or guards it, while AerialView's rAF loop re-runs syncCesiumCamera() every
    // frame — so the first frame after the viewer appears picks it up. Both steps
    // are idempotent: loadCesium shares one in-flight promise and ESM caching runs
    // the cesium-main.js body (and the single `new Cesium.Viewer`) at most once
    // even if a rapid re-entry fires this again; the `window.cesiumViewer` guard
    // skips a warm re-entry entirely.
    beforeEnter: () => {
      if (!window.cesiumViewer) {
        import('@/loadCesium.js')
          .then((m) => m.loadCesium())
          .then(() => import('@/cesium-main.js'))
          .catch((err) => console.error('[cesium] /play bootstrap failed:', err));
      }
    },
  },
  {
    // Account: login/register card + consumption / income tabs.
    path: '/account',
    name: 'Account',
    component: MySpaceView,
    props: { sub: 'account' },
  },
  {
    // Auth flow action pages (email links + Google OAuth landing)
    path: '/verify-email',
    name: 'VerifyEmail',
    component: () => import('@/views/VerifyEmailView.vue'),
  },
  {
    path: '/reset-password',
    name: 'ResetPassword',
    component: () => import('@/views/ResetPasswordView.vue'),
  },
  {
    path: '/auth/callback',
    name: 'AuthCallback',
    component: () => import('@/views/AuthCallbackView.vue'),
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
