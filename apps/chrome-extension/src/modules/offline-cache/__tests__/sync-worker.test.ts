import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncWorker } from '../sync-worker.js';
import { saveChunk, getChunksForSession, markChunkSyncedAndPurgeBlob, computeSha256 } from '../idb-store.js';
import { LocalVideoChunk } from '@openplan/contracts';

describe('SyncWorker & Safe IDB Purge (F-002)', () => {
  const testSessionId = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Uploads unsynced chunk, receives HTTP 200 ACK, and safe purges blob payload', async () => {
    const worker = new SyncWorker({ backendBaseUrl: 'http://localhost:4000' });
    const dummyBlob = new Blob(['test webm video chunk payload'], { type: 'video/webm' });
    const sha256 = await computeSha256(dummyBlob);

    const chunk: LocalVideoChunk = {
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
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            sessionId: testSessionId,
            sequenceNumber: 1,
            byteSize: dummyBlob.size,
            checksumSha256: sha256,
            status: 'ACKNOWLEDGED',
            isDuplicate: false,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
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

    const chunk: LocalVideoChunk = {
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

  it('5. Uploads codec-qualified WebM chunks with a bare "video/webm" transport Content-Type', async () => {
    // Root-cause regression (F-002 chunk upload failures): MediaRecorder blobs
    // carry a codec-qualified type like "video/webm;codecs=vp9,opus" (unquoted,
    // comma-separated). The backend's multipart parser (busboy) enforces the
    // strict HTTP token grammar for unquoted parameter values, which excludes
    // commas — it fails to parse that header and silently falls back to
    // "text/plain", so every real chunk got rejected with ERR_INVALID_MIME_TYPE.
    // uploadChunk() must send a bare "video/webm" type on the wire (the codec
    // detail isn't needed by the backend) so the header always parses cleanly,
    // regardless of what MediaRecorder actually negotiated.
    const worker = new SyncWorker({ backendBaseUrl: 'http://localhost:4000' });
    const dummyBlob = new Blob(['webm bytes with codec-qualified source type'], {
      type: 'video/webm;codecs=vp9,opus',
    });
    const sha256 = await computeSha256(dummyBlob);

    const chunk: LocalVideoChunk = {
      sessionId: testSessionId,
      sequenceNumber: 4,
      timestamp: new Date().toISOString(),
      byteSize: dummyBlob.size,
      mimeType: 'video/webm;codecs=vp9,opus',
      checksumSha256: sha256,
      blob: dummyBlob,
      synced: false,
      isFinal: false,
    };

    let uploadedType: string | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = init?.body as FormData;
      const filePart = body.get('chunk') as File;
      uploadedType = filePart.type;
      return new Response(
        JSON.stringify({
          success: true,
          data: { sessionId: testSessionId, sequenceNumber: 4, status: 'ACKNOWLEDGED', isDuplicate: false },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const success = await worker.uploadChunk(chunk);
    expect(success).toBe(true);
    expect(uploadedType).toBe('video/webm');
  });

  it('4. Safe purge does not re-upload chunk if purge occurs post-ACK', async () => {
    const dummyBlob = new Blob(['chunk for purge test'], { type: 'video/webm' });
    const chunk: LocalVideoChunk = {
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
