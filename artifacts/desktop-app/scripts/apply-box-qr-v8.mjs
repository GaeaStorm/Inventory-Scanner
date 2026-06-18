import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");

const desktopAppPath = path.join(
  repositoryRoot,
  "artifacts/desktop-app/src/renderer/App.tsx",
);
const scannerEntryPath = path.join(
  repositoryRoot,
  "artifacts/scanner-app/app/(tabs)/index.tsx",
);

const oldImport = 'import QrCodeCreatorTab from "./QrCodeCreatorTab";';
const newImport = 'import QrCodeCreatorTab from "./BoxQrCodeCreatorTab";';

const appSource = await readFile(desktopAppPath, "utf8");
if (!appSource.includes(newImport)) {
  if (!appSource.includes(oldImport)) {
    throw new Error(
      `Could not find the QR creator import in ${desktopAppPath}. Apply the v7 patch first or update the import manually.`,
    );
  }
  await writeFile(desktopAppPath, appSource.replace(oldImport, newImport));
  console.log("Updated Electron QR Creator to the multi-item box builder.");
} else {
  console.log("Electron QR Creator is already configured for multi-item boxes.");
}

const scannerEntry = 'export { default } from "@/components/BoxScannerScreen";\n';
const currentScannerEntry = await readFile(scannerEntryPath, "utf8");
if (currentScannerEntry !== scannerEntry) {
  await writeFile(scannerEntryPath, scannerEntry);
  console.log("Updated the Expo scanner screen to support box QR labels and item selection.");
} else {
  console.log("Expo scanner is already configured for box QR labels.");
}

console.log("Box QR v2 setup complete.");
