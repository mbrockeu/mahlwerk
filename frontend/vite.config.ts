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
            .replace(/\s*<link rel="manifest"[^>]*>/, ''), // not installable from inside the app
        },
      },
    ],
    build: { outDir: app ? '../web/dist-app' : '../web/dist', emptyOutDir: true, target: 'es2022' },
    server: { host: '127.0.0.1' },
  };
});
