import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { logger } from '@openplan/core';

// Deliberately a separate IndexedDB database from the recorder's own store
// (see ../offline-cache/idb-store.ts) — storage-location settings are configuration,
// not recording data, and must stay decoupled from the recording pipeline.
export const SETTINGS_DB_NAME = 'openplan_storage_settings_db';
export const SETTINGS_DB_VERSION = 1;

const DIRECTORY_HANDLE_KEY = 'local-recording-folder';

interface StorageSettingsDBSchema extends DBSchema {
  directoryHandles: {
    key: string;
    value: FileSystemDirectoryHandle;
  };
}

let dbPromise: Promise<IDBPDatabase<StorageSettingsDBSchema>> | null = null;

function getSettingsDB(): Promise<IDBPDatabase<StorageSettingsDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<StorageSettingsDBSchema>(SETTINGS_DB_NAME, SETTINGS_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('directoryHandles')) {
          db.createObjectStore('directoryHandles');
        }
      },
    });
  }
  return dbPromise;
}

/** Persists the chosen directory handle so it can be reused across popup/tab reopens. */
export async function saveDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await getSettingsDB();
    await db.put('directoryHandles', handle, DIRECTORY_HANDLE_KEY);
    logger.info(`Recording folder handle saved: ${handle.name}`);
  } catch (error) {
    logger.error('Failed to persist recording folder handle:', error);
    throw new Error('ERR_STORAGE_HANDLE_WRITE_FAILED');
  }
}

/** Returns the previously-selected directory handle, or undefined if none was ever chosen. */
export async function getStoredDirectoryHandle(): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await getSettingsDB();
  return db.get('directoryHandles', DIRECTORY_HANDLE_KEY);
}

export async function clearStoredDirectoryHandle(): Promise<void> {
  const db = await getSettingsDB();
  await db.delete('directoryHandles', DIRECTORY_HANDLE_KEY);
}
