export interface IStorageProvider {
  putChunk(sessionId: string, sequenceNumber: number, data: Buffer): Promise<string>;
  getChunk(storageKey: string): Promise<Buffer>;
  /** Resolves a storage key to an absolute filesystem path for direct (non-buffered) access, e.g. by FFmpeg. */
  getChunkPath(storageKey: string): string;
  /** Deterministic storage key for a chunk, independent of whether it has been written yet. */
  getChunkStorageKey(sessionId: string, sequenceNumber: number): string;
  /** Cheap existence check for a chunk, by storage key. */
  chunkExists(storageKey: string): Promise<boolean>;
  /** Removes a chunk. Safe to call on an already-removed chunk (no-op). */
  deleteChunk(storageKey: string): Promise<void>;
  /** Ensures and returns the directory holding a session's incrementally-assembled video. Always disposable. */
  getAssemblyDir(sessionId: string): Promise<string>;
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
  /**
   * Removes a session's disposable working files (assembly buffer, FFmpeg scratch dir,
   * any stray chunk files) once its final video has been safely exported elsewhere. Never
   * touches the `final/` directory. Idempotent — safe to call on a session with nothing
   * left to clean.
   */
  cleanupTemporaryArtifacts(sessionId: string): Promise<void>;
}
