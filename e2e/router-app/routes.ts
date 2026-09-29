import { defineRoutes } from 'thane/router';
import HomePage from './pages/home.js';

const Routes = defineRoutes({
  '/': { component: HomePage, meta: { title: 'Home' } },
  '/about': { component: () => import('./pages/about.js'), meta: { title: 'About' } },
  '/users/:id': { component: () => import('./pages/user.js'), meta: { title: 'User' } },
  '/old-about': { redirectTo: '/about' },
  '/members/:id': { redirectTo: (route) => `/users/${route.params.id}` },
  // Entered only when the query says so; otherwise sent home
  '/private': {
    component: () => import('./pages/about.js'),
    canEnter: (route) => route.searchParams.get('key') === 'open' || '/',
  },
  'notFound': { component: () => import('./pages/not-found.js'), meta: { title: '404 — Not Found' } },
  'error': { component: () => import('./pages/error.js'), meta: { title: 'Error' } },
});

export default Routes;
