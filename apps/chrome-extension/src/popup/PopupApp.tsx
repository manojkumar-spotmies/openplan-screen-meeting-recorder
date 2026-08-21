import React, { useState, useEffect } from 'react';
import {
  ExtensionMessage,
  StartRecordingPayload,
  StopRecordingPayload,
  StopRecordingResponseData,
  RecordingStateChangedPayload,
  RecordingControlResponseData,
  SessionStatus,
  CaptureMode,
  LocalVideoSession,
  LocalExportSummary,
  ApiResponse,
  ApiErrorResponse,
} from '@openplan/contracts';
import { getStoredDirectoryHandle } from '../modules/local-storage-settings/directory-handle-store.js';
import { checkStoredPermission, isFileSystemAccessSupported } from '../modules/local-storage-settings/folder-access.js';

function sendServiceWorkerMessage<T>(
  action: ExtensionMessage['action'],
  payload: unknown = {}
): Promise<ApiResponse<T> | ApiErrorResponse> {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('Extension messaging is unavailable'));
      return;
    }

    const message: ExtensionMessage = {
      target: 'SERVICE_WORKER',
      action,
      payload,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: crypto.randomUUID(),
      },
    };

    chrome.runtime.sendMessage(message, (response: ApiResponse<T> | ApiErrorResponse) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

export const PopupApp: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>('IDLE');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('SCREEN_SYSTEM_MIC');
  const [durationSeconds, setDurationSeconds] = useState<number>(0);
  const [totalChunks, setTotalChunks] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [microphoneEnabled, setMicrophoneEnabled] = useState<boolean>(true);
  const [systemAudioEnabled, setSystemAudioEnabled] = useState<boolean>(true);
  const [hasMicrophone, setHasMicrophone] = useState<boolean>(false);
  const [hasSystemAudio, setHasSystemAudio] = useState<boolean>(false);
  const [controlPending, setControlPending] = useState<boolean>(false);
  // Wall-clock anchor (ms) for the currently recording session's start. Duration
  // is derived from this on every tick rather than incremented locally, so
  // reopening the popup mid-recording shows the real elapsed time instead of
  // restarting from zero (the session's own `durationSeconds` field is only
  // ever written once, at stop time).
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [localExport, setLocalExport] = useState<LocalExportSummary | null>(null);
  // Non-prompting check only — chrome.notifications and Settings' own "Grant Permission"
  // button are the only places that actually re-request permission (requestPermission()
  // needs a live user gesture, and popups are too unstable to trigger a browser dialog
  // reliably: they can lose focus and get torn down by Chrome the instant one tries to
  // render, killing the request silently mid-await). This just warns before you start
  // recording instead of finding out afterward, and points at the one place that works.
  const [folderPermissionWarning, setFolderPermissionWarning] = useState<{
    name: string;
    state: 'needs-permission' | 'denied';
  } | null>(null);

  // Poll/Fetch session status on popup open
  useEffect(() => {
    fetchSessionStatus();

    // Listen for runtime state updates
    const messageListener = (message: ExtensionMessage) => {
      if (message.action === 'RECORDING_STATE_CHANGED') {
        const payload = message.payload as RecordingStateChangedPayload;
        setStatus(payload.status);
        setSessionId(payload.sessionId);
        setTotalChunks(payload.chunksRecorded);
        setCaptureMode(payload.activeCaptureMode);
        setMicrophoneEnabled(payload.microphoneEnabled ?? true);
        setSystemAudioEnabled(payload.systemAudioEnabled ?? true);
        setHasMicrophone(Boolean(payload.hasMicrophone));
        setHasSystemAudio(Boolean(payload.hasSystemAudio));
        if (payload.errorMessage) {
          setErrorMessage(payload.errorMessage);
        }
      }
    };

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(messageListener);
    }

    return () => {
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(messageListener);
      }
    };
  }, []);

  // Warn before recording starts, rather than the user only finding out afterward via
  // Settings. Read-only — never calls requestPermission() (see the state's own comment).
  useEffect(() => {
    if (!isFileSystemAccessSupported()) return;

    (async () => {
      try {
        const folderHandle = await getStoredDirectoryHandle();
        if (!folderHandle) {
          setFolderPermissionWarning(null);
          return;
        }
        const permission = await checkStoredPermission(folderHandle);
        if (permission === 'needs-permission' || permission === 'denied') {
          setFolderPermissionWarning({ name: folderHandle.name, state: permission });
        } else {
          setFolderPermissionWarning(null);
        }
      } catch (err) {
        console.warn('Failed to check local folder permission:', err);
      }
    })();
  }, []);

  // Duration timer during RECORDING state. Recomputed from sessionStartedAt on
  // every tick (not incremented locally) so it's always correct even though
  // the popup document is torn down and rebuilt from scratch every time it's
  // closed and reopened mid-recording.
  useEffect(() => {
    if (status !== 'RECORDING' || sessionStartedAt === null) {
      if (status === 'IDLE') setDurationSeconds(0);
      return;
    }
    const tick = () => setDurationSeconds(Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000)));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [status, sessionStartedAt]);

  const fetchSessionStatus = () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;

    const message: ExtensionMessage = {
      target: 'SERVICE_WORKER',
      action: 'GET_SESSION_STATUS',
      payload: {},
      meta: {
        timestamp: new Date().toISOString(),
        requestId: crypto.randomUUID(),
      },
    };

    chrome.runtime.sendMessage(
      message,
      (response: ApiResponse<LocalVideoSession | null> | ApiErrorResponse) => {
        if (response && response.success && response.data) {
          const session = response.data;
          setStatus(session.status);
          setSessionId(session.sessionId);
          setCaptureMode(session.captureMode);
          setTotalChunks(session.totalChunks || 0);
          if (session.status === 'RECORDING') {
            setSessionStartedAt(new Date(session.createdAt).getTime());
          } else {
            setDurationSeconds(Math.round(session.durationSeconds || 0));
          }
          setMicrophoneEnabled(session.microphoneEnabled ?? true);
          setSystemAudioEnabled(session.systemAudioEnabled ?? true);
          setHasMicrophone(Boolean(session.hasMicrophone));
          setHasSystemAudio(Boolean(session.hasSystemAudio));
          if (session.errorMessage) {
            setErrorMessage(session.errorMessage);
          }
        }
      }
    );
  };

  const handleStartRecording = async () => {
    setInfoMessage(null);
    setErrorMessage(null);
    setLocalExport(null);
    setStatus('REQUESTING_PERMISSIONS');

    // Request microphone permission from visible extension Popup UI context
    // so Chrome displays the origin permission prompt to the user if not granted.
    if (typeof navigator !== 'undefined' && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      try {
        const micPermissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Immediately release temporary permission-check tracks
        micPermissionStream.getTracks().forEach((track) => track.stop());
      } catch (err) {
        // If microphone permission is denied, blocked, or device unavailable,
        // log warning and continue so recording proceeds gracefully degraded (E-02).
        console.warn('Microphone permission prompt denied or unavailable in popup context:', err);
      }
    }

    const message: ExtensionMessage<StartRecordingPayload> = {
      target: 'SERVICE_WORKER',
      action: 'START_RECORDING',
      payload: {
        title: 'Meeting Recording',
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId: crypto.randomUUID(),
      },
    };

    chrome.runtime.sendMessage(
      message,
      (response: ApiResponse<{ sessionId: string; status: SessionStatus; captureMode: CaptureMode }> | ApiErrorResponse) => {
        if (!response) {
          setStatus('IDLE');
          setErrorMessage('No response received from extension service worker');
          return;
        }

        if (response.success) {
          setStatus('RECORDING');
          setSessionId(response.data.sessionId);
          setCaptureMode(response.data.captureMode);
          setSessionStartedAt(Date.now());
        } else {
          setStatus('IDLE');
          if (response.error?.code === 'ERR_SCREEN_CANCELLED') {
            setInfoMessage('Screen share cancelled by user');
          } else {
            setErrorMessage(response.error?.message || 'Failed to start recording');
          }
        }
      }
    );
  };

  const handleStopRecording = () => {
    setStatus('STOPPING');

    const message: ExtensionMessage<StopRecordingPayload> = {
      target: 'SERVICE_WORKER',
      action: 'STOP_RECORDING',
      payload: {
        sessionId: sessionId || '',
        reason: 'USER_ACTION',
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId: crypto.randomUUID(),
      },
    };

    chrome.runtime.sendMessage(
      message,
      (response: ApiResponse<StopRecordingResponseData> | ApiErrorResponse) => {
        if (response && response.success) {
          setStatus('STOPPED');
          setTotalChunks(response.data.totalChunks);
          setDurationSeconds(Math.round(response.data.durationSeconds));
          setSessionStartedAt(null);
          setLocalExport(response.data.localExport || null);
        } else {
          setStatus('ERROR');
          setErrorMessage(response?.error?.message || 'Failed to stop recording cleanly');
        }
      }
    );
  };

  const runControlAction = async (
    action: ExtensionMessage['action'],
    payload: unknown,
    failureMessage: string
  ) => {
    if (controlPending) return;
    setControlPending(true);
    setErrorMessage(null);
    try {
      const response = await sendServiceWorkerMessage<RecordingControlResponseData>(action, payload);
      if (!response.success) {
        setErrorMessage(response.error?.message || failureMessage);
        return;
      }
      setStatus(response.data.status);
      setMicrophoneEnabled(response.data.microphoneEnabled);
      setSystemAudioEnabled(response.data.systemAudioEnabled);
      setHasMicrophone(response.data.hasMicrophone);
      setHasSystemAudio(response.data.hasSystemAudio);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : failureMessage);
    } finally {
      setControlPending(false);
    }
  };

  const handleToggleMicrophone = () =>
    runControlAction(
      'SET_MICROPHONE_ENABLED',
      { sessionId, enabled: !microphoneEnabled },
      'Failed to toggle microphone'
    );

  const handleToggleSystemAudio = () =>
    runControlAction(
      'SET_SYSTEM_AUDIO_ENABLED',
      { sessionId, enabled: !systemAudioEnabled },
      'Failed to toggle system audio'
    );

  const openInspector = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/inspector/index.html') });
    }
  };

  const openSettings = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/settings/index.html') });
    }
  };

  const formatTime = (totalSecs: number) => {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div style={{ padding: '16px', fontFamily: 'sans-serif', maxWidth: '360px' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Openplan Recorder</h2>
        <span
          style={{
            fontSize: '11px',
            padding: '2px 8px',
            borderRadius: '12px',
            background: status === 'RECORDING' ? '#ef4444' : '#3b82f6',
            color: '#ffffff',
            fontWeight: 'bold',
          }}
        >
          {status}
        </span>
      </header>

      {infoMessage && (
        <div style={{ padding: '8px 12px', background: '#3b82f620', border: '1px solid #3b82f6', color: '#60a5fa', borderRadius: '6px', fontSize: '12px', marginBottom: '12px' }}>
          ℹ️ {infoMessage}
        </div>
      )}

      {errorMessage && (
        <div style={{ padding: '8px 12px', background: '#ef444420', border: '1px solid #ef4444', color: '#f87171', borderRadius: '6px', fontSize: '12px', marginBottom: '12px' }}>
          ⚠️ {errorMessage}
        </div>
      )}

      {status === 'IDLE' && (
        <div>
          {folderPermissionWarning && (
            <div
              style={{
                padding: '8px 12px',
                background: '#eab30820',
                border: '1px solid #eab308',
                color: '#fde047',
                borderRadius: '6px',
                fontSize: '12px',
                marginBottom: '12px',
              }}
            >
              <div style={{ marginBottom: '6px' }}>
                ⚠ Local folder &quot;{folderPermissionWarning.name}&quot;{' '}
                {folderPermissionWarning.state === 'denied'
                  ? 'access was denied'
                  : 'needs permission'}{' '}
                — recordings won&apos;t be saved there until you fix this in Settings.
              </div>
              <button
                onClick={openSettings}
                style={{
                  padding: '5px 10px',
                  background: '#eab308',
                  color: '#1e293b',
                  border: 'none',
                  borderRadius: '5px',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Open Storage Settings
              </button>
            </div>
          )}
          <p style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '16px' }}>
            Local-first screen, system audio, and microphone recorder.
          </p>
          <button
            onClick={handleStartRecording}
            style={{
              width: '100%',
              padding: '10px 16px',
              background: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontWeight: 600,
              cursor: 'pointer',
              marginBottom: '8px',
            }}
          >
            Start Recording
          </button>
          <button
            onClick={openInspector}
            style={{
              width: '100%',
              padding: '8px 16px',
              background: 'transparent',
              color: '#94a3b8',
              border: '1px solid #475569',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer',
              marginBottom: '8px',
            }}
          >
            Open Local Inspector
          </button>
          <button
            onClick={openSettings}
            style={{
              width: '100%',
              padding: '8px 16px',
              background: 'transparent',
              color: '#94a3b8',
              border: '1px solid #475569',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Storage Settings
          </button>
        </div>
      )}

      {status === 'REQUESTING_PERMISSIONS' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>Requesting Capture Permissions...</div>
          <p style={{ fontSize: '12px', color: '#94a3b8' }}>Please select the screen/window to share in the Chrome prompt.</p>
        </div>
      )}

      {status === 'RECORDING' && (
        <div style={{ padding: '12px 16px', background: '#3b82f615', border: '1px solid #3b82f640', borderRadius: '8px', textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '6px' }}>
            <span
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: '#ef4444',
              }}
            />
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#38bdf8' }}>Recording in progress</span>
          </div>
          <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#94a3b8', lineHeight: '1.4' }}>
            Duration: {formatTime(durationSeconds)}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleToggleMicrophone}
                disabled={controlPending || !hasMicrophone}
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  background: '#1e293b',
                  color: hasMicrophone ? '#e2e8f0' : '#64748b',
                  border: '1px solid #334155',
                  borderRadius: '6px',
                  fontSize: '12px',
                  cursor: controlPending || !hasMicrophone ? 'default' : 'pointer',
                  opacity: controlPending || !hasMicrophone ? 0.6 : 1,
                }}
              >
                {microphoneEnabled ? '🎙 Mic On' : '🔇 Mic Off'}
              </button>
              <button
                onClick={handleToggleSystemAudio}
                disabled={controlPending || !hasSystemAudio}
                style={{
                  flex: 1,
                  padding: '8px 10px',
                  background: '#1e293b',
                  color: hasSystemAudio ? '#e2e8f0' : '#64748b',
                  border: '1px solid #334155',
                  borderRadius: '6px',
                  fontSize: '12px',
                  cursor: controlPending || !hasSystemAudio ? 'default' : 'pointer',
                  opacity: controlPending || !hasSystemAudio ? 0.6 : 1,
                }}
              >
                {systemAudioEnabled ? '🔊 Audio On' : '🔇 Audio Off'}
              </button>
            </div>

            <button
              onClick={handleStopRecording}
              disabled={controlPending}
              style={{
                width: '100%',
                padding: '8px 16px',
                background: '#ef444420',
                color: '#f87171',
                border: '1px solid #ef4444',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: controlPending ? 'default' : 'pointer',
                opacity: controlPending ? 0.6 : 1,
              }}
            >
              ⏹ Stop Recording
            </button>
          </div>
        </div>
      )}

      {(status === 'STOPPING' || status === 'FINALIZING') && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: '8px' }}>Finalizing Local Recording...</div>
          <p style={{ fontSize: '12px', color: '#94a3b8' }}>Saving final chunks to IndexedDB offline store.</p>
        </div>
      )}

      {status === 'STOPPED' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: '16px' }}>
            <div style={{ fontSize: '28px', marginBottom: '4px' }}>✅</div>
            <h3 style={{ margin: '0 0 4px 0', fontSize: '16px' }}>Recording Completed</h3>
            <p style={{ margin: 0, fontSize: '12px', color: '#94a3b8' }}>
              Duration: {formatTime(durationSeconds)} | Total Chunks: {totalChunks}
            </p>
          </div>

          {renderLocalExportStatus(localExport)}

          <button
            onClick={openInspector}
            style={{
              width: '100%',
              padding: '10px 16px',
              background: '#16a34a',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontWeight: 600,
              cursor: 'pointer',
              marginBottom: '8px',
            }}
          >
            Open Local Inspector & Player
          </button>

          <button
            onClick={() => setStatus('IDLE')}
            style={{
              width: '100%',
              padding: '8px 16px',
              background: 'transparent',
              color: '#94a3b8',
              border: '1px solid #475569',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Start New Recording
          </button>
        </div>
      )}

      {status === 'ERROR' && (
        <div>
          <button
            onClick={() => setStatus('IDLE')}
            style={{
              width: '100%',
              padding: '8px 16px',
              background: '#475569',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '12px',
              cursor: 'pointer',
            }}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
};

// Reports what happened when the just-completed recording's final video was exported to
// the user's selected local folder (Step 2B) — separate from recording/session status, so
// a failed export never implies the recording itself failed. Renders nothing while no
// export was attempted at all (e.g. the backend hadn't finished finalizing by /stop time).
function renderLocalExportStatus(localExport: LocalExportSummary | null): React.ReactNode {
  if (!localExport || localExport.state === 'NOT_ATTEMPTED') {
    return null;
  }

  const boxStyle: React.CSSProperties = {
    padding: '8px 12px',
    borderRadius: '6px',
    fontSize: '12px',
    marginBottom: '12px',
  };

  switch (localExport.state) {
    case 'COMPLETED':
      return (
        <div style={{ ...boxStyle, background: '#16a34a20', border: '1px solid #16a34a', color: '#4ade80' }}>
          ✓ Saved to: {localExport.folderName}
          {localExport.fileName ? <div style={{ marginTop: '2px', color: '#bbf7d0' }}>File: {localExport.fileName}</div> : null}
        </div>
      );
    case 'NO_FOLDER':
      return (
        <div style={{ ...boxStyle, background: '#eab30820', border: '1px solid #eab308', color: '#fde047' }}>
          ⚠ Local folder not configured
        </div>
      );
    case 'NEEDS_PERMISSION':
      return (
        <div style={{ ...boxStyle, background: '#eab30820', border: '1px solid #eab308', color: '#fde047' }}>
          ⚠ Local folder permission required. Open Storage Settings to grant it.
        </div>
      );
    case 'PERMISSION_DENIED':
      return (
        <div style={{ ...boxStyle, background: '#ef444420', border: '1px solid #ef4444', color: '#f87171' }}>
          ⚠ Could not save to local folder: permission was denied.
        </div>
      );
    case 'FOLDER_UNAVAILABLE':
      return (
        <div style={{ ...boxStyle, background: '#ef444420', border: '1px solid #ef4444', color: '#f87171' }}>
          ⚠ Recording folder is unavailable. Choose a new one in Storage Settings.
        </div>
      );
    case 'FAILED':
    default:
      return (
        <div style={{ ...boxStyle, background: '#ef444420', border: '1px solid #ef4444', color: '#f87171' }}>
          ⚠ Could not save to local folder. The recording itself is safe — retry from the Local Inspector.
        </div>
      );
  }
}
