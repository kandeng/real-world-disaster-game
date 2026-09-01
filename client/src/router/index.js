import { createRouter, createWebHistory } from 'vue-router';
import AerialView from '@/views/AerialView.vue';
import RoutePlanningView from '@/views/RoutePlanningView.vue';
import ChatView from '@/views/ChatView.vue';
import MySpaceView from '@/views/MySpaceView.vue';
import ExtensionsView from '@/views/ExtensionsView.vue';
import { useSessionState } from '@shared-composables/useSessionState.js';

const routes = [
  {
    path: '/',
    name: 'Aerial',
    component: AerialView,
  },
  {
    // Shareable play link (/play?r=<16-char route id>): the same 3D Exploration
    // page, but the query arms the route autopilot (fly-along playback).
    // The address bar keeps the /play URL so the link stays copyable.
    path: '/play',
    name: 'Play',
    component: AerialView,
  },
  {
    path: '/route-planning',
    name: 'RoutePlanning',
    component: RoutePlanningView,
  },
  {
    // Build Scene: place a mesh object into the Google Earth 3D scene
    // (2D map placement + 3D fine-tune). Lazy: pulls in the large mesh GLBs.
    path: '/build-scene',
    name: 'BuildScene',
    component: () => import('@/views/BuildSceneView.vue'),
  },
  {
    // Public Component: shared component library, Plugin-style layout with
    // twelve categories (overflow collapses into TabBar's » menu). Lazy like
    // the other heavy pages.
    path: '/public-component',
    name: 'PublicComponent',
    component: () => import('@/views/PublicComponentView.vue'),
  },
  {
    path: '/chat',
    name: 'Chat',
    component: ChatView,
  },
  {
    // My Space subpages: the shell's left panel navigates here; Account
    // shows the login/register card, Wallet and Content are blank for now.
    path: '/account',
    name: 'Account',
    component: MySpaceView,
    props: { sub: 'account' },
  },
  {
    path: '/wallet',
    name: 'Wallet',
    // Wallet concepts (Consumption / Income) now live as tabs on Account.
    redirect: '/account',
  },
  {
    path: '/content',
    name: 'Content',
    component: MySpaceView,
    props: { sub: 'content' },
  },
  {
    // Legacy deep links (/myspace?sub=…) keep working.
    path: '/myspace',
    redirect: (to) => {
      const sub = ['account', 'wallet', 'content'].includes(to.query.sub)
        ? to.query.sub
        : 'account';
      return { path: `/${sub}` };
    },
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
  {
    path: '/extensions',
    name: 'Extensions',
    component: ExtensionsView,
  },
  {
    path: '/gallery',
    name: 'Gallery',
    component: () => import('@/views/GalleryView.vue'),
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Phase 3 (session-state migration): track which page is active in the
// session store. Other pages keep the last map page recorded.
router.afterEach((to) => {
  const { session } = useSessionState();
  if (to.name === 'Aerial' || to.name === 'Play') session.view.page = 'aerial';
  else if (to.name === 'RoutePlanning') session.view.page = 'route';
  else if (to.name === 'BuildScene') session.view.page = 'build';
});

export default router;
