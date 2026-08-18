export interface IStorageProvider {
  putChunk(sessionId: string, sequenceNumber: number, data: Buffer): Promise<string>;
  getChunk(storageKey: string): Promise<Buffer>;
  saveFinalVideo?(sessionId: string, videoBuffer: Buffer, format: string): Promise<string>;
  getSignedPlaybackUrl?(storageKey: string, expiresInSeconds: number): Promise<string>;
  deleteSession(sessionId: string): Promise<void>;
}
