import { LocalVideoSession, LocalVideoChunk } from '@openplan/contracts';
import { logger } from '@openplan/core';
import { createSession, updateSession, saveChunk } from '../offline-cache/idb-store.js';
import { combineAudioTracks, AudioMixerResult } from './audio-mixer.js';

export interface StartRecordingOptions {
  sessionId?: string;
  title: string;
  sourceTabUrl?: string;
  displayStream: MediaStream;
  micStream?: MediaStream | null;
  timesliceMs?: number; // Defaults to 5000 (5 seconds) per specification
}

export type StopReason = 'USER_ACTION' | 'TAB_CLOSED' | 'NATIVE_STOP_BAR';

export interface RecordingControlState {
  sessionId: string;
  status: LocalVideoSession['status'];
  isPaused: boolean;
  microphoneEnabled: boolean;
  systemAudioEnabled: boolean;
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
}

export class RecorderService {
  private mediaRecorder: MediaRecorder | null = null;
  private currentSession: LocalVideoSession | null = null;
  private sequenceNumber: number = 1;
  private startTime: number = 0;
  private accumulatedBytes: number = 0;
  private mixerResult: AudioMixerResult | null = null;
  private activeCompositeStream: MediaStream | null = null;
  private displayStreamRef: MediaStream | null = null;
  private micStreamRef: MediaStream | null = null;
  private isStopping: boolean = false;
  private stopPromiseResolver: ((session: LocalVideoSession) => void) | null = null;
  private microphoneEnabled: boolean = true;
  private systemAudioEnabled: boolean = true;

  public async startRecording(options: StartRecordingOptions): Promise<LocalVideoSession> {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      throw new Error('Recording session already active');
    }

    const {
      sessionId = crypto.randomUUID(),
      title,
      sourceTabUrl,
      displayStream,
      micStream = null,
      timesliceMs = 5000,
    } = options;

    this.displayStreamRef = displayStream;
    this.micStreamRef = micStream;

    // Combine audio tracks using AudioMixer
    this.mixerResult = combineAudioTracks(displayStream, micStream);

    // Build composite MediaStream
    const compositeTracks: MediaStreamTrack[] = [...displayStream.getVideoTracks()];
    if (this.mixerResult.compositeAudioTrack) {
      compositeTracks.push(this.mixerResult.compositeAudioTrack);
    }
    this.activeCompositeStream = new MediaStream(compositeTracks);

    // Initial session entity setup
    const hasMicrophone = Boolean(micStream && micStream.getAudioTracks().length > 0);
    const hasSystemAudio = displayStream.getAudioTracks().length > 0;
    this.microphoneEnabled = true;
    this.systemAudioEnabled = true;

    const now = new Date().toISOString();
    this.currentSession = {
      sessionId,
      title,
      sourceTabUrl,
      status: 'RECORDING',
      captureMode: this.mixerResult.captureMode,
      createdAt: now,
      updatedAt: now,
      totalChunks: 0,
      fileSizeBytes: 0,
      isPaused: false,
      microphoneEnabled: true,
      systemAudioEnabled: true,
      hasMicrophone,
      hasSystemAudio,
    };

    // Save session in IndexedDB
    await createSession(this.currentSession);

    // Initialize counters
    this.sequenceNumber = 1;
    this.accumulatedBytes = 0;
    this.startTime = Date.now();
    this.isStopping = false;

    // Monitor native stop bar ("Stop sharing")
    const videoTracks = displayStream.getVideoTracks();
    if (videoTracks.length > 0) {
      videoTracks[0].onended = () => {
        logger.info('Native Chrome stop bar clicked or video track ended');
        if (this.currentSession && this.currentSession.status === 'RECORDING') {
          this.stopRecording('NATIVE_STOP_BAR').catch((err) => {
            logger.error('Error auto-stopping on native stop bar:', err);
          });
        }
      };
    }

    // Determine supported WebM mimeType
    const mimeType = this.selectMimeType();

    // Create MediaRecorder instance
    this.mediaRecorder = new MediaRecorder(
      this.activeCompositeStream,
      mimeType ? { mimeType } : undefined
    );

    // Handle chunk emission (5s timeslice)
    this.mediaRecorder.ondataavailable = async (event: BlobEvent) => {
      await this.handleDataAvailable(event);
    };

    // Handle recorder stop
    this.mediaRecorder.onstop = async () => {
      await this.handleStop();
    };

    // Handle recorder errors
    this.mediaRecorder.onerror = async (event: Event) => {
      logger.error('MediaRecorder error event:', event);
      await this.handleError('MediaRecorder execution error');
    };

    // Start MediaRecorder with 5s timeslice
    this.mediaRecorder.start(timesliceMs);
    logger.info(
      `MediaRecorder started for session ${sessionId} (timeslice=${timesliceMs}ms, mode=${this.mixerResult.captureMode})`
    );

