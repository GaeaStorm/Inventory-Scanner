param(
  [string]$ProductionComputer = "production",
  [int]$TallyPort = 9000
)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script as Administrator on the Accounts computer."
}

$productionAddresses = [System.Net.Dns]::GetHostAddresses($ProductionComputer) |
  Where-Object { $_.AddressFamily -eq "InterNetwork" } |
  ForEach-Object { $_.IPAddressToString }
if (-not $productionAddresses) {
  throw "Could not resolve the Production computer. Pass its fixed IPv4 address with -ProductionComputer."
}

$ruleName = "Tally XML for Inventory Scanner"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $TallyPort `
  -RemoteAddress ($productionAddresses -join ",") `
  -Profile Private

Write-Host "Accounts allows Tally TCP $TallyPort from $($productionAddresses -join ', ')."
Write-Host "In TallyPrime, enable the XML/HTTP server on port $TallyPort and keep the company loaded."
