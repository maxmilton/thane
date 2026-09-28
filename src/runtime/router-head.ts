/**
 * Route metadata: the document head a route asks for. The title, the description, Open Graph and
 * Twitter tags, the canonical link, robots, JSON-LD and the app's own tags are resolved into plain tag
 * descriptions, which the router applies to `document.head` and a production build writes into each
 * static route's `index.html`. Nothing here touches the DOM until `applyHead` runs.
 */

/** A tag in the document head, as its attributes: `<meta …>`, `<link …>`, or a `<script>` with its text */
export type HeadTag =
  | { readonly meta: Readonly<Record<string, string>> }
  | { readonly link: Readonly<Record<string, string>> }
  | { readonly script: Readonly<Record<string, string>> & { readonly text: string } };

/** An image for link previews: `og:image` and `twitter:image`, with their details */
export interface RouteImage {
  /** Made absolute with `siteUrl` when it starts with `/` */
  url: string;
  alt?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  /** The MIME type, `image/png` */
  type?: string | undefined;
}

/** The head fields every route may set. The site's `meta` gives their defaults. */
export interface RouteMeta {
  /** `document.title` (through `titleTemplate`), `og:title` and `twitter:title` */
  title?: string | undefined;
  /** `<meta name="description">`, `og:description` and `twitter:description` */
  description?: string | undefined;
  /** The link-preview image */
  image?: string | RouteImage | undefined;
  /** `<link rel="canonical">` and `og:url`. Defaults to `siteUrl` and the path; `false` for none */
  canonical?: string | false | undefined;
  /** `<meta name="robots">`, such as `'noindex, nofollow'` */
  robots?: string | undefined;
  /** `og:type`: `'website'` unless set */
  type?: string | undefined;
  /** `og:site_name` */
  siteName?: string | undefined;
  /** `og:locale`, such as `'en_ZA'` */
  locale?: string | undefined;
  /** The Twitter card: its kind (`summary_large_image` when there is an image), and the site's and author's handles */
  twitter?: { card?: string | undefined; site?: string | undefined; creator?: string | undefined } | undefined;
  /** Structured data, written as one `<script type="application/ld+json">` */
  jsonLd?: object | readonly object[] | undefined;
}

/** The site's head: its URL, a title template, and the defaults of every field */
export interface SiteMeta extends RouteMeta {
  /** The site's address, `https://example.com`: canonical links and image URLs are made absolute with it */
  siteUrl?: string | undefined;
  /** `'%s | Site'`, or a function of the page title. A route without a title shows the site's `title` as it is */
  titleTemplate?: string | ((title: string) => string) | undefined;
  /**
   * Canonical URLs end with a slash (`https://example.com/about/`), as a host that serves each route's
   * page from its folder links to it. Without a slash unless set, however the page was reached
   */
  trailingSlash?: boolean | undefined;
}

/** A custom field: from the value a route gives to the tags it stands for (none for `null` or `undefined`) */
export type CustomMetaField<V = any> = (value: V) => HeadTag | readonly HeadTag[] | null | undefined;
export type CustomMetaFields = Record<string, CustomMetaField>;
/** The values a route may give the custom fields `C` */
export type CustomMetaValues<C extends CustomMetaFields> = { [K in keyof C]?: Parameters<C[K]>[0] | undefined };

/** A custom field for `<meta name="…" content="value">` */
export const metaName =
  (name: string): CustomMetaField<string> =>
  (content) => ({ meta: { name, content } });

/** A custom field for `<meta property="…" content="value">` (Open Graph and other RDFa properties) */
export const metaProperty =
  (property: string): CustomMetaField<string> =>
  (content) => ({ meta: { property, content } });

/** A custom field for `<link rel="…" href="value">`, with any other attributes the link needs */
export const linkTag =
  (rel: string, attributes?: Readonly<Record<string, string>>): CustomMetaField<string> =>
  (href) => ({ link: { rel, ...attributes, href } });

/** What the head of one page is: its document title and its tags */
export interface Head {
  title: string | undefined;
  tags: HeadTag[];
}

type AnyMeta = SiteMeta & Record<string, unknown>;

/**
 * The head of the page at `path`: the site's defaults, then the route's fields, then those set since
 * (`setMeta`), with the Open Graph and Twitter tags derived from them and the custom fields rendered.
 */
