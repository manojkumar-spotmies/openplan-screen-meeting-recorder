export interface IStorageProvider {
  putChunk(sessionId: string, sequenceNumber: number, data: Buffer): Promise<string>;
  getChunk(storageKey: string): Promise<Buffer>;
  /** Resolves a storage key to an absolute filesystem path for direct (non-buffered) access, e.g. by FFmpeg. */
  getChunkPath(storageKey: string): string;
  /** Ensures and returns a scratch directory for a session's in-progress video processing. Always disposable. */
  getProcessingScratchDir(sessionId: string): Promise<string>;
  /** Atomically moves a completed local file (e.g. FFmpeg output) into permanent final-video storage. */
  saveFinalVideo(sessionId: string, sourceFilePath: string, fileName: string): Promise<string>;
  /** Resolves a final-video storage key to an absolute filesystem path. */
  getFinalVideoPath(storageKey: string): string;
  /** Cheap existence check for the deterministic final-video path — used for crash recovery (see Case E). */
  finalVideoExists(sessionId: string): Promise<boolean>;
  getSignedPlaybackUrl?(storageKey: string, expiresInSeconds: number): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
}
