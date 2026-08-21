import { SessionStatus, CaptureMode } from './entities.js';

export type MessageTarget = 'SERVICE_WORKER' | 'OFFSCREEN' | 'POPUP' | 'INSPECTOR';

export type ExtensionAction =
  | 'START_RECORDING'
  | 'STOP_RECORDING'
  | 'PAUSE_RECORDING'
  | 'RESUME_RECORDING'
  | 'SET_MICROPHONE_ENABLED'
  | 'SET_SYSTEM_AUDIO_ENABLED'
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

export interface ExternalStartRecordingMessage {
  target: 'SERVICE_WORKER';
  action: 'START_RECORDING';
  payload: {
    sessionId: string;
    title: string;
    sourceTabUrl?: string;
  };
  meta: {
    timestamp: string;
    requestId: string;
  };
}

export interface StartRecordingPayload {
  title: string;
  sourceTabUrl?: string;
  sessionId?: string;
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
  localExport?: LocalExportSummary;
}

// Outcome of exporting the backend's completed final video to the user's selected local
// folder (Step 2B). Deliberately separate from SessionStatus/recording lifecycle — a
// failed local export never affects whether the recording itself succeeded.
export type LocalExportState =
  | 'NOT_ATTEMPTED'
  | 'NO_FOLDER'
  | 'NEEDS_PERMISSION'
  | 'PERMISSION_DENIED'
  | 'FOLDER_UNAVAILABLE'
  | 'COMPLETED'
  | 'FAILED';

export interface LocalExportSummary {
  state: LocalExportState;
  folderName?: string;
  fileName?: string;
  errorMessage?: string;
}

export interface PauseRecordingPayload {
  sessionId: string;
}

export interface ResumeRecordingPayload {
  sessionId: string;
}

export interface SetMicrophoneEnabledPayload {
  sessionId: string;
  enabled: boolean;
}

export interface SetSystemAudioEnabledPayload {
  sessionId: string;
  enabled: boolean;
}

export interface RecordingControlResponseData {
  sessionId: string;
  status: SessionStatus;
  isPaused: boolean;
  microphoneEnabled: boolean;
  systemAudioEnabled: boolean;
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
}

export interface RecordingStateChangedPayload {
  sessionId: string;
  status: SessionStatus;
  chunksRecorded: number;
  activeCaptureMode: CaptureMode;
  errorMessage?: string;
  isPaused?: boolean;
  microphoneEnabled?: boolean;
  systemAudioEnabled?: boolean;
  hasMicrophone?: boolean;
  hasSystemAudio?: boolean;
}

