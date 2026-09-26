import { createRouter, createWebHistory } from 'vue-router';
import AerialView from '@/views/AerialView.vue';
import MySpaceView from '@/views/MySpaceView.vue';

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
