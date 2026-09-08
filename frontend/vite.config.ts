import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root: frontendRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [projectRoot],
    },
    proxy: {
      "/health": {
        target: "http://127.0.0.1:3996",
      },
      "/v1": {
        target: "http://127.0.0.1:3996",
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
    // The performance gate follows the entry's static import graph from this manifest. Hashed
    // filenames alone cannot tell a required first-load chunk from a route loaded on demand.
    manifest: true,
    // Browser source maps contain the original TypeScript and internal module structure. Keep
    // production artifacts private-by-default; a future error-reporting upload must build maps
    // into a non-public staging directory and delete them before the web bundle is served.
    sourcemap: false,
  },
});
