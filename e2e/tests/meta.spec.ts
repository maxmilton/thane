/**
 * Route heads in a browser: the site's meta and each route's are applied on navigation, custom fields
 * render their tags, a tag index.html already has is updated in place, setMeta() adds what arrives
 * later, and a production build serves each static route's page with its head already written.
 */
import { expect, test, type Page } from '@playwright/test';

/** The head as `id=value` lines: meta tags by name or property, then links by rel, then JSON-LD */
const head = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [`title=${document.title}`];
    for (const el of document.head.querySelectorAll('meta[name], meta[property]')) {
      out.push(`${el.getAttribute('name') ?? el.getAttribute('property')}=${el.getAttribute('content')}`);
    }
    for (const el of document.head.querySelectorAll('link[rel]')) {
      const hreflang = el.getAttribute('hreflang');
      out.push(`link ${el.getAttribute('rel')}${hreflang ? `:${hreflang}` : ''}=${el.getAttribute('href')}`);
    }
    for (const el of document.head.querySelectorAll('script[type="application/ld+json"]')) {
      out.push(`ld=${el.textContent}`);
    }
    return out;
  });

const count = (page: Page, selector: string) =>
  page.evaluate((s) => document.head.querySelectorAll(s).length, selector);

test.describe('route heads', () => {
  test("the home page: the site's title as it is, its defaults, canonical, JSON-LD", async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1.home')).toBeVisible();
    const lines = await head(page);
    expect(lines).toEqual(
      expect.arrayContaining([
        'title=Meta Site',
        'description=The meta site',
        'og:type=website',
        'og:site_name=Meta Site',
        'og:title=Meta Site',
        'og:url=https://meta.example.com/',
        'twitter:card=summary',
        'twitter:site=@metasite',
        'link canonical=https://meta.example.com/',
        'ld={"@context":"https://schema.org","@type":"Organization","name":"Meta Site"}',
      ]),
    );
    // index.html's own description is the one updated: there is one
    expect(await count(page, 'meta[name="description"]')).toBe(1);
  });

  test('navigating updates every tag in place, adds the route’s own, and removes what the next route lacks', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('a.to-about').click();
    await expect(page.locator('h1.about')).toBeVisible();
    const about = await head(page);
    expect(about).toEqual(
      expect.arrayContaining([
        'title=About | Meta Site',
        'description=About the meta site',
        'og:title=About | Meta Site',
        'og:url=https://meta.example.com/about',
        'og:image=https://meta.example.com/og/about.png',
        'og:image:alt=The team',
        'og:image:width=1200',
        'og:image:height=630',
        'twitter:card=summary_large_image',
        'twitter:image=https://meta.example.com/og/about.png',
        'author=Ada Lovelace',
        'link alternate:af=/af/about',
        'link alternate:en=/about',
        'link canonical=https://meta.example.com/about',
      ]),
    );
    expect(about.some((line) => line.startsWith('ld='))).toBe(false);
    for (const selector of ['meta[name="description"]', 'meta[property="og:title"]', 'link[rel="canonical"]']) {
      expect(await count(page, selector)).toBe(1);
    }

    await page.locator('a.to-home').click();
    await expect(page.locator('h1.home')).toBeVisible();
    const home = await head(page);
    expect(home).toContain('title=Meta Site');
    expect(home.some((line) => line.startsWith('author=') || line.startsWith('og:image'))).toBe(false);
    expect(home.some((line) => line.startsWith('link alternate'))).toBe(false);
    expect(home.some((line) => line.startsWith('ld='))).toBe(true);
  });

  test('a meta function reads the route; setMeta() adds the fields that arrive later, until the next route', async ({
    page,
  }) => {
    await page.goto('/');
    await page.locator('a.to-product').click();
    await expect(page.locator('h1.product')).toHaveText('Widget 42');
    await expect.poll(() => page.title()).toBe('Widget 42 | Meta Site');
    const product = await head(page);
    expect(product).toEqual(
      expect.arrayContaining([
        'robots=noindex',
        'description=A fine widget',
        'og:image=https://meta.example.com/img/widget.png',
        'author=Grace Hopper',
        'link canonical=https://meta.example.com/products/42',
      ]),
    );

    await page.locator('a.to-home').click();
    await expect(page.locator('h1.home')).toBeVisible();
    const home = await head(page);
    expect(home).toContain('title=Meta Site');
    expect(home.some((line) => line.startsWith('robots=') || line.startsWith('author='))).toBe(false);
  });

  test('the HTML a crawler gets: a production build writes each static route with its head', async ({
    page,
    request,
  }) => {
    const html = await (await request.get('/about')).text();
    if (!test.info().project.name.includes('-prod-')) {
      // A development build writes no route pages: every path gets index.html as written
      expect(html).toContain('<title>Meta E2E App</title>');
      return;
    }
    expect(html).toContain('<title>About | Meta Site</title>');
    expect(html).toContain('<meta property="og:image" content="https://meta.example.com/og/about.png">');
    expect(html).toContain('<meta name="author" content="Ada Lovelace">');
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
    // The page still boots the app, and the router takes the head over without duplicating a tag
    await page.goto('/about');
    await expect(page.locator('h1.about')).toBeVisible();
    for (const selector of ['meta[name="description"]', 'meta[property="og:image"]', 'meta[name="author"]']) {
      expect(await count(page, selector)).toBe(1);
    }
    // A route with parameters is the root page
    expect(await (await request.get('/products/7')).text()).toContain('<title>Meta Site</title>');
  });

  test("a path with a trailing slash is its route's, as a host serves a route page at /about/", async ({ page }) => {
    await page.goto('/about/');
    await expect(page.locator('h1.about')).toBeVisible();
    // The canonical link is the same however the page was reached
    expect(await head(page)).toContain('link canonical=https://meta.example.com/about');
  });
});
