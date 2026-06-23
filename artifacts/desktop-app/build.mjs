import { mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import pinoPlugin from "esbuild-plugin-pino";

globalThis.require = createRequire(import.meta.url);

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const distDirectory = path.join(appDirectory, "dist");

await mkdir(distDirectory, { recursive: true });
await Promise.all([
  rm(path.join(distDirectory, "main.cjs"), { force: true }),
  rm(path.join(distDirectory, "main.cjs.map"), { force: true }),
  rm(path.join(distDirectory, "preload.cjs"), { force: true }),
  rm(path.join(distDirectory, "preload.cjs.map"), { force: true }),
]);

await build({
  absWorkingDir: appDirectory,
  entryPoints: [{ in: "src/main.ts", out: "main" }],
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: true,
  sourcemap: false,
  external: ["electron"],
  define: {
    "process.stdout.isTTY": "false",
  },
  plugins: [pinoPlugin({ transports: [] })],
  logLevel: "info",
});

for (const entry of await readdir(distDirectory, { recursive: true })) {
  if (entry.endsWith(".map")) {
    await rm(path.join(distDirectory, entry), { force: true });
  }
}

await build({
  absWorkingDir: appDirectory,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  minify: true,
  sourcemap: false,
  external: ["electron"],
  logLevel: "info",
});
