import { CaptureMode } from '@openplan/contracts';
export interface AudioMixerResult {
    compositeAudioTrack: MediaStreamTrack | null;
    captureMode: CaptureMode;
    cleanup: () => void;
}
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
export declare function combineAudioTracks(displayStream: MediaStream, micStream: MediaStream | null): AudioMixerResult;
