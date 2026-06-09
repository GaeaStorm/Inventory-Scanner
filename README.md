On your phone (Expo Go)

Scan the QR code in Replit's URL bar menu to open the app in Expo Go
Scan tab: Point at a QR code → choose Stock In (+) or Stock Out (−) → set quantity → submit
History tab: See all transactions with sync status (green check = saved to server, amber clock = queued)
Settings tab: Enter your laptop's local IP to connect
On your laptop

Run the server: pnpm --filter @workspace/api-server run dev
Find your laptop's local IP (e.g. ipconfig on Windows, ifconfig on Mac)
Enter it in the app's Settings tab as http://192.168.1.x:5000
The Excel file (stock_transactions.xlsx) is saved in artifacts/api-server/ automatically
QR code format — your QR codes can encode either:

A plain product ID like PROD-001 through PROD-100 (100 products are pre-loaded on the server)
Or JSON: {"id":"PROD-001","name":"Widget A"} for custom product names
Offline mode — if the phone can't reach the laptop, transactions are queued locally and retry automatically every 30 seconds (or manually via Settings → Sync).
