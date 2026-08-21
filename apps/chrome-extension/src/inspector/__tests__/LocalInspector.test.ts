import { describe, it, expect, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { concatenateChunksToBlob, fetchBackendVideoBlob } from '../LocalInspector.js';
import { LocalVideoChunk } from '@openplan/contracts';
import {
  createSession,
  saveChunk,
  getMissingSequences,
} from '../../modules/offline-cache/idb-store.js';

describe('LocalInspector (LocalInspector.tsx)', () => {
  it('concatenates stored WebM chunks into a single unified Blob matching total byte size (Section 9.1)', () => {
    const chunk1: LocalVideoChunk = {
      sessionId: 'concat-session',
      sequenceNumber: 1,
      timestamp: new Date().toISOString(),
      byteSize: 500 * 1024,
      mimeType: 'video/webm;codecs=vp8,opus',
      blob: new Blob([new Uint8Array(500 * 1024)], { type: 'video/webm' }),
      isFinal: false,
    };

    const chunk2: LocalVideoChunk = {
      sessionId: 'concat-session',
      sequenceNumber: 2,
      timestamp: new Date().toISOString(),
      byteSize: 500 * 1024,
      mimeType: 'video/webm;codecs=vp8,opus',
      blob: new Blob([new Uint8Array(500 * 1024)], { type: 'video/webm' }),
      isFinal: false,
    };

    const chunk3: LocalVideoChunk = {
      sessionId: 'concat-session',
      sequenceNumber: 3,
      timestamp: new Date().toISOString(),
      byteSize: 120 * 1024,
      mimeType: 'video/webm;codecs=vp8,opus',
      blob: new Blob([new Uint8Array(120 * 1024)], { type: 'video/webm' }),
      isFinal: true,
    };

    // Pass chunks out of order to verify 1-indexed sequence sorting before concatenation
    const unifiedBlob = concatenateChunksToBlob([chunk3, chunk1, chunk2]);

    expect(unifiedBlob).toBeDefined();
    expect(unifiedBlob.type).toBe('video/webm;codecs=vp8,opus');
    expect(unifiedBlob.size).toBe((500 + 500 + 120) * 1024); // 1,120 KB = 1,146,880 bytes
  });

  it('detects missing sequence gaps in IndexedDB session manifest (Edge Case E-08)', async () => {
    const sessionId = 'gap-test-session';

    await createSession({
      sessionId,
      title: 'Gap Test',
      status: 'STOPPED',
      captureMode: 'SCREEN_SYSTEM_MIC',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalChunks: 4,
    });

    await saveChunk({
      sessionId,
      sequenceNumber: 1,
      timestamp: new Date().toISOString(),
      byteSize: 100,
      mimeType: 'video/webm',
      blob: new Blob(['c1']),
      isFinal: false,
    });

    await saveChunk({
      sessionId,
      sequenceNumber: 2,
      timestamp: new Date().toISOString(),
      byteSize: 100,
      mimeType: 'video/webm',
      blob: new Blob(['c2']),
      isFinal: false,
    });

    // Sequence #3 is intentionally omitted

    await saveChunk({
      sessionId,
      sequenceNumber: 4,
      timestamp: new Date().toISOString(),
      byteSize: 100,
      mimeType: 'video/webm',
      blob: new Blob(['c4']),
      isFinal: true,
    });

    const missing = await getMissingSequences(sessionId);
    expect(missing).toEqual([3]);
  });

  describe('fetchBackendVideoBlob (backend final-video preview, fixes purged-chunk playback)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('returns the backend video blob when the final video is available (HTTP 200)', async () => {
      const videoBytes = new Uint8Array([1, 2, 3, 4]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          blob: async () => new Blob([videoBytes], { type: 'video/webm' }),
        }))
      );

      const result = await fetchBackendVideoBlob('some-session-id');
      expect(result).not.toBeNull();
      expect(result!.size).toBe(4);
    });

    it('returns null (not a throw) when the backend has no video yet (e.g. 404/409)', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: false }))
      );

      const result = await fetchBackendVideoBlob('some-session-id');
      expect(result).toBeNull();
    });

    it('returns null (not a throw) when the backend is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('network error');
        })
      );

      const result = await fetchBackendVideoBlob('some-session-id');
      expect(result).toBeNull();
    });

    it('treats an empty response body as unavailable rather than a playable-but-empty video', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          blob: async () => new Blob([], { type: 'video/webm' }),
        }))
      );

      const result = await fetchBackendVideoBlob('some-session-id');
      expect(result).toBeNull();
    });
  });
});
