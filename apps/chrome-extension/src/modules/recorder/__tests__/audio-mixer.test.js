import { describe, it, expect } from 'vitest';
import { combineAudioTracks } from '../audio-mixer.js';
function createMockTrack(kind, id) {
    return {
        kind,
        id,
        label: `Mock ${kind} ${id}`,
        enabled: true,
        muted: false,
        stop: () => { },
        addEventListener: () => { },
        removeEventListener: () => { },
        dispatchEvent: () => true,
    };
}
function createMockStream(tracks) {
    return {
        getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
        getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
        getTracks: () => tracks,
        addTrack: (t) => tracks.push(t),
        removeTrack: (t) => {
            const idx = tracks.indexOf(t);
            if (idx !== -1)
                tracks.splice(idx, 1);
        },
    };
}
describe('Audio Mixer Degraded Fallback Logic (audio-mixer.ts)', () => {
    it('handles System Audio present and Mic Stream null (E-02: Mic Permission Denied)', () => {
        const videoTrack = createMockTrack('video', 'v1');
        const systemAudioTrack = createMockTrack('audio', 'sys-audio-1');
        const displayStream = createMockStream([videoTrack, systemAudioTrack]);
        const micStream = null;
        const result = combineAudioTracks(displayStream, micStream);
        expect(result.captureMode).toBe('SCREEN_SYSTEM');
        expect(result.compositeAudioTrack).toBe(systemAudioTrack);
        expect(displayStream.getAudioTracks().length).toBe(1);
    });
    it('handles System Audio absent and Mic Stream present (E-03: System Audio Unchecked)', () => {
        const videoTrack = createMockTrack('video', 'v1');
        const micAudioTrack = createMockTrack('audio', 'mic-audio-1');
        const displayStream = createMockStream([videoTrack]);
        const micStream = createMockStream([micAudioTrack]);
        const result = combineAudioTracks(displayStream, micStream);
        expect(result.captureMode).toBe('SCREEN_MIC');
        expect(result.compositeAudioTrack).toBe(micAudioTrack);
    });
    it('handles Both System Audio and Mic Stream absent (E-04: Video-Only)', () => {
        const videoTrack = createMockTrack('video', 'v1');
        const displayStream = createMockStream([videoTrack]);
        const micStream = createMockStream([]);
        const result = combineAudioTracks(displayStream, micStream);
        expect(result.captureMode).toBe('SCREEN_ONLY');
        expect(result.compositeAudioTrack).toBeNull();
    });
    it('detects both System Audio and Mic Stream present (SCREEN_SYSTEM_MIC)', () => {
        const videoTrack = createMockTrack('video', 'v1');
        const systemAudioTrack = createMockTrack('audio', 'sys-1');
        const micAudioTrack = createMockTrack('audio', 'mic-1');
        const displayStream = createMockStream([videoTrack, systemAudioTrack]);
        const micStream = createMockStream([micAudioTrack]);
        const result = combineAudioTracks(displayStream, micStream);
        expect(result.captureMode).toBe('SCREEN_SYSTEM_MIC');
        expect(result.compositeAudioTrack).toBeDefined();
    });
});
