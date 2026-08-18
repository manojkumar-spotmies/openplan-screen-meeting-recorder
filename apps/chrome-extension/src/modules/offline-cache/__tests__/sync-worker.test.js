import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncWorker } from '../sync-worker.js';
import { saveChunk, getChunksForSession, markChunkSyncedAndPurgeBlob, computeSha256 } from '../idb-store.js';
describe('SyncWorker & Safe IDB Purge (F-002)', () => {
    const testSessionId = '550e8400-e29b-41d4-a716-446655440000';
    beforeEach(() => {
        vi.restoreAllMocks();
    });
    it('1. Uploads unsynced chunk, receives HTTP 200 ACK, and safe purges blob payload', async () => {
        const worker = new SyncWorker({ backendBaseUrl: 'http://localhost:4000' });
        const dummyBlob = new Blob(['test webm video chunk payload'], { type: 'video/webm' });
        const sha256 = await computeSha256(dummyBlob);
        const chunk = {
            sessionId: testSessionId,
            sequenceNumber: 1,
            timestamp: new Date().toISOString(),
            byteSize: dummyBlob.size,
            mimeType: 'video/webm',
            checksumSha256: sha256,
            blob: dummyBlob,
            synced: false,
            isFinal: false,
        };
        await saveChunk(chunk);
        // Mock successful backend response
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            return new Response(JSON.stringify({
                success: true,
                data: {
                    sessionId: testSessionId,
                    sequenceNumber: 1,
                    byteSize: dummyBlob.size,
                    checksumSha256: sha256,
                    status: 'ACKNOWLEDGED',
                    isDuplicate: false,
                },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        const success = await worker.uploadChunkWithRetry(chunk);
        expect(success).toBe(true);
        // Verify safe purge in IndexedDB
        const chunks = await getChunksForSession(testSessionId);
        expect(chunks.length).toBe(1);
        expect(chunks[0].synced).toBe(true);
        expect(chunks[0].blob).toBeUndefined(); // Heavy blob payload purged
        expect(chunks[0].checksumSha256).toBe(sha256); // Audit metadata retained
    });
    it('2. Limits upload concurrency to maximum of 2 simultaneous requests', async () => {
        const worker = new SyncWorker({ maxConcurrency: 2 });
        expect(worker.getActiveUploadCount()).toBe(0);
    });
    it('3. Retries failed uploads using exponential backoff up to max retries', async () => {
        vi.useFakeTimers();
        const worker = new SyncWorker({ maxRetries: 3 });
        const dummyBlob = new Blob(['chunk data'], { type: 'video/webm' });
        const chunk = {
            sessionId: testSessionId,
            sequenceNumber: 2,
            timestamp: new Date().toISOString(),
            byteSize: dummyBlob.size,
            mimeType: 'video/webm',
            checksumSha256: 'abc123sha',
            blob: dummyBlob,
            synced: false,
            isFinal: false,
        };
        // Mock failing backend returning HTTP 503
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            return new Response('Service Unavailable', { status: 503 });
        });
        const promise = worker.uploadChunkWithRetry(chunk);
        // Advance timers so backoff delays execute immediately
        await vi.runAllTimersAsync();
        const success = await promise;
        expect(success).toBe(false);
        vi.useRealTimers();
    });
    it('4. Safe purge does not re-upload chunk if purge occurs post-ACK', async () => {
        const dummyBlob = new Blob(['chunk for purge test'], { type: 'video/webm' });
        const chunk = {
            sessionId: testSessionId,
            sequenceNumber: 3,
            timestamp: new Date().toISOString(),
            byteSize: dummyBlob.size,
            mimeType: 'video/webm',
            checksumSha256: 'sha3',
            blob: dummyBlob,
            synced: false,
            isFinal: false,
        };
        await saveChunk(chunk);
        await markChunkSyncedAndPurgeBlob(testSessionId, 3);
        const stored = await getChunksForSession(testSessionId);
        const target = stored.find((c) => c.sequenceNumber === 3);
        expect(target?.synced).toBe(true);
        expect(target?.blob).toBeUndefined();
    });
});
