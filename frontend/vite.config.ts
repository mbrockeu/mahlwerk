import { createHash } from 'node:crypto';
import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Relative base: the backend may serve the app below any path prefix.
export default defineConfig(({ mode }) => {
  // VITE_DEMO=1 builds the public demo (see scripts/build-site.sh); a normal build is unchanged.
  const demo = !!loadEnv(mode, '.', 'VITE_').VITE_DEMO;
  // `--mode app` builds the interface for the iOS app (web/dist-app): the API answered in the page (src/appMain.ts, ts/app).
  const app = mode === 'app';
  return {
    base: './',
    plugins: [
      svelte(),
      // the demo must not look like an installable copy of the real app: no manifest, no home-screen app mode
      demo && {
        name: 'mahlwerk-demo-html',
        transformIndexHtml: (html: string) => html
          .replace(/\s*<link rel="manifest"[^>]*>/, '')
          .replace(/\s*<meta name="(?:mobile-web|apple-mobile-web)-app-capable"[^>]*>/g, '')
          .replace('content="Mahlwerk"', 'content="Mahlwerk Demo"')
          .replace('<title>Mahlwerk</title>', '<title>Mahlwerk Demo</title>'),
      },
      app && {
        name: 'mahlwerk-app-html',
        transformIndexHtml: { // before vite reads the entry script
          order: 'pre' as const,
          handler: (html: string) => html
            .replace('src="/src/main.ts"', 'src="/src/appMain.ts"')
            .replace(/\s*<link rel="manifest"[^>]*>/, '') // not installable from inside the app
            // the first start opens the database and lays out the schema before the interface exists: say so instead of a blank page
            .replace('<div id="app"></div>', '<div id="app"><p id="boot" style="margin:40vh 0 0;text-align:center;font:15px system-ui,sans-serif;opacity:.6">'
              + '<script>document.write(/^de/i.test(navigator.language) ? "Mahlwerk wird geladen …" : "Mahlwerk is loading …")</script></p></div>'),
        },
      },
      // the app build: a Content-Security-Policy as meta tag (the pages come from the app's own scheme mahlwerk-app://, the native
      // bridge stands behind them): own scripts plus the hashes of the inline ones of index.html, no frames, no foreign connections
      app && {
        name: 'mahlwerk-app-csp',
        transformIndexHtml: {
          order: 'post' as const,
          handler: (html: string) => {
            const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
              .map((m) => `'sha256-${createHash('sha256').update(m[1]!).digest('base64')}'`);
            const self = "'self' mahlwerk-app:";
            const csp = [`default-src ${self}`, `script-src ${self} ${hashes.join(' ')}`, `style-src ${self} 'unsafe-inline'`,
              `img-src ${self} data: blob: https:`, `font-src ${self}`, `connect-src ${self}`, "frame-src 'none'", "object-src 'none'",
              "base-uri 'none'", "form-action 'none'"].join('; ');
            return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
          },
        },
      },
    ],
    build: { outDir: app ? '../web/dist-app' : '../web/dist', emptyOutDir: true, target: 'es2022' },
    server: { host: '127.0.0.1' },
  };
});
