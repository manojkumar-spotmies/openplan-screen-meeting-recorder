import {
  ExtensionMessage,
  ExternalStartRecordingMessage,
  StartRecordingPayload,
  StopRecordingPayload,
  StopRecordingResponseData,
  SetMicrophoneEnabledPayload,
  SetSystemAudioEnabledPayload,
  RecordingControlResponseData,
  RecordingStateChangedPayload,
  ApiResponse,
  ApiErrorResponse,
  LocalVideoSession,
  CaptureMode,
} from '@openplan/contracts';
import { logger } from '@openplan/core';
import { getAllSessions, getSession, getChunksForSession } from '../modules/offline-cache/idb-store.js';
import { syncWorker } from '../modules/offline-cache/sync-worker.js';
import { exportFinalVideoToLocalFolder } from '../modules/local-export/export-final-video.js';
import { notifyExportOutcomeIfNeeded } from '../modules/local-export/export-notifications.js';
import { BACKEND_BASE_URL } from '../config/backend-config.js';

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

let activeSessionId: string | null = null;
let recordedTabId: number | null = null;
let recordedTabIsMeet: boolean = false;

// Service Worker Initialization & State Reconciliation (E-09)
chrome.runtime.onInstalled.addListener((details) => {
  logger.info('Openplan Recorder Extension installed');
  reconcileActiveState().catch((err) => logger.error('Error during initial state reconciliation:', err));

  // First-run discoverability: nothing else ever points a new user at Storage Settings
  // (it's only reachable via a button inside the popup), so without this there's no way
  // to learn the local-folder feature exists before their first recording finishes with
  // nowhere configured to save it. Only on a genuine fresh install — 'update' fires on
  // every reload during development and would make this a constant, unwanted interruption.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/settings/index.html') }).catch((err) => {
      logger.warn('Failed to open Storage Settings on first install:', err);
    });
  }
});

chrome.runtime.onStartup?.addListener(() => {
  logger.info('Service Worker started');
  reconcileActiveState().catch((err) => logger.error('Error during startup state reconciliation:', err));
});

// Runtime Message Listener (Extension internal)
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

// External Web Messaging Listener (OpenPlan AI -> Extension trigger)
chrome.runtime.onMessageExternal?.addListener(
  (
    message: ExternalStartRecordingMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: ApiResponse<unknown> | ApiErrorResponse) => void
  ) => {
    const senderUrl = sender.url || sender.origin || '';
    const isAllowedOrigin =
      senderUrl.includes('openplan.ai') ||
      senderUrl.includes('localhost') ||
      senderUrl.includes('127.0.0.1');

    if (!isAllowedOrigin) {
      sendResponse({
        success: false,
        error: {
          code: 'ERR_UNAUTHORIZED_ORIGIN',
          message: `Origin ${senderUrl} is not permitted to trigger recording`,
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId: message.meta?.requestId || crypto.randomUUID(),
        },
      });
      return false;
    }

    if (activeSessionId) {
      sendResponse({
        success: false,
        error: {
          code: 'ERR_RECORDING_ALREADY_ACTIVE',
          message: `Session ${activeSessionId} is already active`,
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId: message.meta?.requestId || crypto.randomUUID(),
        },
      });
      return false;
    }

    handleServiceWorkerMessage(message as unknown as ExtensionMessage, sender)
      .then((response) => sendResponse(response))
      .catch((err) => {
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

    return true;
  }
);

// Google Meet & Monitored Tab Lifecycle Listener (E-06)
chrome.tabs.onRemoved.addListener((tabId) => {
  if (recordedTabId !== null && tabId === recordedTabId) {
    logger.info(`Monitored recorded tab ${tabId} was closed. Auto-stopping recording session.`);
    triggerAutoStop('TAB_CLOSED').catch((err) => logger.error('Auto-stop on tab remove failed:', err));
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // This rule only applies to Meet calls (navigating away from meet.google.com
  // means the call ended). A recorded tab that was never Meet (e.g. a shared
  // ChatGPT/arbitrary tab) is expected to navigate freely without stopping the
  // recording.
  if (recordedTabId !== null && tabId === recordedTabId && changeInfo.url && recordedTabIsMeet) {
    if (!changeInfo.url.includes('meet.google.com')) {
      logger.info(`Monitored tab ${tabId} navigated away from Google Meet. Auto-stopping recording.`);
      triggerAutoStop('TAB_CLOSED').catch((err) => logger.error('Auto-stop on tab navigate failed:', err));
    }
  }

  // Covers navigation within the active tab and brand-new tabs that only
  // become eligible (a real http/https page, past chrome://newtab) once
  // their first navigation finishes — the declarative content_scripts entry
  // normally handles a fresh navigation on its own, but re-running the same
  // idempotent injection here closes any timing gap instead of leaving the
  // widget missing until the next tab switch.
  if (tab.active && changeInfo.status === 'complete') {
    ensureActiveSessionKnown()
      .then((hasActiveSession) => {
        if (hasActiveSession) {
          return injectRecordingWidget(tabId);
        }
      })
      .catch((err) =>
        logger.warn(`[ServiceWorker] Widget injection on tab update failed for tab ${tabId}:`, err)
      );
  }
});

// Follows the user around while recording: the static content_scripts entry
// only auto-mounts the widget on a fresh navigation, so a tab that was
// already open before recording started (or before the extension last
// reloaded) never gets it that way. Whenever the user switches to a
// different tab or window while a recording is active, proactively
// (re-)inject the widget there. injectRecordingWidget/mountRecordingWidget
// are both idempotent, so this is a safe no-op on tabs that already have it.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  ensureActiveSessionKnown()
    .then((hasActiveSession) => {
      if (hasActiveSession) {
        return injectRecordingWidget(tabId);
      }
    })
    .catch((err) =>
      logger.warn(`[ServiceWorker] Widget injection on tab activation failed for tab ${tabId}:`, err)
    );
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const hasActiveSession = await ensureActiveSessionKnown();
    if (!hasActiveSession) return;
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (activeTab?.id !== undefined) {
      await injectRecordingWidget(activeTab.id);
    }
  } catch (err) {
    logger.warn('[ServiceWorker] Widget injection on window focus change failed:', err);
  }
});

