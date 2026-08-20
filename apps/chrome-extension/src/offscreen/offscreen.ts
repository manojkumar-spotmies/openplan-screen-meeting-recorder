import {
  ExtensionMessage,
  StartRecordingPayload,
  StartRecordingResponseData,
  StopRecordingPayload,
  StopRecordingResponseData,
  SetMicrophoneEnabledPayload,
  SetSystemAudioEnabledPayload,
  RecordingControlResponseData,
  ApiResponse,
  ApiErrorResponse,
} from '@openplan/contracts';
import { logger } from '@openplan/core';
import { RecorderService } from '../modules/recorder/recorder.service.js';

const recorderService = new RecorderService();

/**
 * Message listener for Offscreen Document execution context.
 */
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(
    (
      message: ExtensionMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (response: ApiResponse<unknown> | ApiErrorResponse) => void
    ) => {
      if (message.target !== 'OFFSCREEN') {
        return false;
      }

      handleOffscreenMessage(message)
        .then((response) => sendResponse(response))
        .catch((err) => {
          logger.error('Unhandled offscreen message error:', err);
          sendResponse({
            success: false,
            error: {
              code: 'ERR_OFFSCREEN_EXECUTION_FAILED',
              message: err instanceof Error ? err.message : String(err),
            },
            meta: {
              timestamp: new Date().toISOString(),
              requestId: message.meta?.requestId || crypto.randomUUID(),
            },
          });
        });

      return true; // Keep channel open for async sendResponse
    }
  );
}

async function handleOffscreenMessage(
  message: ExtensionMessage
): Promise<ApiResponse<unknown> | ApiErrorResponse> {
  const meta = {
    timestamp: new Date().toISOString(),
    requestId: message.meta?.requestId || crypto.randomUUID(),
  };

  switch (message.action) {
    case 'START_RECORDING': {
      const payload = message.payload as StartRecordingPayload;
      return await handleStartRecording(payload, meta);
    }
    case 'STOP_RECORDING': {
      const payload = message.payload as StopRecordingPayload;
      return await handleStopRecording(payload, meta);
    }
    case 'PAUSE_RECORDING': {
      return await handleControlAction(() => recorderService.pauseRecording(), meta, 'ERR_RECORDER_PAUSE_FAILED');
    }
    case 'RESUME_RECORDING': {
      return await handleControlAction(() => recorderService.resumeRecording(), meta, 'ERR_RECORDER_RESUME_FAILED');
    }
    case 'SET_MICROPHONE_ENABLED': {
      const payload = message.payload as SetMicrophoneEnabledPayload;
      return await handleControlAction(
        () => recorderService.setMicrophoneEnabled(payload.enabled),
        meta,
        'ERR_MICROPHONE_TOGGLE_FAILED'
      );
    }
    case 'SET_SYSTEM_AUDIO_ENABLED': {
      const payload = message.payload as SetSystemAudioEnabledPayload;
      return await handleControlAction(
        () => recorderService.setSystemAudioEnabled(payload.enabled),
        meta,
        'ERR_SYSTEM_AUDIO_TOGGLE_FAILED'
      );
    }
    case 'GET_SESSION_STATUS': {
      const current = recorderService.getCurrentSession();
      return {
        success: true,
        data: current,
        meta,
      };
    }
    default:
      return {
        success: false,
        error: {
          code: 'ERR_UNKNOWN_ACTION',
          message: `Action ${message.action} is not supported by offscreen context`,
        },
        meta,
      };
  }
}

async function handleStartRecording(
  payload: StartRecordingPayload,
  meta: { timestamp: string; requestId: string }
): Promise<ApiResponse<StartRecordingResponseData> | ApiErrorResponse> {
  let displayStream: MediaStream;
  try {
    // Prompt user for screen & system audio capture
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: {
        suppressLocalAudioPlayback: false,
      },
      systemAudio: 'include',
    } as DisplayMediaStreamOptions);
  } catch (err) {
    logger.warn('Screen share picker cancelled or failed:', err);
    return {
      success: false,
      error: {
        code: 'ERR_SCREEN_CANCELLED',
        message: 'Screen capture picker was cancelled or denied by user',
      },
      meta,
    };
  }

  // Attempt microphone capture with degraded fallback
  let micStream: MediaStream | null = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.warn(`Microphone permission denied or unavailable, proceeding degraded (${errorMsg})`);
    // Gracefully degrades without throwing (per F-001 Section 6 E-02)
  }

  try {
    const session = await recorderService.startRecording({
      sessionId: payload.sessionId,
      title: payload.title || 'Local Meeting Recording',
      sourceTabUrl: payload.sourceTabUrl,
      displayStream,
      micStream,
    });

    return {
      success: true,
      data: {
        sessionId: session.sessionId,
        status: session.status,
        captureMode: session.captureMode,
      },
      meta,
    };
  } catch (err) {
    logger.error('Failed starting recorder service:', err);
    return {
      success: false,
      error: {
        code: 'ERR_RECORDER_START_FAILED',
        message: err instanceof Error ? err.message : 'Failed to start recording service',
      },
      meta,
    };
  }
}

async function handleStopRecording(
  payload: StopRecordingPayload,
  meta: { timestamp: string; requestId: string }
): Promise<ApiResponse<StopRecordingResponseData> | ApiErrorResponse> {
  try {
    const session = await recorderService.stopRecording(payload?.reason || 'USER_ACTION');

    return {
      success: true,
      data: {
        sessionId: session.sessionId,
        status: session.status,
        totalChunks: session.totalChunks,
        durationSeconds: session.durationSeconds || 0,
      },
      meta,
    };
  } catch (err) {
    logger.error('Failed stopping recorder service:', err);
    return {
      success: false,
      error: {
        code: 'ERR_RECORDER_STOP_FAILED',
        message: err instanceof Error ? err.message : 'Failed to stop recording service',
      },
      meta,
    };
  }
}

async function handleControlAction(
  action: () => Promise<{
    sessionId: string;
    status: StartRecordingResponseData['status'];
    isPaused: boolean;
    microphoneEnabled: boolean;
    systemAudioEnabled: boolean;
    hasMicrophone: boolean;
    hasSystemAudio: boolean;
  }>,
  meta: { timestamp: string; requestId: string },
  errorCode: string
): Promise<ApiResponse<RecordingControlResponseData> | ApiErrorResponse> {
  try {
    const state = await action();
    return {
      success: true,
      data: state,
      meta,
    };
  } catch (err) {
    logger.warn(`Recording control action failed (${errorCode}):`, err);
    return {
      success: false,
      error: {
        code: errorCode,
        message: err instanceof Error ? err.message : 'Recording control action failed',
      },
      meta,
    };
  }
}
