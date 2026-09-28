/**
 * Route heads: what resolveHead makes of the site's and a route's fields, the key that makes two tags
 * the same tag, and a tag as HTML. applyHead runs in a browser (e2e/tests/meta.spec.ts).
 */
import { describe, expect, test } from 'bun:test';
import { headTagHtml, headTagKey, linkTag, metaName, metaProperty, resolveHead, type HeadTag } from './router-head.js';

const SITE = {
  siteUrl: 'https://example.com/',
  title: 'Example',
  titleTemplate: '%s | Example',
  description: 'The site',
  siteName: 'Example',
  twitter: { site: '@example' },
};

/** The tags as `id=value` lines, in order */
const lines = (tags: HeadTag[]): string[] =>
  tags.map((tag) => {
    if ('meta' in tag) return `${tag.meta['name'] ?? tag.meta['property']}=${tag.meta['content']}`;
    if ('link' in tag) return `link ${tag.link['rel']}=${tag.link['href']}`;
    return `script ${tag.script['type']}=${tag.script.text}`;
  });

describe('resolveHead', () => {
  test('a route with a title and an image: the title template, derived Open Graph and Twitter tags, absolute URLs', () => {
    const head = resolveHead(SITE, { title: 'About', image: '/og/about.png' }, '/about', undefined);
    expect(head.title).toBe('About | Example');
    expect(lines(head.tags)).toEqual([
      'description=The site',
      'og:type=website',
      'og:site_name=Example',
      'og:title=About | Example',
      'og:description=The site',
      'og:url=https://example.com/about',
      'og:image=https://example.com/og/about.png',
      'twitter:card=summary_large_image',
      'twitter:site=@example',
      'twitter:title=About | Example',
      'twitter:description=The site',
      'twitter:image=https://example.com/og/about.png',
      'link canonical=https://example.com/about',
    ]);
  });

  test('Open Graph tags are properties; the others are names', () => {
    const { tags } = resolveHead(SITE, {}, '/', undefined);
    const attributeOf = (id: string) =>
      tags.map((tag) => ('meta' in tag ? tag.meta : {})).find((m) => m['name'] === id || m['property'] === id);
    expect(attributeOf('og:title')).toEqual({ property: 'og:title', content: 'Example' });
    expect(attributeOf('twitter:title')).toEqual({ name: 'twitter:title', content: 'Example' });
    expect(attributeOf('description')).toEqual({ name: 'description', content: 'The site' });
  });

  test("a route without a title shows the site's title as it is, not through the template", () => {
    expect(resolveHead(SITE, {}, '/', undefined).title).toBe('Example');
    expect(
      resolveHead({ ...SITE, titleTemplate: (t: string) => `${t} — Ex` }, { title: 'A' }, '/a', undefined).title,
    ).toBe('A — Ex');
  });

  test('the route overrides the defaults field by field, and the Twitter handles one by one', () => {
    const { tags } = resolveHead(
      SITE,
      { description: 'Mine', robots: 'noindex', type: 'article', twitter: { creator: '@ada' } },
      '/p',
      undefined,
    );
    const all = lines(tags);
    expect(all).toContain('description=Mine');
    expect(all).toContain('robots=noindex');
    expect(all).toContain('og:type=article');
    expect(all).toContain('twitter:site=@example');
    expect(all).toContain('twitter:creator=@ada');
    expect(all).toContain('twitter:card=summary');
  });

  test('canonical: an explicit one, made absolute; false for none; none without a site URL', () => {
    expect(lines(resolveHead(SITE, { canonical: '/x' }, '/y', undefined).tags)).toContain(
      'link canonical=https://example.com/x',
    );
    const none = lines(resolveHead(SITE, { canonical: false }, '/y', undefined).tags);
    expect(none.some((l) => l.startsWith('link canonical') || l.startsWith('og:url'))).toBe(false);
    const noSite = lines(resolveHead({ description: 'd' }, {}, '/y', undefined).tags);
    expect(noSite.some((l) => l.startsWith('link canonical'))).toBe(false);
  });

  test('the canonical path is the same however the page was reached; trailingSlash gives it a slash', () => {
    const canonical = (site: object, path: string) =>
      lines(resolveHead({ ...SITE, ...site }, {}, path, undefined).tags).find((l) => l.startsWith('link canonical'));
    expect(canonical({}, '/about/')).toBe('link canonical=https://example.com/about');
    expect(canonical({ trailingSlash: true }, '/about')).toBe('link canonical=https://example.com/about/');
    expect(canonical({ trailingSlash: true }, '/about/')).toBe('link canonical=https://example.com/about/');
    expect(canonical({ trailingSlash: true }, '/')).toBe('link canonical=https://example.com/');
  });

  test('an image with its details', () => {
    const { tags } = resolveHead(
      SITE,
      { image: { url: 'https://cdn.example.com/a.png', alt: 'A', width: 1200, height: 630, type: 'image/png' } },
      '/',
      undefined,
    );
    expect(lines(tags)).toEqual(
      expect.arrayContaining([
        'og:image=https://cdn.example.com/a.png',
        'og:image:alt=A',
        'og:image:width=1200',
        'og:image:height=630',
        'og:image:type=image/png',
        'twitter:image:alt=A',
      ]),
    );
  });

  test('JSON-LD is one script', () => {
    const ld = { '@context': 'https://schema.org', '@type': 'Organization', 'name': 'Example' };
    expect(lines(resolveHead(SITE, { jsonLd: ld }, '/', undefined).tags).at(-1)).toBe(
      `script application/ld+json=${JSON.stringify(ld)}`,
    );
  });

  test('custom fields: the helpers and a function; a field without a value adds nothing', () => {
    const custom = {
      author: metaName('author'),
      fbAppId: metaProperty('fb:app_id'),
      feed: linkTag('alternate', { type: 'application/rss+xml' }),
      hreflang: (langs: Record<string, string>) =>
        Object.entries(langs).map(([hreflang, href]) => ({ link: { rel: 'alternate', hreflang, href } })),
      unused: metaName('unused'),
    };
    const head = resolveHead(
      { ...SITE, fbAppId: '123' },
      { author: 'Ada', feed: '/feed.xml', hreflang: { af: '/af/', en: '/' } },
      '/',
      custom,
    );
    const tail = head.tags.slice(-5);
    expect(tail).toEqual([
      { meta: { name: 'author', content: 'Ada' } },
      { meta: { property: 'fb:app_id', content: '123' } },
      { link: { rel: 'alternate', type: 'application/rss+xml', href: '/feed.xml' } },
      { link: { rel: 'alternate', hreflang: 'af', href: '/af/' } },
      { link: { rel: 'alternate', hreflang: 'en', href: '/' } },
    ]);
  });

  test('an app that gives nothing but titles gets the title alone', () => {
    expect(resolveHead({}, { title: 'A' }, '/a', undefined)).toEqual({ title: 'A', tags: [] });
    expect(resolveHead({ titleTemplate: '%s | S' }, { title: 'A' }, '/a', undefined)).toEqual({
      title: 'A | S',
      tags: [],
    });
    expect(resolveHead({}, {}, '/a', undefined)).toEqual({ title: undefined, tags: [] });
  });
});

