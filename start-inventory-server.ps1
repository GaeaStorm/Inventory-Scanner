$ErrorActionPreference = "Stop"

# ----- Config -----
$RepoPath = "C:\Inventory-Scanner"
$Port = "5050"
$ExcelPath = Join-Path $RepoPath "artifacts\api-server\stock_transactions.xlsx"

# ----- Move to repo -----
Set-Location $RepoPath

# ----- Find the active LAN/Wi-Fi IP -----
$IpAddress = (
  Get-NetIPConfiguration |
    Where-Object {
      $_.IPv4Address -and
      $_.IPv4DefaultGateway -and
      $_.NetAdapter.Status -eq "Up"
    } |
    Select-Object -First 1 -ExpandProperty IPv4Address
).IPAddress

if (-not $IpAddress) {
  $IpAddress = (
    Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*"
      } |
      Select-Object -First 1 -ExpandProperty IPAddress
  )
}

if (-not $IpAddress) {
  $IpAddress = "localhost"
}

$ServerUrl = "http://${IpAddress}:${Port}"
$HealthUrl = "$ServerUrl/api/healthz"

# ----- Environment for API server -----
$env:PORT = $Port
$env:HOST = "0.0.0.0"
$env:EXCEL_PATH = $ExcelPath

# ----- Start server in a separate PowerShell window -----
Start-Process powershell.exe -ArgumentList @(
  "-NoExit",
  "-ExecutionPolicy", "Bypass",
  "-Command",
  "cd '$RepoPath'; `$env:PORT='$Port'; `$env:HOST='0.0.0.0'; `$env:EXCEL_PATH='$ExcelPath'; pnpm --filter @workspace/api-server run dev"
)

# ----- Show simple window with URL -----
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "Inventory Server"
$form.Size = New-Object System.Drawing.Size(520, 260)
$form.StartPosition = "CenterScreen"
$form.TopMost = $true

$title = New-Object System.Windows.Forms.Label
$title.Text = "Inventory Server Running"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 16, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(20, 20)
$form.Controls.Add($title)

$label = New-Object System.Windows.Forms.Label
$label.Text = "Enter this URL in the phone app:"
$label.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(20, 70)
$form.Controls.Add($label)

$urlBox = New-Object System.Windows.Forms.TextBox
$urlBox.Text = $ServerUrl
$urlBox.Font = New-Object System.Drawing.Font("Consolas", 12)
$urlBox.Location = New-Object System.Drawing.Point(20, 95)
$urlBox.Size = New-Object System.Drawing.Size(460, 30)
$urlBox.ReadOnly = $true
$form.Controls.Add($urlBox)

$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Text = "Copy URL"
$copyButton.Location = New-Object System.Drawing.Point(20, 140)
$copyButton.Size = New-Object System.Drawing.Size(110, 34)
$copyButton.Add_Click({
  [System.Windows.Forms.Clipboard]::SetText($ServerUrl)
  [System.Windows.Forms.MessageBox]::Show("Copied: $ServerUrl")
})
$form.Controls.Add($copyButton)

$healthButton = New-Object System.Windows.Forms.Button
$healthButton.Text = "Open Health Check"
$healthButton.Location = New-Object System.Drawing.Point(145, 140)
$healthButton.Size = New-Object System.Drawing.Size(150, 34)
$healthButton.Add_Click({
  Start-Process $HealthUrl
})
$form.Controls.Add($healthButton)

$folderButton = New-Object System.Windows.Forms.Button
$folderButton.Text = "Open Excel Folder"
$folderButton.Location = New-Object System.Drawing.Point(310, 140)
$folderButton.Size = New-Object System.Drawing.Size(150, 34)
$folderButton.Add_Click({
  Start-Process (Split-Path $ExcelPath)
})
$form.Controls.Add($folderButton)

$note = New-Object System.Windows.Forms.Label
$note.Text = "Keep the server window open while scanning."
$note.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$note.AutoSize = $true
$note.Location = New-Object System.Drawing.Point(20, 190)
$form.Controls.Add($note)

$form.ShowDialog()