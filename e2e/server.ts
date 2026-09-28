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

const contractRoot = resolve(process.cwd(), 'e2e', '.build', 'contract');
const routerRoot = resolve(process.cwd(), 'e2e', '.build', 'router');
const cartRoot = resolve(process.cwd(), 'e2e', '.build', 'cart');
const hardeningRoot = resolve(process.cwd(), 'e2e', '.build', 'hardening');

if (!existsSync(contractRoot)) {
  throw new Error(`Contract app build output missing at ${contractRoot}. Run e2e:build first.`);
}

if (!existsSync(routerRoot)) {
  throw new Error(`Router app build output missing at ${routerRoot}. Run e2e:build first.`);
}

if (!existsSync(cartRoot)) {
  throw new Error(`Cart app build output missing at ${cartRoot}. Run e2e:build first.`);
}

if (!existsSync(hardeningRoot)) {
  throw new Error(`Hardening app build output missing at ${hardeningRoot}. Run e2e:build first.`);
}

// Ports derive from E2E_PORT_BASE (default 4173), as in playwright.config.ts
const portBase = process.env.E2E_PORT_BASE ? Number(process.env.E2E_PORT_BASE) : 4173;
const contractPort = portBase;
const routerPort = portBase + 1;
const cartPort = portBase + 2;
const hardeningPort = portBase + 3;

serve({
  port: contractPort,
  development: false,
  routes: { '/*': createHandler(contractRoot) },
});

serve({
  port: routerPort,
  development: false,
  routes: { '/*': createHandler(routerRoot) },
});

serve({
  port: cartPort,
  development: false,
  routes: { '/*': createHandler(cartRoot) },
});

serve({
  port: hardeningPort,
  development: false,
  routes: { '/*': createHandler(hardeningRoot) },
});

console.log(
  `E2E servers running on http://localhost:${contractPort} (contract), http://localhost:${routerPort} (router), http://localhost:${cartPort} (cart), and http://localhost:${hardeningPort} (hardening)`,
);
