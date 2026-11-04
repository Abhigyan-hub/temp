// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Production: when BACKEND_URL is set at build time (e.g. https://ssapi.mozartdev.in),
// /mailflow/** is proxied to the Express backend so the auth cookie stays first-party.
// Nitro turns this into a native rewrite on Vercel. Unset = nitro defaults are left untouched.
const backendUrl = process.env.BACKEND_URL?.replace(/\/$/, "");
// The Lovable config types only list a few nitro keys, but it forwards the whole object to nitro().
const nitroOptions = { routeRules: { "/mailflow/**": { proxy: `${backendUrl}/mailflow/**` } } } as { preset?: string };

export default defineConfig({
  ...(backendUrl ? { nitro: nitroOptions } : {}),
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    server: {
      // Local dev: forward API calls to the Express backend (cd backend && npm run dev).
      proxy: {
        "/mailflow": process.env.API_PROXY_TARGET ?? "http://localhost:5000",
      },
    },
  },
});
