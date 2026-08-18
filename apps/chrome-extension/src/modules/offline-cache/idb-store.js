import { openDB } from 'idb';
import { logger } from '@openplan/core';
export const DB_NAME = 'openplan_recorder_db';
export const DB_VERSION = 1;
let dbPromise = null;
export function getDB() {
    if (!dbPromise) {
        dbPromise = openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
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
                }
            },
        });
    }
    return dbPromise;
}
export async function createSession(session) {
    try {
        const db = await getDB();
        await db.put('sessions', session);
        logger.info(`Session created: ${session.sessionId}`);
    }
    catch (error) {
        logger.error(`Failed to create session ${session.sessionId}:`, error);
        throw new Error('ERR_IDB_WRITE_FAILED');
    }
}
export async function getSession(sessionId) {
    const db = await getDB();
    return db.get('sessions', sessionId);
}
export async function updateSession(sessionId, updates) {
    try {
        const db = await getDB();
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        const existing = await store.get(sessionId);
        if (!existing) {
            throw new Error(`Session ${sessionId} not found for update`);
        }
        const updated = {
            ...existing,
            ...updates,
            updatedAt: new Date().toISOString(),
        };
        await store.put(updated);
        await tx.done;
    }
    catch (error) {
        logger.error(`Failed to update session ${sessionId}:`, error);
        throw new Error('ERR_IDB_WRITE_FAILED');
    }
}
export async function getAllSessions() {
    const db = await getDB();
    return db.getAllFromIndex('sessions', 'createdAt');
}
export async function deleteSession(sessionId) {
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
    }
    catch (error) {
        logger.error(`Failed to delete session ${sessionId}:`, error);
        throw error;
    }
}
export async function saveChunk(chunk) {
    try {
        const db = await getDB();
        await db.put('chunks', chunk);
        logger.info(`Chunk saved for session ${chunk.sessionId}, sequence #${chunk.sequenceNumber}`);
    }
    catch (error) {
        logger.error(`Failed to save chunk sequence ${chunk.sequenceNumber} for session ${chunk.sessionId}:`, error);
        throw new Error('ERR_IDB_WRITE_FAILED');
    }
}
export async function getChunksForSession(sessionId) {
    const db = await getDB();
    const chunks = await db.getAllFromIndex('chunks', 'sessionId', sessionId);
    return chunks.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
}
export async function getMissingSequences(sessionId) {
    const chunks = await getChunksForSession(sessionId);
    if (chunks.length === 0)
        return [];
    const sequences = chunks.map((c) => c.sequenceNumber).sort((a, b) => a - b);
    const maxSeq = sequences[sequences.length - 1];
    const seqSet = new Set(sequences);
    const missing = [];
    for (let i = 1; i <= maxSeq; i++) {
        if (!seqSet.has(i)) {
            missing.push(i);
        }
    }
    return missing;
}
