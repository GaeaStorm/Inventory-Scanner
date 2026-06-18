import { useState } from "react";

import type { StoresState } from "./types";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export default function BackupRestorePanel(props: {
  stores: StoresState;
  onChanged: (state: StoresState) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true);
    props.onError("");
    try {
      await work();
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function restore(path?: string): Promise<void> {
    const selected = path ?? await window.desktop.stores.chooseBackupFile();
    if (!selected) return;
    if (!window.confirm(
      "Restore this SQLite backup? The app will first create a safety backup of the current database. Transactions recorded after the selected backup will not be present after restore.",
    )) return;
    const result = await window.desktop.stores.restoreBackup(selected);
    props.onChanged(result.state);
    props.onNotice(`Database restored. Safety backup: ${result.safetyBackupPath}`);
  }

  return (
    <article className="panel settings-wide-panel">
      <div className="panel__header">
        <div>
          <p className="eyebrow">BACKUP AND RESTORE</p>
          <h2>Validated SQLite snapshots</h2>
          <p>Every restore creates a new safety backup first. The selected file is integrity-checked before replacement.</p>
        </div>
      </div>
      <div className="settings-actions">
        <button className="button" type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await window.desktop.stores.backupNow();
          props.onChanged(await window.desktop.stores.getState());
          props.onNotice(`Validated backup created: ${result.path}`);
        })}>Back Up Now</button>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void run(async () => {
          const next = await window.desktop.stores.chooseFolder("backup");
          if (next) props.onChanged(next);
        })}>Choose backup folder</button>
        <button className="button button--secondary" type="button" disabled={busy} onClick={() => void run(() => restore())}>Restore from file…</button>
        <button className="button button--secondary" type="button" onClick={() => void window.desktop.stores.openPath(props.stores.database.backupFolder)}>Open backups</button>
      </div>
      <div className="table-scroll backup-list">
        <table>
          <thead><tr><th>Backup</th><th>Created</th><th>Schema</th><th>Size</th><th>Validation</th><th /></tr></thead>
          <tbody>
            {props.stores.database.backups.map((backup) => (
              <tr key={backup.path}>
                <td><code>{backup.fileName}</code></td>
                <td>{new Date(backup.createdAt).toLocaleString()}</td>
                <td>v{backup.schemaVersion}</td>
                <td>{formatBytes(backup.sizeBytes)}</td>
                <td>{backup.valid ? "Valid" : "Invalid"}</td>
                <td><button className="button button--small button--secondary" type="button" disabled={busy || !backup.valid} onClick={() => void run(() => restore(backup.path))}>Restore</button></td>
              </tr>
            ))}
            {props.stores.database.backups.length === 0 && <tr><td colSpan={6} className="empty-table">No backups in the selected folder.</td></tr>}
          </tbody>
        </table>
      </div>
    </article>
  );
}
