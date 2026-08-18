import { logger } from '@openplan/core';
import { getUnsyncedChunks, markChunkSyncedAndPurgeBlob, computeSha256 } from './idb-store.js';
export class SyncWorker {
    backendBaseUrl;
    userId;
    maxConcurrency;
    maxRetries;
    isRunning = false;
    activeUploadCount = 0;
    retryCounts = new Map();
    onlineListenerAttached = false;
    constructor(config = {}) {
        this.backendBaseUrl = config.backendBaseUrl || 'http://localhost:4000';
        this.userId = config.userId || 'dev-user-1';
        this.maxConcurrency = config.maxConcurrency || 2;
        this.maxRetries = config.maxRetries || 5;
        this.attachNetworkListeners();
    }
    startSync(sessionId) {
        this.isRunning = true;
        this.processQueue(sessionId).catch((err) => {
            logger.error('Error during sync worker processQueue:', err);
        });
    }
    stopSync() {
        this.isRunning = false;
    }
    getActiveUploadCount() {
        return this.activeUploadCount;
    }
    async drainQueue(sessionId) {
        this.isRunning = true;
        await this.processQueue(sessionId);
    }
    attachNetworkListeners() {
        if (typeof window !== 'undefined' && window.addEventListener && !this.onlineListenerAttached) {
            window.addEventListener('online', () => {
                logger.info('Network status: ONLINE. Resuming sync worker.');
                this.startSync();
            });
            window.addEventListener('offline', () => {
                logger.info('Network status: OFFLINE. Pausing sync worker.');
            });
            this.onlineListenerAttached = true;
        }
    }
    isOnline() {
        if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
            return navigator.onLine;
        }
        return true; // Default to true in Node/test environments
    }
    async processQueue(targetSessionId) {
        if (!this.isRunning || !this.isOnline()) {
            return;
        }
        try {
            const unsynced = await getUnsyncedChunks(targetSessionId);
            if (unsynced.length === 0) {
                return;
            }
            const tasks = [];
            for (const chunk of unsynced) {
                if (!this.isRunning || !this.isOnline()) {
                    break;
                }
                while (this.activeUploadCount >= this.maxConcurrency) {
                    // Wait for available slot
                    await new Promise((resolve) => setTimeout(resolve, 50));
                }
                const chunkKey = `${chunk.sessionId}:${chunk.sequenceNumber}`;
                const retries = this.retryCounts.get(chunkKey) || 0;
                if (retries >= this.maxRetries) {
                    logger.warn(`Chunk ${chunkKey} reached max retries (${this.maxRetries}). Skipping for now.`);
                    continue;
                }
                this.activeUploadCount += 1;
                const task = this.uploadChunkWithRetry(chunk)
                    .then(() => { })
                    .finally(() => {
                    this.activeUploadCount = Math.max(0, this.activeUploadCount - 1);
                });
                tasks.push(task);
            }
            await Promise.all(tasks);
        }
        catch (err) {
            logger.error('Failed to query unsynced chunks from IDB:', err);
        }
    }
    async uploadChunkWithRetry(chunk) {
        const chunkKey = `${chunk.sessionId}:${chunk.sequenceNumber}`;
        let attempt = this.retryCounts.get(chunkKey) || 0;
        while (attempt <= this.maxRetries && this.isOnline()) {
            try {
                const success = await this.uploadChunk(chunk);
                if (success) {
                    this.retryCounts.delete(chunkKey);
                    // Safe IDB Purge post-ACK
                    await markChunkSyncedAndPurgeBlob(chunk.sessionId, chunk.sequenceNumber);
                    return true;
                }
            }
            catch (err) {
                const isNonRetryable = this.isNonRetryableError(err);
                if (isNonRetryable) {
                    logger.error(`Non-retryable upload error for chunk ${chunkKey}:`, err);
                    this.retryCounts.set(chunkKey, this.maxRetries); // Exceed retries immediately
                    return false;
                }
                attempt += 1;
                this.retryCounts.set(chunkKey, attempt);
                if (attempt > this.maxRetries) {
                    logger.error(`Chunk ${chunkKey} exceeded maximum retry attempts (${this.maxRetries})`);
                    return false;
                }
                // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s ±200ms
                const baseDelayMs = Math.pow(2, attempt - 1) * 1000;
                const jitterMs = Math.floor(Math.random() * 400) - 200; // ±200ms
                const backoffDelay = Math.max(100, baseDelayMs + jitterMs);
                logger.warn(`Retrying chunk ${chunkKey} (attempt ${attempt}/${this.maxRetries}) after ${backoffDelay}ms`);
                await new Promise((res) => setTimeout(res, backoffDelay));
            }
        }
        return false;
    }
    async uploadChunk(chunk) {
        if (!chunk.blob) {
            // Blob already purged or missing
            await markChunkSyncedAndPurgeBlob(chunk.sessionId, chunk.sequenceNumber);
            return true;
        }
        let checksum = chunk.checksumSha256;
        if (!checksum) {
            checksum = await computeSha256(chunk.blob);
        }
        const formData = new FormData();
        formData.append('sequenceNumber', String(chunk.sequenceNumber));
        formData.append('checksumSha256', checksum);
        formData.append('chunk', chunk.blob, `chunk-${chunk.sequenceNumber}.webm`);
        const url = `${this.backendBaseUrl}/api/v1/sessions/${chunk.sessionId}/chunks`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'x-user-id': this.userId,
            },
            body: formData,
        });
        if (response.ok) {
            const json = await response.json();
            if (json.success) {
                return true;
            }
        }
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    isNonRetryableError(err) {
        if (err instanceof Error) {
            const msg = err.message;
            return (msg.includes('400') ||
                msg.includes('404') ||
                msg.includes('409') ||
                msg.includes('ERR_CHECKSUM_MISMATCH') ||
                msg.includes('ERR_DUPLICATE_SEQUENCE_CONFLICT') ||
                msg.includes('ERR_SESSION_EXPIRED') ||
                msg.includes('ERR_SESSION_NOT_FOUND') ||
                msg.includes('ERR_INVALID_MIME_TYPE'));
        }
        return false;
    }
}
export const syncWorker = new SyncWorker();
