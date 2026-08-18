import { logger } from '@openplan/core';
/**
 * Combines system audio track (from displayStream) and microphone audio track (from micStream)
 * into a single composite audio track using WebAudio API.
 *
 * Implements degraded fallbacks per FEATURE-SPEC-F-001 Section 6:
 * - E-02: Mic denied -> fallback to System Audio (SCREEN_SYSTEM)
 * - E-03: System Audio un-checked -> fallback to Microphone (SCREEN_MIC)
 * - E-04: Neither available -> video-only (SCREEN_ONLY)
 * - NEVER synthesizes fake silent audio tracks.
 */
export function combineAudioTracks(displayStream, micStream) {
    const systemAudioTracks = displayStream.getAudioTracks();
    const hasSystemAudio = systemAudioTracks.length > 0;
    const micAudioTracks = micStream ? micStream.getAudioTracks() : [];
    const hasMicAudio = micAudioTracks.length > 0;
    // Case 1: Both system audio and microphone are present -> Mix via WebAudio API
    if (hasSystemAudio && hasMicAudio) {
        try {
            const AudioContextClass = window.AudioContext ||
                window.webkitAudioContext;
            if (AudioContextClass) {
                const audioContext = new AudioContextClass();
                const destination = audioContext.createMediaStreamDestination();
                const systemSource = audioContext.createMediaStreamSource(new MediaStream([systemAudioTracks[0]]));
                const micSource = audioContext.createMediaStreamSource(new MediaStream([micAudioTracks[0]]));
                systemSource.connect(destination);
                micSource.connect(destination);
                const compositeTrack = destination.stream.getAudioTracks()[0] || null;
                const cleanup = () => {
                    try {
                        systemSource.disconnect();
                        micSource.disconnect();
                        if (audioContext.state !== 'closed') {
                            audioContext.close();
                        }
                    }
                    catch (err) {
                        logger.warn('Error during AudioContext cleanup:', err);
                    }
                };
                return {
                    compositeAudioTrack: compositeTrack,
                    captureMode: 'SCREEN_SYSTEM_MIC',
                    cleanup,
                };
            }
        }
        catch (err) {
            logger.warn('AudioContext initialization failed, falling back to system audio track:', err);
        }
        // Fallback if AudioContext is unsupported or fails
        return {
            compositeAudioTrack: systemAudioTracks[0],
            captureMode: 'SCREEN_SYSTEM_MIC',
            cleanup: () => { },
        };
    }
    // Case 2: System audio present, mic absent -> SCREEN_SYSTEM
    if (hasSystemAudio) {
        return {
            compositeAudioTrack: systemAudioTracks[0],
            captureMode: 'SCREEN_SYSTEM',
            cleanup: () => { },
        };
    }
    // Case 3: Mic present, system audio absent -> SCREEN_MIC
    if (hasMicAudio) {
        return {
            compositeAudioTrack: micAudioTracks[0],
            captureMode: 'SCREEN_MIC',
            cleanup: () => { },
        };
    }
    // Case 4: Neither present -> Video-only (SCREEN_ONLY). Zero fake audio tracks.
    return {
        compositeAudioTrack: null,
        captureMode: 'SCREEN_ONLY',
        cleanup: () => { },
    };
}
