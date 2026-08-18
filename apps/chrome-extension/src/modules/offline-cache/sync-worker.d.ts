import { LocalVideoChunk } from '@openplan/contracts';
export interface SyncWorkerConfig {
    backendBaseUrl?: string;
    userId?: string;
    maxConcurrency?: number;
    maxRetries?: number;
}
export declare class SyncWorker {
    private backendBaseUrl;
    private userId;
    private maxConcurrency;
    private maxRetries;
    private isRunning;
    private activeUploadCount;
    private retryCounts;
    private onlineListenerAttached;
    constructor(config?: SyncWorkerConfig);
    startSync(sessionId?: string): void;
    stopSync(): void;
    getActiveUploadCount(): number;
    drainQueue(sessionId?: string): Promise<void>;
    private attachNetworkListeners;
    private isOnline;
    private processQueue;
    uploadChunkWithRetry(chunk: LocalVideoChunk): Promise<boolean>;
    uploadChunk(chunk: LocalVideoChunk): Promise<boolean>;
    private isNonRetryableError;
}
export declare const syncWorker: SyncWorker;
