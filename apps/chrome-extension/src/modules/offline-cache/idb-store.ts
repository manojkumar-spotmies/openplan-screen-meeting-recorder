import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { LocalVideoSession, LocalVideoChunk } from '@openplan/contracts';
import { logger } from '@openplan/core';

export const DB_NAME = 'openplan_recorder_db';
export const DB_VERSION = 2;

export interface RecorderDBSchema extends DBSchema {
  sessions: {
    key: string;
    value: LocalVideoSession;
    indexes: {
      createdAt: string;
      status: string;
    };
  };
  chunks: {
    key: [string, number]; // Compound key: [sessionId, sequenceNumber]
    value: LocalVideoChunk;
    indexes: {
      sessionId: string;
      sequenceNumber: number;
      synced: number;
    };
  };
}



let dbPromise: Promise<IDBPDatabase<RecorderDBSchema>> | null = null;

export async function computeSha256(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Node fallback for tests
  const { createHash } = await import('crypto');
  return createHash('sha256').update(Buffer.from(arrayBuffer)).digest('hex');
}

export function getDB(): Promise<IDBPDatabase<RecorderDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<RecorderDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, transaction) {
        // Sessions store
        if (!db.objectStoreNames.contains('sessions')) {
          const sessionStore = db.createObjectStore('sessions', { keyPath: 'sessionId' });
          sessionStore.createIndex('createdAt', 'createdAt');
          sessionStore.createIndex('status', 'status');
        }

        // Chunks store
        if (!db.objectStoreNames.contains('chunks')) {
          const chunkStore = db.createObjectStore('chunks', {
            keyPath: ['sessionId', 'sequenceNumber'],
          });
          chunkStore.createIndex('sessionId', 'sessionId');
          chunkStore.createIndex('sequenceNumber', 'sequenceNumber');
          chunkStore.createIndex('synced', 'synced');
        } else if (oldVersion < 2) {
          const chunkStore = transaction.objectStore('chunks');
          if (!chunkStore.indexNames.contains('synced')) {
            chunkStore.createIndex('synced', 'synced');
          }
        }
      },
    });
  }
  return dbPromise;
}

export async function createSession(session: LocalVideoSession): Promise<void> {
  try {
    const db = await getDB();
    await db.put('sessions', session);
    logger.info(`Session created: ${session.sessionId}`);
  } catch (error) {
    logger.error(`Failed to create session ${session.sessionId}:`, error);
    throw new Error('ERR_IDB_WRITE_FAILED');
  }
}

export async function getSession(sessionId: string): Promise<LocalVideoSession | undefined> {
  const db = await getDB();
  return db.get('sessions', sessionId);
}

export async function updateSession(
  sessionId: string,
  updates: Partial<LocalVideoSession>
): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction('sessions', 'readwrite');
    const store = tx.objectStore('sessions');
    const existing = await store.get(sessionId);
    if (!existing) {
      throw new Error(`Session ${sessionId} not found for update`);
    }
    const updated: LocalVideoSession = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await store.put(updated);
    await tx.done;
  } catch (error) {
    logger.error(`Failed to update session ${sessionId}:`, error);
    throw new Error('ERR_IDB_WRITE_FAILED');
  }
}

export async function getAllSessions(): Promise<LocalVideoSession[]> {
  const db = await getDB();
  return db.getAllFromIndex('sessions', 'createdAt');
}

export async function deleteSession(sessionId: string): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction(['sessions', 'chunks'], 'readwrite');
    
    // Delete session entry
    await tx.objectStore('sessions').delete(sessionId);

    // Delete all chunks associated with sessionId
    const chunkStore = tx.objectStore('chunks');
    const index = chunkStore.index('sessionId');
    let cursor = await index.openCursor(IDBKeyRange.only(sessionId));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }

    await tx.done;
    logger.info(`Deleted session ${sessionId} and all its chunks`);
  } catch (error) {
    logger.error(`Failed to delete session ${sessionId}:`, error);
    throw error;
  }
}

export async function saveChunk(chunk: LocalVideoChunk): Promise<void> {
  try {
    const db = await getDB();
    if (!chunk.checksumSha256 && chunk.blob) {
      chunk.checksumSha256 = await computeSha256(chunk.blob);
    }
    if (typeof chunk.synced !== 'boolean') {
      chunk.synced = false;
    }
    await db.put('chunks', chunk);
    logger.info(`Chunk saved for session ${chunk.sessionId}, sequence #${chunk.sequenceNumber}`);
  } catch (error) {
    logger.error(`Failed to save chunk sequence ${chunk.sequenceNumber} for session ${chunk.sessionId}:`, error);
    throw new Error('ERR_IDB_WRITE_FAILED');
  }
}

export async function getChunksForSession(sessionId: string): Promise<LocalVideoChunk[]> {
  const db = await getDB();
  const chunks = await db.getAllFromIndex('chunks', 'sessionId', sessionId);
  return chunks.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

export async function getUnsyncedChunks(sessionId?: string): Promise<LocalVideoChunk[]> {
  const db = await getDB();
  let allChunks: LocalVideoChunk[];
  if (sessionId) {
    allChunks = await db.getAllFromIndex('chunks', 'sessionId', sessionId);
  } else {
    allChunks = await db.getAll('chunks');
  }
  return allChunks
    .filter((c) => !c.synced && Boolean(c.blob))
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}

export async function markChunkSyncedAndPurgeBlob(
  sessionId: string,
  sequenceNumber: number
): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction('chunks', 'readwrite');
    const store = tx.objectStore('chunks');
    const chunk = await store.get([sessionId, sequenceNumber]);
    if (chunk) {
      // 1. Mark synced = true
      chunk.synced = true;
      // 2. Remove heavy blob payload
      chunk.blob = undefined;
      // 3. Save updated record
      await store.put(chunk);
    }
    await tx.done;
    logger.info(`Chunk ${sessionId} #${sequenceNumber} marked synced & blob purged`);
  } catch (err) {
    logger.error(`Failed to purge blob for chunk ${sessionId} #${sequenceNumber}:`, err);
    // Safe purge rule: even if IDB write errors on purge, attempt marking synced
  }
}

export async function getMissingSequences(sessionId: string): Promise<number[]> {
  const chunks = await getChunksForSession(sessionId);
  if (chunks.length === 0) return [];

  const sequences = chunks.map((c) => c.sequenceNumber).sort((a, b) => a - b);
  const maxSeq = sequences[sequences.length - 1];
  const seqSet = new Set(sequences);
  const missing: number[] = [];

  for (let i = 1; i <= maxSeq; i++) {
    if (!seqSet.has(i)) {
      missing.push(i);
    }
  }

  return missing;
}
