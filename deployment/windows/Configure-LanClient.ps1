param(
  [string]$ProductionComputer = "production",
  [int]$InventoryPort = 5000
)

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script as Administrator on each LAN client computer."
}

$serverUrl = "http://${ProductionComputer}:${InventoryPort}"
[Environment]::SetEnvironmentVariable(
  "INVENTORY_SCANNER_REMOTE_URL",
  $serverUrl,
  "Machine"
)

Write-Host "This computer is configured as an Inventory Scanner LAN client."
Write-Host "Production server: $serverUrl"
Write-Host "Restart Inventory Scanner after running this script."
