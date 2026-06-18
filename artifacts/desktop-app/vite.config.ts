import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  root: path.join(appDirectory, "src", "renderer"),
  publicDir: path.join(appDirectory, "build", "public"),
  plugins: [react()],
  build: {
    outDir: path.join(appDirectory, "dist", "renderer"),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
