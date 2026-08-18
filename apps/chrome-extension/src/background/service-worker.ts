import {
  ExtensionMessage,
  StartRecordingPayload,
  StopRecordingPayload,
  RecordingStateChangedPayload,
  ApiResponse,
  ApiErrorResponse,
  LocalVideoSession,
  CaptureMode,
} from '@openplan/contracts';
import { logger } from '@openplan/core';
import { getAllSessions, getSession } from '../modules/offline-cache/idb-store.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

let activeSessionId: string | null = null;
let recordedTabId: number | null = null;

// Service Worker Initialization & State Reconciliation (E-09)
chrome.runtime.onInstalled.addListener(() => {
  logger.info('Openplan Recorder Extension installed');
  reconcileActiveState().catch((err) => logger.error('Error during initial state reconciliation:', err));
});

chrome.runtime.onStartup?.addListener(() => {
  logger.info('Service Worker started');
  reconcileActiveState().catch((err) => logger.error('Error during startup state reconciliation:', err));
});

// Runtime Message Listener
chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: ApiResponse<unknown> | ApiErrorResponse) => void
  ) => {
    if (message.target !== 'SERVICE_WORKER') {
      return false;
    }

    handleServiceWorkerMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((err) => {
        logger.error('Error handling service worker message:', err);
        sendResponse({
          success: false,
          error: {
            code: 'ERR_SW_EXECUTION_FAILED',
            message: err instanceof Error ? err.message : String(err),
          },
          meta: {
            timestamp: new Date().toISOString(),
            requestId: message.meta?.requestId || crypto.randomUUID(),
          },
        });
      });

    return true; // Asynchronous sendResponse support
  }
);

// Google Meet & Monitored Tab Lifecycle Listener (E-06)
chrome.tabs.onRemoved.addListener((tabId) => {
  if (recordedTabId !== null && tabId === recordedTabId) {
    logger.info(`Monitored recorded tab ${tabId} was closed. Auto-stopping recording session.`);
    triggerAutoStop('TAB_CLOSED').catch((err) => logger.error('Auto-stop on tab remove failed:', err));
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (recordedTabId !== null && tabId === recordedTabId && changeInfo.url) {
    if (!changeInfo.url.includes('meet.google.com')) {
      logger.info(`Monitored tab ${tabId} navigated away from Google Meet. Auto-stopping recording.`);
      triggerAutoStop('TAB_CLOSED').catch((err) => logger.error('Auto-stop on tab navigate failed:', err));
    }
  }
});

async function handleServiceWorkerMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
): Promise<ApiResponse<unknown> | ApiErrorResponse> {
  const meta = {
    timestamp: new Date().toISOString(),
    requestId: message.meta?.requestId || crypto.randomUUID(),
  };

  switch (message.action) {
    case 'START_RECORDING': {
      const payload = message.payload as StartRecordingPayload;
      
      // Store current active tab ID if provided
      if (sender.tab?.id) {
        recordedTabId = sender.tab.id;
      } else {
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs.length > 0 && activeTabs[0].id) {
          recordedTabId = activeTabs[0].id;
        }
      }

      // 1. Ensure Offscreen Document exists
      await ensureOffscreenDocument();

      // 2. Forward START_RECORDING to offscreen context
      const offscreenMessage: ExtensionMessage = {
        ...message,
        target: 'OFFSCREEN',
      };

      const response = (await chrome.runtime.sendMessage(offscreenMessage)) as
        | ApiResponse<{ sessionId: string; status: string; captureMode: string }>
        | ApiErrorResponse;

      if (response.success) {
        activeSessionId = response.data.sessionId;
        broadcastStateChange({
          sessionId: response.data.sessionId,
          status: 'RECORDING',
          chunksRecorded: 0,
          activeCaptureMode: response.data.captureMode as CaptureMode,
        });
      } else {
        // If screen share was cancelled or failed, close offscreen context
        await closeOffscreenDocument();
        recordedTabId = null;
      }

      return response;
    }

    case 'STOP_RECORDING': {
      const payload = (message.payload as StopRecordingPayload) || {
        sessionId: activeSessionId || '',
        reason: 'USER_ACTION',
      };

      return await executeStopRecording(payload.reason || 'USER_ACTION', meta);
    }

    case 'GET_SESSION_STATUS': {
      await reconcileActiveState();
      let session: LocalVideoSession | undefined;
      if (activeSessionId) {
        session = await getSession(activeSessionId);
      }

      return {
        success: true,
        data: session || null,
        meta,
      };
    }

    default:
      return {
        success: false,
        error: {
          code: 'ERR_UNKNOWN_ACTION',
          message: `Action ${message.action} is unknown to Service Worker`,
        },
        meta,
      };
  }
}

