import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { createSession, getSession, updateSession, deleteSession, saveChunk, getChunksForSession, getMissingSequences, } from '../idb-store.js';
describe('idb-store', () => {
    const sampleSession = {
        sessionId: 'test-session-123',
        title: 'Test Recording',
        sourceTabUrl: 'https://meet.google.com/abc-defg-hij',
        status: 'RECORDING',
        captureMode: 'SCREEN_SYSTEM_MIC',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        totalChunks: 0,
    };
    it('creates and retrieves a session', async () => {
        await createSession(sampleSession);
        const retrieved = await getSession('test-session-123');
        expect(retrieved).toBeDefined();
        expect(retrieved?.sessionId).toEqual('test-session-123');
        expect(retrieved?.title).toEqual('Test Recording');
    });
    it('updates an existing session', async () => {
        await createSession(sampleSession);
        await updateSession('test-session-123', {
            status: 'STOPPED',
            totalChunks: 3,
            durationSeconds: 15,
        });
        const updated = await getSession('test-session-123');
        expect(updated?.status).toEqual('STOPPED');
        expect(updated?.totalChunks).toEqual(3);
        expect(updated?.durationSeconds).toEqual(15);
    });
    it('saves chunks and retrieves them sorted by 1-indexed sequence number', async () => {
        await createSession(sampleSession);
        const chunk2 = {
            sessionId: 'test-session-123',
            sequenceNumber: 2,
            timestamp: new Date().toISOString(),
            byteSize: 1024,
            mimeType: 'video/webm;codecs=vp8,opus',
            blob: new Blob(['chunk2'], { type: 'video/webm' }),
            isFinal: false,
        };
        const chunk1 = {
            sessionId: 'test-session-123',
            sequenceNumber: 1,
            timestamp: new Date().toISOString(),
            byteSize: 1024,
            mimeType: 'video/webm;codecs=vp8,opus',
            blob: new Blob(['chunk1'], { type: 'video/webm' }),
            isFinal: false,
        };
        // Save out of order to verify sorting
        await saveChunk(chunk2);
        await saveChunk(chunk1);
        const chunks = await getChunksForSession('test-session-123');
        expect(chunks.length).toEqual(2);
        expect(chunks[0].sequenceNumber).toEqual(1);
        expect(chunks[1].sequenceNumber).toEqual(2);
    });
    it('detects missing sequences correctly', async () => {
        const sessionId = 'gap-session';
        await createSession({ ...sampleSession, sessionId });
        const chunk1 = {
            sessionId,
            sequenceNumber: 1,
            timestamp: new Date().toISOString(),
            byteSize: 500,
            mimeType: 'video/webm',
            blob: new Blob(['c1']),
            isFinal: false,
        };
        const chunk3 = {
            sessionId,
            sequenceNumber: 3,
            timestamp: new Date().toISOString(),
            byteSize: 500,
            mimeType: 'video/webm',
            blob: new Blob(['c3']),
            isFinal: true,
        };
        await saveChunk(chunk1);
        await saveChunk(chunk3);
        const missing = await getMissingSequences(sessionId);
        expect(missing).toEqual([2]);
    });
    it('deletes session and associated chunks', async () => {
        const sessionId = 'delete-session';
        await createSession({ ...sampleSession, sessionId });
        await saveChunk({
            sessionId,
            sequenceNumber: 1,
            timestamp: new Date().toISOString(),
            byteSize: 500,
            mimeType: 'video/webm',
            blob: new Blob(['c1']),
            isFinal: true,
        });
        await deleteSession(sessionId);
        const session = await getSession(sessionId);
        const chunks = await getChunksForSession(sessionId);
        expect(session).toBeUndefined();
        expect(chunks.length).toEqual(0);
    });
});
