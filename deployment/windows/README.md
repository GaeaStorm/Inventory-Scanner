# Company LAN deployment

Use one authoritative Inventory Scanner installation on the **Production**
computer. The SQLite database, exports, and automatic backups stay there.

## Production computer

1. Give the computer the stable hostname `production`, or reserve a fixed IP.
2. Install Inventory Scanner.
3. Run PowerShell as Administrator:

   ```powershell
   .\Configure-ProductionServer.ps1 -TallyComputer accounts
   ```

4. Create the first `ADMIN` user, then create individual `PRODUCTION`,
   `ACCOUNTS`, `STORE`, and `SALES` users from Operations → Users.
5. Keep the computer awake while the company is using the application.

## Accounts computer

1. Give the computer the stable hostname `accounts`, or reserve a fixed IP.
2. Keep TallyPrime and the required company open.
3. Enable Tally's XML/HTTP server on port `9000`.
4. Run PowerShell as Administrator:

   ```powershell
   .\Configure-AccountsTally.ps1 -ProductionComputer production
   ```

5. In Inventory Scanner's Tally Syncer, test `accounts:9000`.

6. To use the Inventory Scanner dashboard on Accounts, install the same
   Inventory Scanner package and then run:

   ```powershell
   .\Configure-LanClient.ps1 -ProductionComputer production
   ```

   Sign in with the `ACCOUNTS` user created on Production.

## Other company computers

Install the same package, run `Configure-LanClient.ps1`, and sign in with each
person's central role account. LAN-client mode does not create a local SQLite
database; all requests go to Production.

The Accounts firewall rule permits Tally access only from Production. Do not
share the live SQLite file and do not install independent authoritative
databases on the other computers.

Backup/folder selection and generated-file download remain server-computer
operations because those paths belong to Production. Day-to-day inventory,
planning, production, role management, and Tally synchronization use the
central API.
