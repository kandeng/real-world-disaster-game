import { createRouter, createWebHistory } from 'vue-router';
import AerialView from '@/views/AerialView.vue';
import RealDroneView from '@/views/RealDroneView.vue';
import MeshView from '@/views/MeshView.vue';
import Satellite2DView from '@/views/Satellite2DView.vue';
import RoutePlanningView from '@/views/RoutePlanningView.vue';
import ChatView from '@/views/ChatView.vue';
import MySpaceView from '@/views/MySpaceView.vue';
import ExtensionsView from '@/views/ExtensionsView.vue';

const routes = [
  {
    path: '/',
    name: 'Aerial',
    component: AerialView,
  },
  {
    path: '/real-drone',
    name: 'RealDrone',
    component: RealDroneView,
  },
  {
    path: '/mesh',
    name: 'Mesh3D',
    component: MeshView,
  },
  {
    path: '/satellite',
    name: 'Satellite2D',
    component: Satellite2DView,
  },
  {
    path: '/route-planning',
    name: 'RoutePlanning',
    component: RoutePlanningView,
  },
  {
    path: '/chat',
    name: 'Chat',
    component: ChatView,
  },
  {
    path: '/customer-service',
    name: 'CustomerService',
    component: () => import('@/views/CustomerServiceView.vue'),
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
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
