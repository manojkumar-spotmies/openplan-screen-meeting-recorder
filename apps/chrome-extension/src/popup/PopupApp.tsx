import React, { useState, useEffect } from 'react';
import {
  ExtensionMessage,
  StartRecordingPayload,
  StopRecordingPayload,
  RecordingStateChangedPayload,
  SessionStatus,
  CaptureMode,
  LocalVideoSession,
  ApiResponse,
  ApiErrorResponse,
} from '@openplan/contracts';

export const PopupApp: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>('IDLE');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [captureMode, setCaptureMode] = useState<CaptureMode>('SCREEN_SYSTEM_MIC');
  const [durationSeconds, setDurationSeconds] = useState<number>(0);
  const [totalChunks, setTotalChunks] = useState<number>(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

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

  // Duration timer during RECORDING state
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (status === 'RECORDING') {
      interval = setInterval(() => {
        setDurationSeconds((prev) => prev + 1);
      }, 1000);
    } else if (status === 'IDLE') {
      setDurationSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [status]);

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
          setDurationSeconds(Math.round(session.durationSeconds || 0));
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
      (response: ApiResponse<{ sessionId: string; status: SessionStatus; totalChunks: number; durationSeconds: number }> | ApiErrorResponse) => {
        if (response && response.success) {
          setStatus('STOPPED');
          setTotalChunks(response.data.totalChunks);
          setDurationSeconds(Math.round(response.data.durationSeconds));
        } else {
          setStatus('ERROR');
          setErrorMessage(response?.error?.message || 'Failed to stop recording cleanly');
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
            }}
          >
            Open Local Inspector
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
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '16px' }}>
            <span style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#ef4444', animation: 'pulse 1s infinite' }} />
            <span style={{ fontSize: '24px', fontWeight: 'bold', fontFamily: 'monospace' }}>{formatTime(durationSeconds)}</span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#94a3b8', marginBottom: '12px' }}>
            <span>Chunks Recorded: <strong>{totalChunks}</strong></span>
            <span>Mode: <strong>{captureMode}</strong></span>
          </div>

          {(captureMode === 'SCREEN_SYSTEM' || captureMode === 'SCREEN_ONLY') && (
            <div style={{ padding: '6px 10px', background: '#eab30820', border: '1px solid #eab308', color: '#fde047', borderRadius: '4px', fontSize: '11px', marginBottom: '12px' }}>
              ⚠️ Mic not enabled ({captureMode === 'SCREEN_SYSTEM' ? 'System Audio only' : 'Screen only'}).
            </div>
          )}
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
