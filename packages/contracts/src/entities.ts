export type SessionStatus = 
  | 'INITIALIZED' 
  | 'IDLE'
  | 'REQUESTING_PERMISSIONS'
  | 'RECORDING' 
  | 'STOPPING'
  | 'FINALIZING'
  | 'STOPPED' 
  | 'WAITING_FOR_CHUNKS' 
  | 'PROCESSING' 
  | 'READY' 
  | 'FAILED' 
  | 'INCOMPLETE'
  | 'ERROR';

export type CaptureMode = 
  | 'SCREEN_SYSTEM_MIC' 
  | 'SCREEN_SYSTEM' 
  | 'SCREEN_MIC' 
  | 'SCREEN_ONLY';

export interface LocalVideoSession {
  sessionId: string;
  title: string;
  sourceTabUrl?: string;
  status: SessionStatus;
  captureMode: CaptureMode;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  totalChunks: number;
  durationSeconds?: number;
  fileSizeBytes?: number;
  errorMessage?: string;
}

export interface LocalVideoChunk {
  sessionId: string;
  sequenceNumber: number; // 1-indexed (1, 2, 3...)
  timestamp: string; // ISO 8601
  byteSize: number;
  mimeType: string; // e.g. "video/webm;codecs=vp8,opus"
  blob: Blob; // Raw binary chunk blob
  isFinal: boolean;
}

export interface SessionManifest {
  sessionId: string;
  totalChunks: number;
  sequenceChecksums: Record<number, string>;
  finalChunkTimestamp: string;
}