    return this.currentSession;
  }

  public async stopRecording(reason: StopReason = 'USER_ACTION'): Promise<LocalVideoSession> {
    if (!this.currentSession) {
      throw new Error('No active recording session to stop');
    }

    // Already fully stopped by a concurrent trigger (e.g. the native "Stop sharing"
    // bar's track.onended racing the Meet call-end detector's STOP_RECORDING message)
    // — mediaRecorder/isStopping are already reset by resetState(), so return the
    // finalized session idempotently instead of throwing.
    if (this.currentSession.status === 'STOPPED') {
      return this.currentSession;
    }

    if (!this.mediaRecorder) {
      throw new Error('No active recording session to stop');
    }

    this.isStopping = true;
    logger.info(`Stopping recording session ${this.currentSession.sessionId} (reason: ${reason})`);

    // Transition state RECORDING -> STOPPING
    this.currentSession.status = 'STOPPING';
    await updateSession(this.currentSession.sessionId, { status: 'STOPPING' });

    return new Promise<LocalVideoSession>((resolve) => {
      this.stopPromiseResolver = resolve;

      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        // Calling stop() triggers final ondataavailable event followed by onstop
        this.mediaRecorder.stop();
      } else {
        this.handleStop().catch((err) => logger.error('Error handling stop:', err));
      }
    });
  }

  public getCurrentSession(): LocalVideoSession | null {
    return this.currentSession;
  }

  public getSequenceNumber(): number {
    return this.sequenceNumber;
  }

  public async pauseRecording(): Promise<RecordingControlState> {
    if (!this.mediaRecorder || !this.currentSession) {
      throw new Error('No active recording session to pause');
    }
    if (this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
      this.currentSession.isPaused = true;
      await updateSession(this.currentSession.sessionId, { isPaused: true });
      logger.info(`Recording session ${this.currentSession.sessionId} paused`);
    }
    return this.getControlState();
  }

  public async resumeRecording(): Promise<RecordingControlState> {
    if (!this.mediaRecorder || !this.currentSession) {
      throw new Error('No active recording session to resume');
    }
    if (this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
      this.currentSession.isPaused = false;
      await updateSession(this.currentSession.sessionId, { isPaused: false });
      logger.info(`Recording session ${this.currentSession.sessionId} resumed`);
    }
    return this.getControlState();
  }

  public async setMicrophoneEnabled(enabled: boolean): Promise<RecordingControlState> {
    if (!this.currentSession) {
      throw new Error('No active recording session');
    }
    const micTracks = this.micStreamRef ? this.micStreamRef.getAudioTracks() : [];
    if (micTracks.length === 0) {
      throw new Error('No microphone track available for this recording');
    }
    // Disabling (not stopping) the track keeps the same recording stream/graph intact;
    // a disabled MediaStreamTrack outputs silence rather than being removed.
    micTracks.forEach((track) => {
      track.enabled = enabled;
    });
    this.microphoneEnabled = enabled;
    this.currentSession.microphoneEnabled = enabled;
    await updateSession(this.currentSession.sessionId, { microphoneEnabled: enabled });
    logger.info(`Microphone ${enabled ? 'enabled' : 'disabled'} for session ${this.currentSession.sessionId}`);
    return this.getControlState();
  }

  public async setSystemAudioEnabled(enabled: boolean): Promise<RecordingControlState> {
    if (!this.currentSession) {
      throw new Error('No active recording session');
    }
    const systemAudioTracks = this.displayStreamRef ? this.displayStreamRef.getAudioTracks() : [];
    if (systemAudioTracks.length === 0) {
      throw new Error('No system audio track available for this recording');
    }
    systemAudioTracks.forEach((track) => {
      track.enabled = enabled;
    });
    this.systemAudioEnabled = enabled;
    this.currentSession.systemAudioEnabled = enabled;
    await updateSession(this.currentSession.sessionId, { systemAudioEnabled: enabled });
    logger.info(`System audio ${enabled ? 'enabled' : 'disabled'} for session ${this.currentSession.sessionId}`);
    return this.getControlState();
  }

  public getControlState(): RecordingControlState {
    if (!this.currentSession || !this.mediaRecorder) {
      throw new Error('No active recording session');
    }
    return {
      sessionId: this.currentSession.sessionId,
      status: this.currentSession.status,
      isPaused: this.mediaRecorder.state === 'paused',
      microphoneEnabled: this.microphoneEnabled,
      systemAudioEnabled: this.systemAudioEnabled,
      hasMicrophone: Boolean(this.currentSession.hasMicrophone),
      hasSystemAudio: Boolean(this.currentSession.hasSystemAudio),
    };
  }

  private async handleDataAvailable(event: BlobEvent): Promise<void> {
    if (!event.data || event.data.size === 0 || !this.currentSession) {
      return;
    }

    const currentSeq = this.sequenceNumber;
    const isFinalChunk = this.isStopping || (this.mediaRecorder && this.mediaRecorder.state === 'inactive');

    // Create 1-indexed LocalVideoChunk
    const chunk: LocalVideoChunk = {
      sessionId: this.currentSession.sessionId,
      sequenceNumber: currentSeq,
      timestamp: new Date().toISOString(),
      byteSize: event.data.size,
      mimeType: event.data.type || this.mediaRecorder?.mimeType || 'video/webm',
      blob: event.data, // Passed directly to IDB without keeping in class array
      isFinal: Boolean(isFinalChunk),
    };

    try {
      // Save chunk to IndexedDB
      await saveChunk(chunk);

      // Increment 1-indexed sequence counter
      this.sequenceNumber += 1;
      this.accumulatedBytes += event.data.size;

      // Update session statistics in IndexedDB
      await updateSession(this.currentSession.sessionId, {
        totalChunks: currentSeq,
        fileSizeBytes: this.accumulatedBytes,
        updatedAt: new Date().toISOString(),
      });

      this.currentSession.totalChunks = currentSeq;
      this.currentSession.fileSizeBytes = this.accumulatedBytes;

      logger.info(
        `Chunk #${currentSeq} (${event.data.size} bytes) persisted for session ${this.currentSession.sessionId}`
      );
    } catch (err) {
      logger.error(`Failed to persist chunk #${currentSeq}:`, err);
      await this.handleError('ERR_IDB_WRITE_FAILED');
    }
  }

  private async handleStop(): Promise<void> {
    if (!this.currentSession) return;

    try {
      // State transition STOPPING -> FINALIZING
      this.currentSession.status = 'FINALIZING';
      await updateSession(this.currentSession.sessionId, { status: 'FINALIZING' });

      // Stop and release all tracks
      this.stopAllTracks();

      // Clean up WebAudio mixer resources
      if (this.mixerResult) {
        this.mixerResult.cleanup();
        this.mixerResult = null;
      }

      // Calculate final duration
      const durationSeconds = Math.max(0, (Date.now() - this.startTime) / 1000);

      // State transition FINALIZING -> STOPPED
      const now = new Date().toISOString();
      this.currentSession.status = 'STOPPED';
      this.currentSession.durationSeconds = durationSeconds;
      this.currentSession.updatedAt = now;

      await updateSession(this.currentSession.sessionId, {
        status: 'STOPPED',
        durationSeconds,
        updatedAt: now,
      });

      logger.info(
        `Session ${this.currentSession.sessionId} stopped successfully. Total Chunks: ${this.currentSession.totalChunks}, Duration: ${durationSeconds.toFixed(1)}s`
      );

      const finalSession = { ...this.currentSession };
      this.resetState();

      if (this.stopPromiseResolver) {
        this.stopPromiseResolver(finalSession);
        this.stopPromiseResolver = null;
      }
    } catch (err) {
      logger.error('Error during session finalization:', err);
      await this.handleError('ERR_FINALIZATION_FAILED');
    }
  }

  private async handleError(errorMessage: string): Promise<void> {
    if (this.currentSession) {
      this.currentSession.status = 'ERROR';
      this.currentSession.errorMessage = errorMessage;
      await updateSession(this.currentSession.sessionId, {
        status: 'ERROR',
        errorMessage,
      }).catch((e) => logger.error('Failed updating session error state:', e));
    }

    this.stopAllTracks();
    if (this.mixerResult) {
      this.mixerResult.cleanup();
      this.mixerResult = null;
    }

    const errorSession = this.currentSession ? { ...this.currentSession } : null;
    this.resetState();

    if (this.stopPromiseResolver && errorSession) {
      this.stopPromiseResolver(errorSession);
      this.stopPromiseResolver = null;
    }
  }

  private stopAllTracks(): void {
    if (this.activeCompositeStream) {
      this.activeCompositeStream.getTracks().forEach((track) => track.stop());
      this.activeCompositeStream = null;
    }
    if (this.displayStreamRef) {
      this.displayStreamRef.getTracks().forEach((track) => track.stop());
      this.displayStreamRef = null;
    }
    if (this.micStreamRef) {
      this.micStreamRef.getTracks().forEach((track) => track.stop());
      this.micStreamRef = null;
    }
  }

  private resetState(): void {
    this.mediaRecorder = null;
    this.isStopping = false;
  }

  private selectMimeType(): string {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=h264,opus',
      'video/webm',
    ];

    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported) {
      for (const mime of candidates) {
        if (MediaRecorder.isTypeSupported(mime)) {
          return mime;
        }
      }
    }
    return 'video/webm';
  }
}
