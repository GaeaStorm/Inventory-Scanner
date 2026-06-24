import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export type DeploymentRole = "UNCONFIGURED" | "PRODUCTION_SERVER" | "LAN_CLIENT";

export interface DeploymentConfig {
  configured: boolean;
  role: DeploymentRole;
  productionHost: string;
  inventoryPort: number;
  tallyHost: string;
  tallyPort: number;
  accountsComputer: boolean;
}

export interface SaveDeploymentInput {
  role: Exclude<DeploymentRole, "UNCONFIGURED">;
  productionHost?: string;
  inventoryPort?: number;
  tallyHost?: string;
  tallyPort?: number;
  accountsComputer?: boolean;
  configureWindowsFirewall?: boolean;
}

const DEFAULT_PORT = 5000;
const DEFAULT_TALLY_PORT = 9000;
const executeFile = promisify(execFile);

function configPath(userDataDirectory: string): string {
  return path.join(userDataDirectory, "deployment.json");
}

function cleanHost(value: unknown, fallback: string): string {
  const host = String(value ?? "").trim();
  if (!host) return fallback;
  if (!/^[a-z0-9.-]+$/i.test(host)) {
    throw new Error("Computer names may contain only letters, numbers, dots, and hyphens.");
  }
  return host;
}

function cleanPort(value: unknown, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Port must be a whole number between 1 and 65535.");
  }
  return port;
}

export function normalizeDeploymentConfig(value: Partial<DeploymentConfig>): DeploymentConfig {
  const role = value.role === "PRODUCTION_SERVER" || value.role === "LAN_CLIENT"
    ? value.role
    : "UNCONFIGURED";
  return {
    configured: role !== "UNCONFIGURED",
    role,
    productionHost: cleanHost(value.productionHost, "production"),
    inventoryPort: cleanPort(value.inventoryPort, DEFAULT_PORT),
    tallyHost: cleanHost(value.tallyHost, "accounts"),
    tallyPort: cleanPort(value.tallyPort, DEFAULT_TALLY_PORT),
    accountsComputer: role === "LAN_CLIENT" && Boolean(value.accountsComputer),
  };
}

export function readDeploymentConfig(userDataDirectory: string): DeploymentConfig {
  const savedPath = configPath(userDataDirectory);
  if (existsSync(savedPath)) {
    try {
      return normalizeDeploymentConfig(JSON.parse(readFileSync(savedPath, "utf8")) as Partial<DeploymentConfig>);
    } catch (error) {
      throw new Error(`The saved LAN setup is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const legacyRemoteUrl = String(process.env.INVENTORY_SCANNER_REMOTE_URL ?? "").trim();
  if (legacyRemoteUrl) {
    const parsed = new URL(legacyRemoteUrl);
    return normalizeDeploymentConfig({
      role: "LAN_CLIENT",
      productionHost: parsed.hostname,
      inventoryPort: Number(parsed.port || 80),
    });
  }

  const databasePath = path.join(userDataDirectory, "data", "inventory-scanner.sqlite");
  if (existsSync(databasePath)) {
    return normalizeDeploymentConfig({
      role: "PRODUCTION_SERVER",
      inventoryPort: Number(process.env.INVENTORY_SCANNER_PORT ?? DEFAULT_PORT),
      tallyHost: process.env.INVENTORY_TALLY_HOST || "accounts",
    });
  }

  return normalizeDeploymentConfig({ role: "UNCONFIGURED" });
}

export function normalizeSaveDeploymentInput(value: unknown): SaveDeploymentInput {
  const input = (value ?? {}) as Partial<SaveDeploymentInput>;
  if (input.role !== "PRODUCTION_SERVER" && input.role !== "LAN_CLIENT") {
    throw new Error("Choose whether this is the Production server or a LAN client.");
  }
  return {
    role: input.role,
    productionHost: cleanHost(input.productionHost, "production"),
    inventoryPort: cleanPort(input.inventoryPort, DEFAULT_PORT),
    tallyHost: cleanHost(input.tallyHost, "accounts"),
    tallyPort: cleanPort(input.tallyPort, DEFAULT_TALLY_PORT),
    accountsComputer: input.role === "LAN_CLIENT" && Boolean(input.accountsComputer),
    configureWindowsFirewall: Boolean(input.configureWindowsFirewall),
  };
}

export async function saveDeploymentConfig(
  userDataDirectory: string,
  input: SaveDeploymentInput,
): Promise<DeploymentConfig> {
  const config = normalizeDeploymentConfig(input);
  await mkdir(userDataDirectory, { recursive: true });
  await writeFile(configPath(userDataDirectory), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function productionServerUrl(config: DeploymentConfig): string {
  return `http://${config.productionHost}:${config.inventoryPort}`;
}

export async function testProductionServer(input: unknown): Promise<{ ok: true; url: string; message: string }> {
  const normalized = normalizeSaveDeploymentInput({ ...(input as object), role: "LAN_CLIENT" });
  const url = `http://${normalized.productionHost}:${normalized.inventoryPort}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${url}/api/operations/auth/state`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Production returned HTTP ${response.status}.`);
    return { ok: true, url, message: "Production server found. This computer can connect." };
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError"
      ? "The connection timed out."
      : error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${url}. Check the computer name, port, network, and Production firewall. ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

function powershellEncodedCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export async function configureWindowsFirewall(input: SaveDeploymentInput): Promise<void> {
  if (process.platform !== "win32") return;

  const rules: string[] = [];
  if (input.role === "PRODUCTION_SERVER") {
    rules.push(
      `Remove-NetFirewallRule -DisplayName 'Inventory Scanner LAN API' -ErrorAction SilentlyContinue`,
      `New-NetFirewallRule -DisplayName 'Inventory Scanner LAN API' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${input.inventoryPort} -Profile Private`,
    );
  }
  if (input.role === "LAN_CLIENT" && input.accountsComputer) {
    rules.push(
      `$productionIp = [System.Net.Dns]::GetHostAddresses('${input.productionHost}')[0].IPAddressToString`,
      `Remove-NetFirewallRule -DisplayName 'Inventory Scanner Tally access' -ErrorAction SilentlyContinue`,
      `New-NetFirewallRule -DisplayName 'Inventory Scanner Tally access' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${input.tallyPort} -RemoteAddress $productionIp -Profile Private`,
    );
  }
  if (rules.length === 0) return;

  const elevatedCommand = powershellEncodedCommand([
    "$ErrorActionPreference = 'Stop'",
    ...rules,
  ].join("; "));
  const launcher = [
    "$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru",
    `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${elevatedCommand}'`,
    "; if ($process.ExitCode -ne 0) { exit $process.ExitCode }",
  ].join(" ");
  try {
    await executeFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", launcher]);
  } catch {
    throw new Error("Windows did not apply the firewall rule. Approve the Administrator prompt, or clear the firewall option and ask your IT administrator to allow the port.");
  }
}
