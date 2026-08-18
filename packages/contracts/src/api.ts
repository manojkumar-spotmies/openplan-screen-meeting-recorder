export interface ApiResponse<T> {
  success: true;
  data: T;
  meta?: {
    timestamp: string;
    requestId: string;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: {
    timestamp: string;
    requestId: string;
  };
}

export interface InitSessionRequest {
  sessionId: string;
  title: string;
  sourceTabUrl?: string;
}

export interface InitSessionResponseData {
  sessionId: string;
  userId: string;
  title: string;
  status: string;
  createdAt: string;
}

export interface IngestChunkResponseData {
  sessionId: string;
  sequenceNumber: number;
  byteSize: number;
  checksumSha256: string;
  status: 'ACKNOWLEDGED';
  isDuplicate: boolean;
}

export interface StopSessionRequest {
  totalChunks: number;
  sequenceChecksums: Record<string | number, string>;
  finalChunkTimestamp: string;
}

export interface StopSessionResponseData {
  sessionId: string;
  status: string;
  totalChunksExpected: number;
  totalChunksReceived: number;
  missingSequences: number[];
  gracePeriodEndsAt?: string;
}

