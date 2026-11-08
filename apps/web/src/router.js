// Four pages; hash history so the built console works from any static file server.
import { createRouter, createWebHashHistory } from 'vue-router';

export const routes = [
  { path: '/', redirect: '/overview' },
  { path: '/overview', name: 'overview', component: () => import('./views/OverviewView.vue'), meta: { title: 'Overview' } },
  { path: '/main', name: 'main', component: () => import('./views/MainView.vue'), meta: { title: 'Main' } },
  { path: '/main/history', name: 'main-history', component: () => import('./views/MainHistoryView.vue'), meta: { title: 'Main history', menu: 'main' } },
  { path: '/tasks', name: 'tasks', component: () => import('./views/TasksView.vue'), meta: { title: 'Tasks' } },
  { path: '/branches', name: 'branches', component: () => import('./views/BranchesView.vue'), meta: { title: 'Branches' } },
  { path: '/conflicts', name: 'conflicts', component: () => import('./views/ConflictsView.vue'), meta: { title: 'Conflicts' } },
  { path: '/activity', name: 'activity', component: () => import('./views/ActivityView.vue'), meta: { title: 'Activity' } },
  { path: '/approvals', name: 'approvals', component: () => import('./views/ApprovalsView.vue'), meta: { title: 'Approvals' } },
];

export const router = createRouter({ history: createWebHashHistory(), routes });
router.afterEach((to) => { document.title = `${to.meta.title ?? 'Console'} · Agentree`; });
