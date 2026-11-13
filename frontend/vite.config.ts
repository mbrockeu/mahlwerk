import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Relative base: the backend may serve the app below any path prefix.
export default defineConfig(({ mode }) => {
  // VITE_DEMO=1 builds the public demo (see scripts/build-site.sh); a normal build is unchanged.
  const demo = !!loadEnv(mode, '.', 'VITE_').VITE_DEMO;
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
    ],
    build: { outDir: '../web/dist', emptyOutDir: true, target: 'es2022' },
    server: { host: '127.0.0.1' },
  };
});
