import React, { useState, useEffect } from 'react';
import {
  ExtensionMessage,
  StartRecordingPayload,
  RecordingStateChangedPayload,
  SessionStatus,
  CaptureMode,
  LocalVideoSession,
  LocalExportSummary,
  ApiResponse,
  ApiErrorResponse,
} from '@openplan/contracts';
import { getStoredDirectoryHandle } from '../modules/local-storage-settings/directory-handle-store.js';
import { checkStoredPermission, isFileSystemAccessSupported } from '../modules/local-storage-settings/folder-access.js';
import { checkMicPermission } from '../modules/mic-permission/mic-access.js';

// Presentational tokens only — no functional/business meaning. Matches the
// palette used in LocalInspector.tsx and the mic/storage status widgets.
const COLORS = {
  bg: '#f8fafc',
  surface: '#ffffff',
  border: '#e5e7eb',
  textPrimary: '#0f172a',
  textSecondary: '#64748b',
  accent: '#2563eb',
  accentSoft: '#eff6ff',
  success: '#16a34a',
  successSoft: '#f0fdf4',
  danger: '#dc2626',
  dangerSoft: '#fef2f2',
  warn: '#b45309',
  warnSoft: '#fffbeb',
} as const;

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 16px',
  background: COLORS.accent,
  color: '#ffffff',
  border: 'none',
  borderRadius: '8px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
  marginBottom: '8px',
};

const secondaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 16px',
  background: COLORS.surface,
  color: COLORS.textSecondary,
  border: `1px solid ${COLORS.border}`,
  borderRadius: '8px',
  fontSize: '12.5px',
  fontWeight: 600,
  cursor: 'pointer',
  marginBottom: '8px',
};

