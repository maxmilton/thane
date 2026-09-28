import { serve } from 'bun';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function createHandler(root: string) {
  return async (req: Request) => {
    const pathname = new URL(req.url).pathname;
    const clean = pathname === '/' ? '/index.html' : pathname;
    const filePath = resolve(root, '.' + clean);

    // Prevent path traversal — resolved path must stay within root
    if (!filePath.startsWith(root)) {
      return new Response('Forbidden', { status: 403 });
    }

    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file);
    }

    // SPA fallback — return index.html for unmatched routes
    return new Response(Bun.file(resolve(root, 'index.html')));
  };
}

// Each app is served twice: its development build from e2e/.build on base+0 to base+3, and its production
// build from e2e/.build-prod ten ports higher. Ports derive from E2E_PORT_BASE (default 4173), as in
// playwright.config.ts.
const portBase = process.env.E2E_PORT_BASE ? Number(process.env.E2E_PORT_BASE) : 4173;
const apps = ['contract', 'router', 'cart', 'hardening'];
const builds = [
  { dir: '.build', offset: 0 },
  { dir: '.build-prod', offset: 10 },
];

const urls: string[] = [];
for (const { dir, offset } of builds) {
  apps.forEach((app, i) => {
    const root = resolve(process.cwd(), 'e2e', dir, app);
    if (!existsSync(root)) {
      throw new Error(
        `The ${app} app build output is missing at ${root}; the e2e web server command in playwright.config.ts builds it.`,
      );
    }
    const port = portBase + offset + i;
    serve({ port, development: false, routes: { '/*': createHandler(root) } });
    urls.push(`http://localhost:${port} (${app}${offset ? ', production' : ''})`);
  });
}

console.log(`E2E servers running on ${urls.join(', ')}`);
