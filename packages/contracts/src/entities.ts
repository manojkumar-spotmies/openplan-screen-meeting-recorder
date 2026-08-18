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

export interface VideoSession {
  id: string; // UUIDv4
  userId: string; // Openplan User ID
  title: string;
  sourceTabUrl?: string;
  status: SessionStatus;
  totalChunksExpected?: number;
  totalChunksReceived: number;
  durationSeconds?: number;
  fileSizeBytes?: number;
  gracePeriodEndsAt?: string; // ISO 8601
  createdAt: string;
  updatedAt: string;
}

export interface VideoChunk {
  id: string; // UUIDv4
  sessionId: string;
  sequenceNumber: number;
  checksumSha256: string;
  byteSize: number;
  storageKey: string;
  uploadedAt: string;
}

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
  // Manual recording controls (F-003 floating widget). RECORDING status is preserved
  // while paused; pause never becomes a distinct SessionStatus so backend/F-002 semantics
  // are untouched.
  isPaused?: boolean;
  microphoneEnabled?: boolean;
  systemAudioEnabled?: boolean;
  hasMicrophone?: boolean;
  hasSystemAudio?: boolean;
}

export interface LocalVideoChunk {
  sessionId: string;
  sequenceNumber: number; // 1-indexed (1, 2, 3...)
  timestamp: string; // ISO 8601
  byteSize: number;
  mimeType: string; // e.g. "video/webm;codecs=vp8,opus"
  checksumSha256?: string; // 64-character hex string
  blob?: Blob; // Present while unsynced; purged (undefined) post-ACK
  synced?: boolean; // Set to true upon HTTP 200 ACK
  isFinal: boolean;
}


export interface SessionManifest {
  sessionId: string;
  totalChunks: number;
  sequenceChecksums: Record<number, string>;
  finalChunkTimestamp: string;
}

