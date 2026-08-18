import { logger } from '@openplan/core';
import { createSession, updateSession, saveChunk } from '../offline-cache/idb-store.js';
import { combineAudioTracks } from './audio-mixer.js';
export class RecorderService {
    mediaRecorder = null;
    currentSession = null;
    sequenceNumber = 1;
    startTime = 0;
    accumulatedBytes = 0;
    mixerResult = null;
    activeCompositeStream = null;
    displayStreamRef = null;
    micStreamRef = null;
    isStopping = false;
    stopPromiseResolver = null;
    async startRecording(options) {
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            throw new Error('Recording session already active');
        }
        const { sessionId = crypto.randomUUID(), title, sourceTabUrl, displayStream, micStream = null, timesliceMs = 5000, } = options;
        this.displayStreamRef = displayStream;
        this.micStreamRef = micStream;
        // Combine audio tracks using AudioMixer
        this.mixerResult = combineAudioTracks(displayStream, micStream);
        // Build composite MediaStream
        const compositeTracks = [...displayStream.getVideoTracks()];
        if (this.mixerResult.compositeAudioTrack) {
            compositeTracks.push(this.mixerResult.compositeAudioTrack);
        }
        this.activeCompositeStream = new MediaStream(compositeTracks);
        // Initial session entity setup
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
        this.mediaRecorder = new MediaRecorder(this.activeCompositeStream, mimeType ? { mimeType } : undefined);
        // Handle chunk emission (5s timeslice)
        this.mediaRecorder.ondataavailable = async (event) => {
            await this.handleDataAvailable(event);
        };
        // Handle recorder stop
        this.mediaRecorder.onstop = async () => {
            await this.handleStop();
        };
        // Handle recorder errors
        this.mediaRecorder.onerror = async (event) => {
            logger.error('MediaRecorder error event:', event);
            await this.handleError('MediaRecorder execution error');
        };
        // Start MediaRecorder with 5s timeslice
        this.mediaRecorder.start(timesliceMs);
        logger.info(`MediaRecorder started for session ${sessionId} (timeslice=${timesliceMs}ms, mode=${this.mixerResult.captureMode})`);
        return this.currentSession;
    }
    async stopRecording(reason = 'USER_ACTION') {
        if (!this.mediaRecorder || !this.currentSession) {
            throw new Error('No active recording session to stop');
        }
        if (this.isStopping) {
            if (this.currentSession.status === 'STOPPED') {
                return this.currentSession;
            }
        }
        this.isStopping = true;
        logger.info(`Stopping recording session ${this.currentSession.sessionId} (reason: ${reason})`);
        // Transition state RECORDING -> STOPPING
        this.currentSession.status = 'STOPPING';
        await updateSession(this.currentSession.sessionId, { status: 'STOPPING' });
        return new Promise((resolve) => {
            this.stopPromiseResolver = resolve;
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                // Calling stop() triggers final ondataavailable event followed by onstop
                this.mediaRecorder.stop();
            }
            else {
                this.handleStop().catch((err) => logger.error('Error handling stop:', err));
            }
        });
    }
    getCurrentSession() {
        return this.currentSession;
    }
    getSequenceNumber() {
        return this.sequenceNumber;
    }
    async handleDataAvailable(event) {
        if (!event.data || event.data.size === 0 || !this.currentSession) {
            return;
        }
        const currentSeq = this.sequenceNumber;
        const isFinalChunk = this.isStopping || (this.mediaRecorder && this.mediaRecorder.state === 'inactive');
        // Create 1-indexed LocalVideoChunk
        const chunk = {
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
            logger.info(`Chunk #${currentSeq} (${event.data.size} bytes) persisted for session ${this.currentSession.sessionId}`);
        }
        catch (err) {
            logger.error(`Failed to persist chunk #${currentSeq}:`, err);
            await this.handleError('ERR_IDB_WRITE_FAILED');
        }
    }
    async handleStop() {
        if (!this.currentSession)
            return;
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
            logger.info(`Session ${this.currentSession.sessionId} stopped successfully. Total Chunks: ${this.currentSession.totalChunks}, Duration: ${durationSeconds.toFixed(1)}s`);
            const finalSession = { ...this.currentSession };
            this.resetState();
            if (this.stopPromiseResolver) {
                this.stopPromiseResolver(finalSession);
                this.stopPromiseResolver = null;
            }
        }
        catch (err) {
            logger.error('Error during session finalization:', err);
            await this.handleError('ERR_FINALIZATION_FAILED');
        }
    }
    async handleError(errorMessage) {
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
    stopAllTracks() {
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
    resetState() {
        this.mediaRecorder = null;
        this.isStopping = false;
    }
    selectMimeType() {
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
