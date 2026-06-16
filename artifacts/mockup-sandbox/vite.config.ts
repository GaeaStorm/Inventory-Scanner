import path from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { mockupPreviewPlugin } from "./mockupPreviewPlugin";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: "${value}"`);
  }

  return port;
}

function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === "/") {
    return "/";
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, "")}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, projectRoot, "");

  const port = parsePort(env.PORT, 5173);
  const base = normalizeBasePath(env.BASE_PATH);

  return {
    root: projectRoot,
    base,

    plugins: [
      mockupPreviewPlugin(),
      react(),
      tailwindcss(),
    ],

    resolve: {
      alias: {
        "@": path.resolve(projectRoot, "src"),
      },
    },

    build: {
      outDir: path.resolve(projectRoot, "dist"),
      emptyOutDir: true,
    },

    server: {
      host: true,
      port,
      fs: {
        strict: true,
      },
    },

    preview: {
      host: true,
      port,
    },
  };
});