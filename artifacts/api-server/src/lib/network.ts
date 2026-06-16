import { networkInterfaces } from "node:os";

export interface LanAddress {
  interfaceName: string;
  address: string;
  url: string;
}

function isPrivateIpv4(address: string): boolean {
  if (address.startsWith("10.")) {
    return true;
  }

  if (address.startsWith("192.168.")) {
    return true;
  }

  const match = /^172\.(\d+)\./.exec(address);
  const secondOctet = match ? Number(match[1]) : Number.NaN;

  return secondOctet >= 16 && secondOctet <= 31;
}

function isUsableIpv4(address: string): boolean {
  return address !== "0.0.0.0" && !address.startsWith("169.254.");
}

export function getLanAddresses(port: number): LanAddress[] {
  const addresses = new Map<string, LanAddress>();

  for (const [interfaceName, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (
        entry.family !== "IPv4" ||
        entry.internal ||
        !isUsableIpv4(entry.address)
      ) {
        continue;
      }

      addresses.set(entry.address, {
        interfaceName,
        address: entry.address,
        url: `http://${entry.address}:${port}`,
      });
    }
  }

  return [...addresses.values()].sort((left, right) => {
    const privateDifference =
      Number(isPrivateIpv4(right.address)) -
      Number(isPrivateIpv4(left.address));

    if (privateDifference !== 0) {
      return privateDifference;
    }

    return left.interfaceName.localeCompare(right.interfaceName);
  });
}

export function getServiceUrls(port: number): string[] {
  return [
    `http://localhost:${port}`,
    ...getLanAddresses(port).map(({ url }) => url),
  ];
}
