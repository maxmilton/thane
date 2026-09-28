import { defineRoutes, linkTag, metaName } from 'thane/router';

const SITE = 'Meta Site';

const Routes = defineRoutes(
  {
    '/': {
      component: () => import('./pages/home.js').then((m) => m.HomePage),
      meta: {
        jsonLd: { '@context': 'https://schema.org', '@type': 'Organization', 'name': SITE },
      },
    },
    '/about': {
      component: () => import('./pages/about.js').then((m) => m.AboutPage),
      meta: {
        title: 'About',
        description: 'About the meta site',
        image: { url: '/og/about.png', alt: 'The team', width: 1200, height: 630 },
        author: 'Ada Lovelace',
        hreflang: { af: '/af/about', en: '/about' },
      },
    },
    '/products/:id': {
      component: () => import('./pages/product.js').then((m) => m.ProductPage),
      meta: (route) => ({ title: `Product ${route.params.id}`, robots: 'noindex' }),
    },
    'notFound': {
      component: () => import('./pages/not-found.js').then((m) => m.NotFoundPage),
      meta: { title: 'Not found', robots: 'noindex' },
    },
  },
  {
    meta: {
      siteUrl: 'https://meta.example.com',
      title: SITE,
      titleTemplate: `%s | ${SITE}`,
      description: 'The meta site',
      siteName: SITE,
      twitter: { site: '@metasite' },
    },
    customMeta: {
      author: metaName('author'),
      feed: linkTag('alternate', { type: 'application/rss+xml' }),
      hreflang: (langs: Record<string, string>) =>
        Object.entries(langs).map(([hreflang, href]) => ({ link: { rel: 'alternate', hreflang, href } })),
    },
  },
);

export default Routes;
