param(
  [string]$TallyComputer = "accounts",
  [int]$InventoryPort = 5000
)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script as Administrator on the Production computer."
}

[Environment]::SetEnvironmentVariable(
  "INVENTORY_TALLY_HOST",
  $TallyComputer,
  "Machine"
)
[Environment]::SetEnvironmentVariable(
  "INVENTORY_SCANNER_PORT",
  [string]$InventoryPort,
  "Machine"
)
[Environment]::SetEnvironmentVariable(
  "INVENTORY_SCANNER_REMOTE_URL",
  $null,
  "Machine"
)

$ruleName = "Inventory Scanner Production Server"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort $InventoryPort `
  -Profile Private

Write-Host "Production server configured on TCP $InventoryPort."
Write-Host "Tally computer configured as $TallyComputer."
Write-Host "Restart Inventory Scanner after running this script."
