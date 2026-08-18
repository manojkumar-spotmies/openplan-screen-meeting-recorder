import { SessionStatus, CaptureMode } from './entities.js';

export type MessageTarget = 'SERVICE_WORKER' | 'OFFSCREEN' | 'POPUP' | 'INSPECTOR';

export type ExtensionAction = 
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'GET_SESSION_STATUS'
  | 'RECORDING_STATE_CHANGED'
  | 'OFFSCREEN_ERROR';

export interface ExtensionMessage<T = unknown> {
  target: MessageTarget;
  action: ExtensionAction;
  payload: T;
  meta: {
    timestamp: string;
    requestId: string;
  };
}

export interface StartRecordingPayload {
  title: string;
  sourceTabUrl?: string;
}

export interface StartRecordingResponseData {
  sessionId: string;
  status: SessionStatus;
  captureMode: CaptureMode;
}

export interface StopRecordingPayload {
  sessionId: string;
  reason: 'USER_ACTION' | 'TAB_CLOSED' | 'NATIVE_STOP_BAR';
}

export interface StopRecordingResponseData {
  sessionId: string;
  status: SessionStatus;
  totalChunks: number;
  durationSeconds: number;
}

export interface RecordingStateChangedPayload {
  sessionId: string;
  status: SessionStatus;
  chunksRecorded: number;
  activeCaptureMode: CaptureMode;
  errorMessage?: string;
}
