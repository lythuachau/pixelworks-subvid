// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import sitemap from '@astrojs/sitemap';
import { localMediaApiPlugin } from './scripts/localMediaApiPlugin.mjs';

// https://astro.build/config
export default defineConfig({
  // Production URL — required for absolute canonical/hreflang/OG URLs and the
  // sitemap. Update this if the site is served from a different domain.
  site: 'https://subvid.app',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // Caddy terminates TLS and rewrites Host to localhost:4321, so Astro's
  // built-in check cannot compare Origin correctly. src/middleware.ts applies
  // the equivalent guard using Caddy's X-Forwarded-Host/Proto instead.
  security: {
    checkOrigin: false,
  },
  i18n: {
    locales: ['vi'],
    defaultLocale: 'vi',
    routing: {
      prefixDefaultLocale: false
    }
  },
  integrations: [
    sitemap({
      i18n: {
        defaultLocale: 'vi',
        locales: { vi: 'vi' }
      }
    })
  ],
  vite: {
    // Always mount local media API in Vite dev so link import works without
    // the Cloudflare Worker (LOCAL_STATIC and plain `astro dev`).
    plugins: [tailwindcss(), localMediaApiPlugin()],
    // FFmpeg WASM needs SharedArrayBuffer → cross-origin isolation.
    // `credentialless` allows Hugging Face / unpkg model+core fetches without
    // requiring CORP on every third-party response.
    server: {
      // Allow reverse-proxy hosts (Caddy / VPS) so Vite does not block
      // requests with Host: subvid.choulee.indevs.in
      allowedHosts: [
        'subvid.choulee.indevs.in',
        '.choulee.indevs.in',
        'localhost',
      ],
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    preview: {
      allowedHosts: [
        'subvid.choulee.indevs.in',
        '.choulee.indevs.in',
        'localhost',
      ],
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    optimizeDeps: {
      exclude: ['mediabunny']
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    worker: {
      format: 'es'
    }
  }
});
