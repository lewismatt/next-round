// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    {
      name: "game-server-boundary",
      moduleParsed(module) {
        if (/\/games\/[^/]+\/src\/(?:server|content)\.ts$/.test(module.id)) {
          this.error(`Server-only game code reached the browser build: ${module.id}`);
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@next-round/ui/globals.css": path.resolve(__dirname, "../../packages/ui/src/styles/globals.css"),
      "@next-round/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
    },
    conditions: ["browser", "import", "module", "default"],
    mainFields: ["browser", "module", "main"],
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        "games/test-counter/0.1.0/client": path.resolve(
          __dirname,
          "../../games/test-counter/src/client.ts",
        ),
        "games/crossword/0.1.0/client": path.resolve(
          __dirname,
          "../../games/crossword/src/client.ts",
        ),
        "games/trivia/0.1.0/client": path.resolve(
          __dirname,
          "../../games/trivia/src/client.ts",
        ),
      },
      preserveEntrySignatures: "strict",
      external: [
        /^@next-round\/db(\/.*)?$/,
        /^@next-round\/platform(\/.*)?$/,
        /^@next-round\/game-sdk(\/server.*)?$/,
      ],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: false,
        ws: true,
      },
      "/games": {
        target: apiProxyTarget,
        changeOrigin: false,
      },
    },
  },
});
