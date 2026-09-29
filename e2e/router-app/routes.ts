import { defineRoutes } from 'thane/router';
import HomePage from './pages/home.js';

const Routes = defineRoutes({
  '/': { component: HomePage, meta: { title: 'Home' } },
  '/about': { component: () => import('./pages/about.js'), meta: { title: 'About' } },
  '/users/:id': { component: () => import('./pages/user.js'), meta: { title: 'User' } },
  'notFound': { component: () => import('./pages/not-found.js'), meta: { title: '404 — Not Found' } },
  'error': { component: () => import('./pages/error.js'), meta: { title: 'Error' } },
});

export default Routes;
