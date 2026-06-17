import type { DesktopInfo } from "./types";

export {};

declare global {
  interface Window {
    desktop: {
      getInfo: () => Promise<DesktopInfo>;
      openDataFolder: () => Promise<string>;
      showExcelFile: () => Promise<boolean>;
    };
  }
}