export const resolveHead = (
  site: AnyMeta,
  page: RouteMeta & Record<string, unknown>,
  path: string,
  custom: CustomMetaFields | undefined,
): Head => {
  const { siteUrl, titleTemplate, trailingSlash, ...defaults } = site;
  const m: AnyMeta = { ...defaults, ...page, twitter: { ...defaults.twitter, ...page.twitter } };
  const title =
    page.title == null
      ? defaults.title
      : typeof titleTemplate === 'function'
        ? titleTemplate(page.title)
        : titleTemplate
          ? titleTemplate.replace('%s', page.title)
          : page.title;
  // An app that gives nothing but titles gets the title alone, as a build without head support does
  const titlesOnly = (fields: Record<string, unknown>): boolean =>
    Object.keys(fields).every((key) => key === 'title' || key === 'titleTemplate' || fields[key] === undefined);
  if (titlesOnly(site) && titlesOnly(page)) return { title, tags: [] };

  const origin = siteUrl ? siteUrl.replace(/\/+$/, '') : '';
  const absolute = (url: string): string => (origin && url[0] === '/' ? origin + url : url);
  const canonical =
    m.canonical === false
      ? undefined
      : m.canonical
        ? absolute(m.canonical)
        : origin
          ? origin + (path.length > 1 ? path.replace(/\/+$/, '') + (trailingSlash ? '/' : '') : '/')
          : undefined;
  const image = typeof m.image === 'string' ? { url: m.image } : m.image;
  const twitter = m.twitter!;

  const tags: HeadTag[] = [];
  // Open Graph tags are RDFa properties; the others, Twitter's included, are names
  const meta = (id: string, content: unknown): void => {
    if (content != null && content !== '') {
      tags.push({ meta: { [id.startsWith('og:') ? 'property' : 'name']: id, content: String(content) } });
    }
  };
  meta('description', m.description);
  meta('robots', m.robots);
  meta('og:type', m.type ?? 'website');
  meta('og:site_name', m.siteName);
  meta('og:locale', m.locale);
  meta('og:title', title);
  meta('og:description', m.description);
  meta('og:url', canonical);
  meta('og:image', image && absolute(image.url));
  meta('og:image:alt', image?.alt);
  meta('og:image:width', image?.width);
  meta('og:image:height', image?.height);
  meta('og:image:type', image?.type);
  meta('twitter:card', twitter.card ?? (image ? 'summary_large_image' : 'summary'));
  meta('twitter:site', twitter.site);
  meta('twitter:creator', twitter.creator);
  meta('twitter:title', title);
  meta('twitter:description', m.description);
  meta('twitter:image', image && absolute(image.url));
  meta('twitter:image:alt', image?.alt);
  if (canonical) tags.push({ link: { rel: 'canonical', href: canonical } });
  if (m.jsonLd) tags.push({ script: { type: 'application/ld+json', text: JSON.stringify(m.jsonLd) } });
  if (custom) {
    for (const key in custom) {
      const value = m[key];
      if (value != null) tags.push(...([] as HeadTag[]).concat(custom[key]!(value) ?? []));
    }
  }
  return { title, tags };
};

const kindOf = (tag: HeadTag): 'meta' | 'link' | 'script' =>
  'meta' in tag ? 'meta' : 'link' in tag ? 'link' : 'script';
const attributesOf = (tag: HeadTag): Readonly<Record<string, string>> =>
  (tag as Record<string, Record<string, string>>)[kindOf(tag)]!;
/** The attribute that carries a tag's value; the others say which tag it is */
const VALUE = new Set(['content', 'href', 'text']);

/**
 * What makes a tag the same tag on the next page: its kind and every attribute except its value, as a
 * CSS selector (`meta[name="description"]`), which also finds one that `index.html` already has.
 */
export const headTagKey = (tag: HeadTag): string => {
  const attributes = attributesOf(tag);
  let key = kindOf(tag);
  for (const name of Object.keys(attributes).sort()) {
    if (!VALUE.has(name)) key += `[${name}="${attributes[name]!.replace(/["\\]/g, '\\$&')}"]`;
  }
  return key;
};

let _managed = new Map<string, Element>();

/**
 * Apply a page's head to the document: every tag is updated in place when the head has one with its
 * key (the router's own, or one written into `index.html`), or added; a tag the previous page had and
 * this one does not is removed.
 */
export const applyHead = (head: Head): void => {
  if (head.title !== undefined) document.title = head.title;
  const next = new Map<string, Element>();
  for (const tag of head.tags) {
    const key = headTagKey(tag);
    if (next.has(key)) continue;
    const el =
      _managed.get(key) ??
      document.head.querySelector(key) ??
      document.head.appendChild(document.createElement(kindOf(tag)));
    const attributes = attributesOf(tag);
    for (const name in attributes) {
      if (name === 'text') el.textContent = attributes[name]!;
      else el.setAttribute(name, attributes[name]!);
    }
    next.set(key, el);
  }
  for (const [key, el] of _managed) if (!next.has(key)) el.remove();
  _managed = next;
};

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A tag as HTML, for a built `index.html` */
export const headTagHtml = (tag: HeadTag): string => {
  const kind = kindOf(tag);
  const attributes = attributesOf(tag);
  let html = `<${kind}`;
  for (const name in attributes) if (name !== 'text') html += ` ${name}="${escapeAttribute(attributes[name]!)}"`;
  // `</script` inside JSON would end the element: JSON allows `<\/`
  return kind === 'script' ? `${html}>${(attributes['text'] ?? '').replace(/<\//g, '<\\/')}</script>` : `${html}>`;
};
