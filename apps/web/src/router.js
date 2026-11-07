// Four pages; hash history so the built console works from any static file server.
import { createRouter, createWebHashHistory } from 'vue-router';

export const routes = [
  { path: '/', name: 'overview', component: () => import('./views/OverviewView.vue'), meta: { title: 'Overview' } },
  { path: '/activity', name: 'activity', component: () => import('./views/ActivityView.vue'), meta: { title: 'Activity' } },
  { path: '/reviews', name: 'reviews', component: () => import('./views/ReviewsView.vue'), meta: { title: 'Reviews' } },
  { path: '/context', name: 'context', component: () => import('./views/ContextView.vue'), meta: { title: 'Context' } },
];

export const router = createRouter({ history: createWebHashHistory(), routes });
router.afterEach((to) => { document.title = `${to.meta.title ?? 'Console'} · Agentree`; });