async function executeStopRecording(
  reason: 'USER_ACTION' | 'TAB_CLOSED' | 'NATIVE_STOP_BAR',
  meta: { timestamp: string; requestId: string }
): Promise<ApiResponse<unknown> | ApiErrorResponse> {
  const hasOffscreen = await hasOffscreenDocument();
  if (!hasOffscreen) {
    logger.warn('No active offscreen document found when requesting stop');
    await reconcileActiveState();
    return {
      success: true,
      data: { sessionId: activeSessionId, status: 'STOPPED' },
      meta,
    };
  }

  const offscreenStopMessage: ExtensionMessage<StopRecordingPayload> = {
    target: 'OFFSCREEN',
    action: 'STOP_RECORDING',
    payload: {
      sessionId: activeSessionId || '',
      reason,
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: meta.requestId,
    },
  };

  const response = (await chrome.runtime.sendMessage(offscreenStopMessage)) as
    | ApiResponse<{ sessionId: string; status: string; totalChunks: number; durationSeconds: number }>
    | ApiErrorResponse;

  if (response.success) {
    broadcastStateChange({
      sessionId: response.data.sessionId,
      status: 'STOPPED',
      chunksRecorded: response.data.totalChunks,
      activeCaptureMode: 'SCREEN_SYSTEM_MIC',
    });
  }

  // Close offscreen document context after stopping
  await closeOffscreenDocument();
  activeSessionId = null;
  recordedTabId = null;

  return response;
}

async function triggerAutoStop(reason: 'TAB_CLOSED'): Promise<void> {
  if (activeSessionId) {
    const meta = {
      timestamp: new Date().toISOString(),
      requestId: crypto.randomUUID(),
    };
    await executeStopRecording(reason, meta);
  }
}

async function hasOffscreenDocument(): Promise<boolean> {
  if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
    return await chrome.offscreen.hasDocument();
  }
  const swSelf = self as unknown as { clients?: { matchAll: () => Promise<Array<{ url: string }>> } };
  if (swSelf.clients) {
    const matchedClients = await swSelf.clients.matchAll();
    return matchedClients.some((client: { url: string }) => client.url.includes(OFFSCREEN_DOCUMENT_PATH));
  }
  return false;
}

async function ensureOffscreenDocument(): Promise<void> {
  const exists = await hasOffscreenDocument();
  if (!exists) {
    logger.info('Creating offscreen document container for WebRTC recording');
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Recording screen and audio into IndexedDB offline store',
    });
  }
}

async function closeOffscreenDocument(): Promise<void> {
  const exists = await hasOffscreenDocument();
  if (exists) {
    logger.info('Closing offscreen document container');
    await chrome.offscreen.closeDocument();
  }
}

// Service Worker Wake-Up Reconciliation (E-09)
async function reconcileActiveState(): Promise<void> {
  try {
    const sessions = await getAllSessions();
    const active = sessions.find((s) => s.status === 'RECORDING' || s.status === 'STOPPING');
    if (active) {
      activeSessionId = active.sessionId;
      logger.info(`Reconciled active session ${activeSessionId} from IndexedDB`);
    } else {
      activeSessionId = null;
      recordedTabId = null;
    }
  } catch (err) {
    logger.error('Failed to reconcile active state from IndexedDB:', err);
  }
}

// Event Broadcast Helper
function broadcastStateChange(payload: RecordingStateChangedPayload): void {
  const message: ExtensionMessage<RecordingStateChangedPayload> = {
    target: 'POPUP',
    action: 'RECORDING_STATE_CHANGED',
    payload,
    meta: {
      timestamp: new Date().toISOString(),
      requestId: crypto.randomUUID(),
    },
  };

  chrome.runtime.sendMessage(message).catch(() => {
    // Popup or Inspector might not be open to receive message; swallow harmlessly
  });
}
