import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
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
      external: [
        /^@next-round\/db(\/.*)?$/,
        /^@next-round\/platform(\/.*)?$/,
        /^@next-round\/game-sdk(\/server.*)?$/,
      ],
    },
  },
  server: {
    port: 3000,
  },
});
