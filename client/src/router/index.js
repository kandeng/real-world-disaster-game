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
    // Bootstrap the shared Cesium viewer on demand. On a hard load of /play,
    // index.html already imports cesium-main.js at page load; on a client-side
    // navigation from Plaza that import was skipped, so do it here before
    // AerialView mounts. ESM module caching makes this idempotent — the module
    // body (and the single `new Cesium.Viewer`) runs at most once even if both
    // imports are in flight, and the `window.cesiumViewer` guard skips the
    // warm re-entry entirely.
    beforeEnter: async () => {
      if (!window.cesiumViewer) {
        await import('@/cesium-main.js');
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