// The MV3 service worker is terminated after ~30s idle and can be woken solely
// to deliver a tab/window event like the ones above; that re-executes this
// script from scratch, resetting the in-memory `activeSessionId` to null even
// though a recording is still running (persisted in IndexedDB). Trusting
// `activeSessionId` directly in those handlers made the widget stop following
// the user after the first such wake — it kept working only in whichever tab
// already had it mounted from before the worker died. Re-deriving from
// IndexedDB whenever it looks unset closes that gap.
async function ensureActiveSessionKnown(): Promise<boolean> {
  if (!activeSessionId) {
    await reconcileActiveState();
  }
  return activeSessionId !== null;
}

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
      const payload = (message.payload as StartRecordingPayload) || { title: 'Meeting Recording' };
      const sessionId = payload.sessionId || crypto.randomUUID();

      // Store current active tab ID if provided
      if (sender.tab?.id) {
        recordedTabId = sender.tab.id;
      } else {
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs.length > 0 && activeTabs[0].id) {
          recordedTabId = activeTabs[0].id;
        }
      }
      logger.info(`[ServiceWorker] Recording tab identified: ${recordedTabId ?? 'none'}`);

      recordedTabIsMeet = false;
      if (recordedTabId !== null) {
        try {
          const recordedTab = await chrome.tabs.get(recordedTabId);
          recordedTabIsMeet = Boolean(recordedTab.url && recordedTab.url.includes('meet.google.com'));
        } catch (err) {
          logger.warn(`[ServiceWorker] Failed to look up recorded tab ${recordedTabId}:`, err);
        }
      }

      // Backend Session Init REST Handshake
      try {
        const initResponse = await fetch(`${BACKEND_BASE_URL}/api/v1/sessions/init`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-user-id': 'dev-user-1' },
          body: JSON.stringify({
            sessionId,
            title: payload.title || 'Meeting Recording',
            sourceTabUrl: payload.sourceTabUrl,
          }),
        });
        if (!initResponse.ok) {
          // Chunk uploads will 404 against this sessionId until the backend knows
          // about it, so surface this loudly instead of swallowing it silently.
          const bodyText = await initResponse.text().catch(() => '');
          logger.error(
            `Backend session init rejected (HTTP ${initResponse.status}): ${bodyText}. Chunk sync for ${sessionId} will fail until retried.`
          );
        }
      } catch (err) {
        logger.warn('Backend session init notification failed (recording continues offline):', err);
      }

      // 1. Ensure Offscreen Document exists
      await ensureOffscreenDocument();

      // 2. Forward START_RECORDING to offscreen context
      const offscreenMessage: ExtensionMessage = {
        ...message,
        payload: { ...payload, sessionId },
        target: 'OFFSCREEN',
      };

      const response = (await chrome.runtime.sendMessage(offscreenMessage)) as
        | ApiResponse<{ sessionId: string; status: string; captureMode: string }>
        | ApiErrorResponse;

      if (response.success) {
        activeSessionId = response.data.sessionId;
        // Start background sync worker real-time upload loop
        syncWorker.startSync(activeSessionId);

        // Actively (re-)inject the floating widget into the recorded tab. The
        // manifest's static content_scripts entry only auto-runs on a fresh
        // navigation, so a tab that was already open before the extension was
        // loaded/reloaded would never get it otherwise. mountRecordingWidget()
        // is idempotent (checks for an existing host), so this is always safe
        // even if the static script already ran.
        if (recordedTabId !== null) {
          await injectRecordingWidget(recordedTabId);
        }

        const startedSession = await getSession(response.data.sessionId);
        broadcastStateChange({
          sessionId: response.data.sessionId,
          status: 'RECORDING',
          chunksRecorded: 0,
          activeCaptureMode: response.data.captureMode as CaptureMode,
          isPaused: false,
          microphoneEnabled: startedSession?.microphoneEnabled ?? true,
          systemAudioEnabled: startedSession?.systemAudioEnabled ?? true,
          hasMicrophone: startedSession?.hasMicrophone ?? false,
          hasSystemAudio: startedSession?.hasSystemAudio ?? false,
        });
      } else {
        await closeOffscreenDocument();
        recordedTabId = null;
        recordedTabIsMeet = false;
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

    case 'PAUSE_RECORDING':
    case 'RESUME_RECORDING':
    case 'SET_MICROPHONE_ENABLED':
    case 'SET_SYSTEM_AUDIO_ENABLED': {
      return await forwardControlActionToOffscreen(message, meta);
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
  const targetSessionId = activeSessionId;
  const hasOffscreen = await hasOffscreenDocument();

  if (!hasOffscreen) {
    logger.warn('No active offscreen document found when requesting stop');
    await reconcileActiveState();
    return {
      success: true,
      data: { sessionId: targetSessionId, status: 'STOPPED' },
      meta,
    };
  }

  const offscreenStopMessage: ExtensionMessage<StopRecordingPayload> = {
    target: 'OFFSCREEN',
    action: 'STOP_RECORDING',
    payload: {
      sessionId: targetSessionId || '',
      reason,
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: meta.requestId,
    },
  };

  const response = (await chrome.runtime.sendMessage(offscreenStopMessage)) as
    | ApiResponse<StopRecordingResponseData>
    | ApiErrorResponse;

  if (response.success) {
    broadcastStateChange({
      sessionId: response.data.sessionId,
      status: 'STOPPED',
      chunksRecorded: response.data.totalChunks,
      activeCaptureMode: 'SCREEN_SYSTEM_MIC',
    });
  }

  // Drain sync worker queue and send final stop manifest to backend
  if (targetSessionId) {
    try {
      await syncWorker.drainQueue(targetSessionId);
      const chunks = await getChunksForSession(targetSessionId);
      const checksums: Record<number, string> = {};
      chunks.forEach((c) => {
        if (c.checksumSha256) {
          checksums[c.sequenceNumber] = c.checksumSha256;
        }
      });

      const stopResponse = await fetch(`${BACKEND_BASE_URL}/api/v1/sessions/${targetSessionId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': 'dev-user-1' },
        body: JSON.stringify({
          totalChunks: chunks.length,
          sequenceChecksums: checksums,
          finalChunkTimestamp: new Date().toISOString(),
        }),
      });

      // The backend's /stop call already synchronously runs finalization (VideoAssembler
      // fold + FFmpeg remux) to completion before responding when every chunk is present —
      // see session.service.ts stopSession(). A `status: 'READY'` here means the final
      // video is already verified and sitting in backend storage, so this is the correct,
      // single point to attempt the local export — never before this signal.
      //
      // Known gap: if chunks were still missing at stop time (WAITING_FOR_CHUNKS), a late
      // chunk finishing the recording later does not re-trigger this automatic export —
      // the user can still trigger it manually from the Local Inspector.
      if (stopResponse.ok && response.success) {
        const stopJson = await stopResponse.json().catch(() => null);
        if (stopJson?.data?.status === 'READY') {
          const sessionRecord = await getSession(targetSessionId);
          const title = sessionRecord?.title || 'Recording';
          const exportOutcome = await exportFinalVideoToLocalFolder(targetSessionId, title, {
            recordedAt: sessionRecord?.createdAt,
          });
          notifyExportOutcomeIfNeeded(exportOutcome);
          response.data.localExport = {
            state: exportOutcome.state,
            folderName: exportOutcome.folderName,
            fileName: exportOutcome.fileName,
            errorMessage: exportOutcome.errorMessage,
          };
        }
      }
    } catch (err) {
      logger.warn('Failed backend /stop handshake (session preserved in IndexedDB):', err);
    }
  }

  // Close offscreen document context after stopping
  await closeOffscreenDocument();
  activeSessionId = null;
  recordedTabId = null;
  recordedTabIsMeet = false;

  return response;
}

// Forwards manual pause/resume/microphone/system-audio control actions to the
// offscreen RecorderService (single source of truth) and broadcasts the resulting
// state so the popup and floating widget stay in sync. Never touches /stop or the
// backend sync flow — those remain owned by executeStopRecording (F-002).
async function forwardControlActionToOffscreen(
  message: ExtensionMessage,
  meta: { timestamp: string; requestId: string }
): Promise<ApiResponse<RecordingControlResponseData> | ApiErrorResponse> {
  if (!activeSessionId) {
    return {
      success: false,
      error: {
        code: 'ERR_NO_ACTIVE_SESSION',
        message: 'No active recording session to control',
      },
      meta,
    };
  }

  const hasOffscreen = await hasOffscreenDocument();
  if (!hasOffscreen) {
    return {
      success: false,
      error: {
        code: 'ERR_OFFSCREEN_NOT_AVAILABLE',
        message: 'Recording engine is not currently available',
      },
      meta,
    };
  }

  const payload = message.payload as
    | SetMicrophoneEnabledPayload
    | SetSystemAudioEnabledPayload
    | Record<string, never>
    | undefined;

  const offscreenMessage: ExtensionMessage = {
    target: 'OFFSCREEN',
    action: message.action,
    payload: { sessionId: activeSessionId, ...payload },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: meta.requestId,
    },
  };

  const response = (await chrome.runtime.sendMessage(offscreenMessage)) as
    | ApiResponse<RecordingControlResponseData>
    | ApiErrorResponse;

  if (response.success) {
    const session = await getSession(response.data.sessionId);
    broadcastStateChange({
      sessionId: response.data.sessionId,
      status: response.data.status,
      chunksRecorded: session?.totalChunks || 0,
      activeCaptureMode: session?.captureMode || 'SCREEN_SYSTEM_MIC',
      isPaused: response.data.isPaused,
      microphoneEnabled: response.data.microphoneEnabled,
      systemAudioEnabled: response.data.systemAudioEnabled,
      hasMicrophone: response.data.hasMicrophone,
      hasSystemAudio: response.data.hasSystemAudio,
    });
  }

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

const RECORDING_WIDGET_SCRIPT_PATH = 'src/content/recording-widget.js';

// Explicitly injects the floating recording-control widget into the tab being
// recorded. Chrome's manifest-declared content_scripts only auto-run on a
// fresh navigation of a matching URL — a tab that was already open before the
// extension was installed/reloaded never gets it that way. This makes
// injection an explicit step of the recording-start sequence instead of a
// passive side effect of page-load timing.
async function injectRecordingWidget(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:\/\//.test(tab.url)) {
      // chrome://, chrome-extension://, the Web Store, etc. cannot host content
      // scripts; recording still proceeds without the floating control there.
      logger.warn(
        `[ServiceWorker] Skipping recording widget injection: tab ${tabId} is not an injectable http(s) page (url=${tab.url ?? 'unknown'})`
      );
      return;
    }

    logger.info(`[ServiceWorker] Injecting recording widget into tab ${tabId} (${tab.url})`);
    // recording-widget.js is an ES module (it has `import` statements pulling
    // in shared bundle chunks). chrome.scripting.executeScript's `files`
    // option always runs the file as a classic script, which throws
    // "Cannot use import statement outside a module" for a module bundle.
    // Injecting a small classic-script function that dynamically imports the
    // module URL is the supported way to run module code this way; the
    // target files are declared in web_accessible_resources so the page can
    // fetch them.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: (widgetUrl: string) => {
        import(widgetUrl);
      },
      args: [chrome.runtime.getURL(RECORDING_WIDGET_SCRIPT_PATH)],
    });
    logger.info(`[ServiceWorker] Recording widget injection succeeded for tab ${tabId}`);
  } catch (err) {
    // Non-fatal: recording continues even if the floating control couldn't be
    // injected (e.g. tab navigated away or closed between identification and
    // injection). The static content_scripts entry still covers the common
    // case of a fresh page load.
    logger.warn(`[ServiceWorker] Recording widget injection failed for tab ${tabId}:`, err);
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
      syncWorker.startSync(activeSessionId);
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

  // Reaches the popup/inspector if either is open (real extension pages).
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup or Inspector might not be open to receive message; swallow harmlessly
  });

  // chrome.runtime.sendMessage never reaches content scripts — that's a
  // documented Chrome API restriction ("extensions cannot send messages to
  // content scripts using this method"), not an oversight. The floating
  // widget is a content script that may be mounted in several tabs at once,
  // so each tab needs an explicit tabs.sendMessage push to stay in sync
  // (e.g. to hide itself the moment recording stops, or reflect a mic/pause
  // toggle made from another tab or the popup).
  chrome.tabs
    .query({})
    .then((tabs) => {
      tabs.forEach((tab) => {
        if (tab.id === undefined) return;
        chrome.tabs.sendMessage(tab.id, message).catch(() => {
          // No widget listening in this tab (restricted page, not yet
          // injected, no recording ever started there, ...); harmless.
        });
      });
    })
    .catch((err) => logger.warn('[ServiceWorker] Failed to query tabs for state broadcast:', err));
}
