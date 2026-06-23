# Company LAN deployment

Use one authoritative Inventory Scanner installation on the **Production**
computer. The SQLite database, exports, and automatic backups stay there.

## Production computer

1. Give the computer the stable hostname `production`, or reserve a fixed IP.
2. Install and open Inventory Scanner.
3. In **Company LAN Setup**, choose **Production server**.
4. Enter the Accounts/Tally computer name (normally `accounts`) and keep the
   default ports unless your company uses different ones.
5. Leave the recommended Windows firewall option selected, choose **Save setup
   and restart**, and approve the Windows Administrator prompt.
6. Create the first `ADMIN` user.
7. Open Settings → Company Access and create individual `PRODUCTION`,
   `ACCOUNTS`, `STORE`, and `SALES` users. Every user needs a recovery email and
   their own password or PIN.
8. Keep the computer awake while the company is using the application.

## Accounts computer

1. Give the computer the stable hostname `accounts`, or reserve a fixed IP.
2. Keep TallyPrime and the required company open.
3. Enable Tally's XML/HTTP server on port `9000`.
4. Install and open Inventory Scanner.
5. In **Company LAN Setup**, choose **Company LAN client**, enter `production`
   (or its fixed IP), and select **This is the Accounts computer running
   TallyPrime**.
6. Leave the recommended Windows firewall option selected. Test the Production
   connection, save the setup, and approve the Windows Administrator prompt.
7. Sign in with the `ACCOUNTS` user created on Production.
8. In Tally Syncer, test `accounts:9000`.

## Other company computers

Install and open the same package. Choose **Company LAN client**, enter the
Production computer name or fixed IP, test the connection, and save. Sign in
with each person's central account. LAN-client mode does not create a local
SQLite database; all requests go to Production.

The setup can be changed later from Settings → Company LAN → Change LAN Setup.

The Accounts firewall rule permits Tally access only from Production. Do not
share the live SQLite file and do not install independent authoritative
databases on the other computers.

Backup/folder selection and generated-file download remain server-computer
operations because those paths belong to Production. Day-to-day inventory,
planning, production, role management, and Tally synchronization use the
central API.

The PowerShell files in this folder remain available for managed or automated
IT deployments, but ordinary installer users do not need them.
