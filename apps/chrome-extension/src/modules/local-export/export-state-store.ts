import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { LocalExportState } from '@openplan/contracts';

// A separate small IndexedDB database, deliberately isolated from both the recorder's
// own store (idb-store.ts) and Step 2A's directory-handle-store.ts — local export status
// is neither recording data nor a storage setting, and a failed write here must never be
// able to affect either of those.
export const EXPORT_DB_NAME = 'openplan_local_export_db';
export const EXPORT_DB_VERSION = 1;

export interface ExportStatusRecord {
  sessionId: string;
  state: LocalExportState | 'PENDING' | 'EXPORTING';
  folderName?: string;
  fileName?: string;
  errorMessage?: string;
  updatedAt: string;
}

interface ExportDBSchema extends DBSchema {
  exportStatus: {
    key: string; // sessionId
    value: ExportStatusRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<ExportDBSchema>> | null = null;

function getExportDB(): Promise<IDBPDatabase<ExportDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<ExportDBSchema>(EXPORT_DB_NAME, EXPORT_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('exportStatus')) {
          db.createObjectStore('exportStatus', { keyPath: 'sessionId' });
        }
      },
    });
  }
  return dbPromise;
}

export async function setExportStatus(record: ExportStatusRecord): Promise<void> {
  const db = await getExportDB();
  await db.put('exportStatus', record);
}

export async function getExportStatus(sessionId: string): Promise<ExportStatusRecord | undefined> {
  const db = await getExportDB();
  return db.get('exportStatus', sessionId);
}
