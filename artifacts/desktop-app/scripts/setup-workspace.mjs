import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const packageJsonPath = path.join(repositoryRoot, "package.json");
const workspacePath = path.join(repositoryRoot, "pnpm-workspace.yaml");

async function updateRootScripts() {
  const source = await readFile(packageJsonPath, "utf8");
  const manifest = JSON.parse(source);

  manifest.scripts ??= {};
  manifest.scripts["desktop:setup"] =
    "node artifacts/desktop-app/scripts/setup-workspace.mjs";
  manifest.scripts["desktop:dev"] =
    "pnpm --filter @workspace/desktop-app dev";
  manifest.scripts["desktop:build"] =
    "pnpm --filter @workspace/desktop-app build";
  manifest.scripts["desktop:dist"] =
    "pnpm --filter @workspace/desktop-app dist";

  await writeFile(
    packageJsonPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

async function allowElectronInstallScript() {
  const source = await readFile(workspacePath, "utf8");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === "allowBuilds:");

  if (sectionIndex === -1) {
    const catalogIndex = lines.findIndex((line) => line.trim() === "catalog:");
    const insertAt = catalogIndex === -1 ? lines.length : catalogIndex;
    lines.splice(insertAt, 0, "allowBuilds:", "  electron: true");
  } else {
    let sectionEnd = lines.length;
    for (let index = sectionIndex + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line && !/^\s/.test(line) && !line.trimStart().startsWith("#")) {
        sectionEnd = index;
        break;
      }
    }

    const electronIndex = lines.findIndex(
      (line, index) =>
        index > sectionIndex &&
        index < sectionEnd &&
        /^\s+electron\s*:/.test(line),
    );

    if (electronIndex === -1) {
      lines.splice(sectionIndex + 1, 0, "  electron: true");
    } else {
      const indentation = lines[electronIndex].match(/^\s*/)?.[0] ?? "  ";
      lines[electronIndex] = `${indentation}electron: true`;
    }
  }

  const output = lines.join(newline);
  await writeFile(workspacePath, output.endsWith(newline) ? output : `${output}${newline}`, "utf8");
}

await Promise.all([updateRootScripts(), allowElectronInstallScript()]);

console.log("Electron workspace configuration is ready.");
console.log("Next: pnpm install");
