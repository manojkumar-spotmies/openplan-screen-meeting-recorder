import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { RecorderService } from '../recorder.service.js';
import { getChunksForSession, getSession } from '../../offline-cache/idb-store.js';
function createMockTrack(kind, id) {
    return {
        kind,
        id,
        label: `Mock ${kind} ${id}`,
        enabled: true,
        muted: false,
        stop: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: () => true,
    };
}
class MockMediaStream {
    tracks = [];
    constructor(tracks) {
        if (Array.isArray(tracks)) {
            this.tracks = [...tracks];
        }
        else if (tracks && typeof tracks.getTracks === 'function') {
            this.tracks = tracks.getTracks();
        }
    }
    getAudioTracks() {
        return this.tracks.filter((t) => t.kind === 'audio');
    }
    getVideoTracks() {
        return this.tracks.filter((t) => t.kind === 'video');
    }
    getTracks() {
        return [...this.tracks];
    }
    addTrack(track) {
        this.tracks.push(track);
    }
    removeTrack(track) {
        const idx = this.tracks.indexOf(track);
        if (idx !== -1) {
            this.tracks.splice(idx, 1);
        }
    }
}
globalThis.MediaStream = MockMediaStream;
function createMockStream(tracks) {
    return new MockMediaStream(tracks);
}
// Mock global MediaRecorder for test environment
class MockMediaRecorder {
    stream;
    options;
    state = 'inactive';
    mimeType = 'video/webm;codecs=vp8,opus';
    ondataavailable = null;
    onstop = null;
    onerror = null;
    static isTypeSupported = () => true;
    constructor(stream, options) {
        this.stream = stream;
        this.options = options;
    }
    start(timeslice) {
        this.state = 'recording';
    }
    stop() {
        this.state = 'inactive';
        if (this.onstop) {
            this.onstop();
        }
    }
    // Helper for tests to simulate chunk emission
    async emitChunk(dataStr) {
        if (this.ondataavailable) {
            const blob = new Blob([dataStr], { type: 'video/webm' });
            await this.ondataavailable({ data: blob });
        }
    }
}
globalThis.MediaRecorder = MockMediaRecorder;
describe('RecorderService (recorder.service.ts)', () => {
    let recorderService;
    beforeEach(() => {
        recorderService = new RecorderService();
    });
    it('starts a recording session and emits 1-indexed chunk sequences to IndexedDB', async () => {
        const videoTrack = createMockTrack('video', 'v1');
        const displayStream = createMockStream([videoTrack]);
        const session = await recorderService.startRecording({
            sessionId: 'seq-test-session',
            title: 'Sequence Test',
            displayStream,
        });
        expect(session.sessionId).toBe('seq-test-session');
        expect(session.status).toBe('RECORDING');
        expect(recorderService.getSequenceNumber()).toBe(1);
        // Get active mock MediaRecorder instance
        const mockRecorder = recorderService.mediaRecorder;
        expect(mockRecorder).toBeDefined();
        // Emit 3 consecutive chunks
        await mockRecorder.emitChunk('chunk-data-1');
        await mockRecorder.emitChunk('chunk-data-2');
        await mockRecorder.emitChunk('chunk-data-3');
        // Sequence counter should increment to 4
        expect(recorderService.getSequenceNumber()).toBe(4);
        // Verify stored chunks in IndexedDB
        const chunks = await getChunksForSession('seq-test-session');
        expect(chunks.length).toBe(3);
        expect(chunks[0].sequenceNumber).toBe(1);
        expect(chunks[1].sequenceNumber).toBe(2);
        expect(chunks[2].sequenceNumber).toBe(3);
        expect(chunks[0].isFinal).toBe(false);
    });
    it('handles stopRecording gracefully and marks the session as STOPPED', async () => {
        const videoTrack = createMockTrack('video', 'v1');
        const displayStream = createMockStream([videoTrack]);
        await recorderService.startRecording({
            sessionId: 'stop-test-session',
            title: 'Stop Test',
            displayStream,
        });
        const mockRecorder = recorderService.mediaRecorder;
        await mockRecorder.emitChunk('chunk-data-1');
        const stopPromise = recorderService.stopRecording('USER_ACTION');
        // Emit final partial chunk
        await mockRecorder.emitChunk('final-chunk-data');
        const stoppedSession = await stopPromise;
        expect(stoppedSession.status).toBe('STOPPED');
        expect(stoppedSession.totalChunks).toBe(2);
        const dbSession = await getSession('stop-test-session');
        expect(dbSession?.status).toBe('STOPPED');
        const chunks = await getChunksForSession('stop-test-session');
        expect(chunks.length).toBe(2);
        expect(chunks[1].isFinal).toBe(true);
        expect(videoTrack.stop).toHaveBeenCalled();
    });
    it('combines system audio and microphone into SCREEN_SYSTEM_MIC and cleans up all tracks on stop', async () => {
        const videoTrack = createMockTrack('video', 'v-comb');
        const sysAudioTrack = createMockTrack('audio', 'sys-comb');
        const micAudioTrack = createMockTrack('audio', 'mic-comb');
        const displayStream = createMockStream([videoTrack, sysAudioTrack]);
        const micStream = createMockStream([micAudioTrack]);
        const session = await recorderService.startRecording({
            sessionId: 'comb-test-session',
            title: 'Combined Audio Test',
            displayStream,
            micStream,
        });
        expect(session.captureMode).toBe('SCREEN_SYSTEM_MIC');
        const mockRecorder = recorderService.mediaRecorder;
        await mockRecorder.emitChunk('audio-data');
        const stopPromise = recorderService.stopRecording('USER_ACTION');
        await mockRecorder.emitChunk('final-audio-data');
        const stoppedSession = await stopPromise;
        expect(stoppedSession.status).toBe('STOPPED');
        expect(videoTrack.stop).toHaveBeenCalled();
        expect(sysAudioTrack.stop).toHaveBeenCalled();
        expect(micAudioTrack.stop).toHaveBeenCalled();
    });
    it('falls back to SCREEN_SYSTEM when microphone stream is null (mic denied)', async () => {
        const videoTrack = createMockTrack('video', 'v-fb');
        const sysAudioTrack = createMockTrack('audio', 'sys-fb');
        const displayStream = createMockStream([videoTrack, sysAudioTrack]);
        const session = await recorderService.startRecording({
            sessionId: 'fallback-test-session',
            title: 'Fallback Test',
            displayStream,
            micStream: null,
        });
        expect(session.captureMode).toBe('SCREEN_SYSTEM');
    });
});