const StatusBadge: React.FC<{ tone: 'info' | 'success' | 'warn' | 'error' | 'neutral'; children: React.ReactNode }> = ({
  tone,
  children,
}) => {
  const palette = {
    info: { bg: COLORS.accentSoft, color: COLORS.accent, border: '#bfdbfe' },
    success: { bg: COLORS.successSoft, color: COLORS.success, border: '#bbf7d0' },
    warn: { bg: COLORS.warnSoft, color: COLORS.warn, border: '#fde68a' },
    error: { bg: COLORS.dangerSoft, color: COLORS.danger, border: '#fecaca' },
    neutral: { bg: '#f1f5f9', color: COLORS.textSecondary, border: '#e2e8f0' },
  }[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 10px',
        borderRadius: '999px',
        background: palette.bg,
        color: palette.color,
        border: `1px solid ${palette.border}`,
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.02em',
        lineHeight: 1.4,
      }}
    >
      {children}
    </span>
  );
};

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
  // Same non-prompting-check rationale as folderPermissionWarning above: mic permission
  // can only actually be (re-)granted from the Local Inspector's real, stable tab, so this
  // just surfaces whether it's missing — it never calls requestMicPermission() itself.
  const [micPermissionWarning, setMicPermissionWarning] = useState<{
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

  // Same rationale as the folder-permission effect above.
  useEffect(() => {
    (async () => {
      try {
        const micState = await checkMicPermission();
        if (micState === 'needs-permission' || micState === 'denied') {
          setMicPermissionWarning({ state: micState });
        } else {
          setMicPermissionWarning(null);
        }
      } catch (err) {
        console.warn('Failed to check microphone permission:', err);
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

    // requestMicPermission() itself is still never called from here — extension popups can
    // be torn down or lose focus mid-prompt, causing Chrome to auto-dismiss it (NotAllowedError:
    // "Permission dismissed") without ever really asking the user. But this non-prompting
    // *check* is safe to run here, and lets us redirect to the Local Inspector (a real,
    // stable tab that can actually show the grant dialog) up front instead of silently
    // starting a recording with no microphone audio.
    const micState = await checkMicPermission();
    if (micState === 'needs-permission' || micState === 'denied') {
      setMicPermissionWarning({ state: micState });
      setInfoMessage('Microphone access is required before recording — grant it in the Local Inspector, then try again.');
      openInspector();
      return;
    }

    setStatus('REQUESTING_PERMISSIONS');

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

  const openInspector = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/inspector/index.html') });
    }
  };

  const formatTime = (totalSecs: number) => {
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const statusBadge = () => {
    switch (status) {
      case 'IDLE':
        return <StatusBadge tone="info">IDLE</StatusBadge>;
      case 'REQUESTING_PERMISSIONS':
        return <StatusBadge tone="neutral">REQUESTING…</StatusBadge>;
      case 'RECORDING':
        return (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              padding: '3px 10px',
              borderRadius: '999px',
              background: COLORS.dangerSoft,
              color: COLORS.danger,
              border: '1px solid #fecaca',
              fontSize: '11px',
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}
          >
            <span
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: COLORS.danger,
                animation: 'openplan-popup-pulse 1.6s ease-in-out infinite',
              }}
            />
            RECORDING
          </span>
        );
      case 'STOPPING':
      case 'FINALIZING':
        return <StatusBadge tone="neutral">FINALIZING…</StatusBadge>;
      case 'STOPPED':
        return <StatusBadge tone="success">COMPLETED</StatusBadge>;
      case 'ERROR':
        return <StatusBadge tone="error">ERROR</StatusBadge>;
      default:
        return <StatusBadge tone="neutral">{status}</StatusBadge>;
    }
  };

  return (
    <div
      style={{
        padding: '18px',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        width: '340px',
        background: COLORS.bg,
        color: COLORS.textPrimary,
        boxSizing: 'border-box',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600, letterSpacing: '-0.01em', color: COLORS.textPrimary }}>
          Openplan Recorder
        </h2>
        {statusBadge()}
      </header>

      {infoMessage && (
        <div
          style={{
            display: 'flex',
            gap: '6px',
            padding: '8px 12px',
            background: COLORS.accentSoft,
            border: '1px solid #bfdbfe',
            color: '#1d4ed8',
            borderRadius: '8px',
            fontSize: '12px',
            marginBottom: '12px',
            lineHeight: 1.4,
          }}
        >
          <span>ℹ</span>
          <span>{infoMessage}</span>
        </div>
      )}

      {errorMessage && (
        <div
          style={{
            display: 'flex',
            gap: '6px',
            padding: '8px 12px',
            background: COLORS.dangerSoft,
            border: '1px solid #fecaca',
            color: '#b91c1c',
            borderRadius: '8px',
            fontSize: '12px',
            marginBottom: '12px',
            lineHeight: 1.4,
          }}
        >
          <span>⚠</span>
          <span>{errorMessage}</span>
        </div>
      )}

      {status === 'IDLE' && (
        <div>
          {folderPermissionWarning && (
            <div
              style={{
                padding: '10px 12px',
                background: COLORS.warnSoft,
                border: '1px solid #fde68a',
                color: '#92400e',
                borderRadius: '8px',
                fontSize: '12px',
                marginBottom: '12px',
                lineHeight: 1.4,
              }}
            >
              <div style={{ marginBottom: '8px' }}>
                ⚠ Local folder &quot;{folderPermissionWarning.name}&quot;{' '}
                {folderPermissionWarning.state === 'denied'
                  ? 'access was denied'
                  : 'needs permission'}{' '}
                — recordings won&apos;t be saved there until you fix this in the Local Inspector.
              </div>
              <button
                onClick={openInspector}
                style={{
                  padding: '5px 10px',
                  background: '#ffffff',
                  color: '#92400e',
                  border: '1px solid #fde68a',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Open Local Inspector
              </button>
            </div>
          )}
          {micPermissionWarning && (
            <div
              style={{
                padding: '10px 12px',
                background: COLORS.warnSoft,
                border: '1px solid #fde68a',
                color: '#92400e',
                borderRadius: '8px',
                fontSize: '12px',
                marginBottom: '12px',
                lineHeight: 1.4,
              }}
            >
              <div style={{ marginBottom: '8px' }}>
                ⚠ Microphone access {micPermissionWarning.state === 'denied' ? 'was denied' : 'has not been granted'} —
                recordings will have no microphone audio until you grant it in the Local Inspector.
              </div>
              <button
                onClick={openInspector}
                style={{
                  padding: '5px 10px',
                  background: '#ffffff',
                  color: '#92400e',
                  border: '1px solid #fde68a',
                  borderRadius: '6px',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Grant Microphone Access
              </button>
            </div>
          )}
          <p style={{ fontSize: '13px', color: COLORS.textSecondary, marginBottom: '16px', lineHeight: 1.5 }}>
            Record your screen, audio, and mic in one click.
          </p>
          <button onClick={handleStartRecording} style={primaryButtonStyle}>
            Start Recording
          </button>
          <button onClick={openInspector} style={secondaryButtonStyle}>
            Open Local Inspector
          </button>
        </div>
      )}

      {status === 'REQUESTING_PERMISSIONS' && (
        <div style={{ textAlign: 'center', padding: '28px 0' }}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '6px' }}>
            Requesting Capture Permissions…
          </div>
          <p style={{ fontSize: '12px', color: COLORS.textSecondary, margin: 0 }}>
            Please select the screen/window to share in the Chrome prompt.
          </p>
        </div>
      )}

      {status === 'RECORDING' && (
        <div
          style={{
            padding: '16px',
            background: COLORS.surface,
            border: `1px solid ${COLORS.border}`,
            borderRadius: '10px',
            textAlign: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '6px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: COLORS.danger,
                animation: 'openplan-popup-pulse 1.6s ease-in-out infinite',
              }}
            />
            <span style={{ fontSize: '13px', fontWeight: 600, color: COLORS.textPrimary }}>Recording in progress</span>
          </div>
          <p style={{ margin: '0 0 4px 0', fontSize: '12px', color: COLORS.textSecondary, lineHeight: 1.4 }}>
            Duration: {formatTime(durationSeconds)}
          </p>
          <p style={{ margin: 0, fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
            Use the floating control on the recorded page to mute mic/audio or stop recording.
          </p>
        </div>
      )}

      {(status === 'STOPPING' || status === 'FINALIZING') && (
        <div style={{ textAlign: 'center', padding: '28px 0' }}>
          <div style={{ fontSize: '13.5px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '6px' }}>
            Finalizing Local Recording…
          </div>
          <p style={{ fontSize: '12px', color: COLORS.textSecondary, margin: 0 }}>
            Saving final chunks to IndexedDB offline store.
          </p>
        </div>
      )}

      {status === 'STOPPED' && (
        <div>
          <div style={{ textAlign: 'center', marginBottom: '16px' }}>
            <div
              style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                background: COLORS.successSoft,
                border: '1px solid #bbf7d0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto 8px',
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={COLORS.success} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: 600, color: COLORS.textPrimary }}>Recording Completed</h3>
            <p style={{ margin: 0, fontSize: '12px', color: COLORS.textSecondary }}>
              Duration: {formatTime(durationSeconds)} · {totalChunks} chunks
            </p>
          </div>

          {renderLocalExportStatus(localExport)}

          <button onClick={openInspector} style={primaryButtonStyle}>
            Open Local Inspector & Player
          </button>

          <button onClick={() => setStatus('IDLE')} style={{ ...secondaryButtonStyle, marginBottom: 0 }}>
            Start New Recording
          </button>
        </div>
      )}

      {status === 'ERROR' && (
        <div>
          <button onClick={() => setStatus('IDLE')} style={{ ...secondaryButtonStyle, marginBottom: 0 }}>
            Reset
          </button>
        </div>
      )}

      <style>{`
        @keyframes openplan-popup-pulse {
          0% { opacity: 1; }
          50% { opacity: 0.35; }
          100% { opacity: 1; }
        }
      `}</style>
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
    padding: '9px 12px',
    borderRadius: '8px',
    fontSize: '12px',
    marginBottom: '12px',
    lineHeight: 1.4,
  };

  switch (localExport.state) {
    case 'COMPLETED':
      return (
        <div style={{ ...boxStyle, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#16a34a' }}>
          ✓ Saved to: {localExport.folderName}
          {localExport.fileName ? <div style={{ marginTop: '2px', color: '#15803d' }}>File: {localExport.fileName}</div> : null}
        </div>
      );
    case 'NO_FOLDER':
      return (
        <div style={{ ...boxStyle, background: '#fffbeb', border: '1px solid #fde68a', color: '#b45309' }}>
          ⚠ Local folder not configured
        </div>
      );
    case 'NEEDS_PERMISSION':
      return (
        <div style={{ ...boxStyle, background: '#fffbeb', border: '1px solid #fde68a', color: '#b45309' }}>
          ⚠ Local folder permission required. Open Storage Settings to grant it.
        </div>
      );
    case 'PERMISSION_DENIED':
      return (
        <div style={{ ...boxStyle, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626' }}>
          ⚠ Could not save to local folder: permission was denied.
        </div>
      );
    case 'FOLDER_UNAVAILABLE':
      return (
        <div style={{ ...boxStyle, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626' }}>
          ⚠ Recording folder is unavailable. Choose a new one in Storage Settings.
        </div>
      );
    case 'FAILED':
    default:
      return (
        <div style={{ ...boxStyle, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626' }}>
          ⚠ Could not save to local folder. The recording itself is safe — retry from the Local Inspector.
        </div>
      );
  }
}