describe('headTagKey', () => {
  test('the kind and every attribute but the value, as a selector that finds the tag', () => {
    expect(headTagKey({ meta: { name: 'description', content: 'x' } })).toBe('meta[name="description"]');
    expect(headTagKey({ meta: { property: 'og:title', content: 'x' } })).toBe('meta[property="og:title"]');
    expect(headTagKey({ link: { rel: 'canonical', href: 'x' } })).toBe('link[rel="canonical"]');
    expect(headTagKey({ link: { rel: 'alternate', hreflang: 'af', href: '/af/' } })).toBe(
      'link[hreflang="af"][rel="alternate"]',
    );
    expect(headTagKey({ script: { type: 'application/ld+json', text: '{}' } })).toBe(
      'script[type="application/ld+json"]',
    );
  });

  test('quotes and backslashes in an attribute are escaped', () => {
    expect(headTagKey({ meta: { name: 'a"b\\c', content: '' } })).toBe('meta[name="a\\"b\\\\c"]');
  });
});

describe('headTagHtml', () => {
  test('attributes are escaped', () => {
    expect(headTagHtml({ meta: { name: 'description', content: 'Fish & "chips" <3' } })).toBe(
      '<meta name="description" content="Fish &amp; &quot;chips&quot; &lt;3">',
    );
  });

  test('a script cannot be closed by its JSON', () => {
    expect(headTagHtml({ script: { type: 'application/ld+json', text: '{"a":"</script><b>"}' } })).toBe(
      '<script type="application/ld+json">{"a":"<\\/script><b>"}</script>',
    );
  });
});
