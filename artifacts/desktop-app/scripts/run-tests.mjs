import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const work = await mkdtemp(path.join(tmpdir(), "inventory-scanner-tests-"));
const output = path.join(work, "operations.test.cjs");
try {
  await build({
    entryPoints: [path.resolve("test/operations.test.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: "inline",
    external: ["node:sqlite"],
    logLevel: "warning",
  });
  const result = spawnSync(process.execPath, ["--test", output], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(work, { recursive: true, force: true });
}
