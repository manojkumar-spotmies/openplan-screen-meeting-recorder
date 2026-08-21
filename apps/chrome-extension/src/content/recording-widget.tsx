import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import {
  ExtensionMessage,
  RecordingStateChangedPayload,
  LocalVideoSession,
  ApiResponse,
  ApiErrorResponse,
  RecordingControlResponseData,
} from '@openplan/contracts';
import { logger } from '@openplan/core';

/**
 * Small floating recording control widget injected into Google Meet tabs.
 * Renders only while a recording session is active; RecorderService (via the
 * service worker/offscreen document) remains the single source of truth —
 * this component never maintains its own independent recording state.
 */

interface WidgetState {
  sessionId: string;
  status: LocalVideoSession['status'];
  microphoneEnabled: boolean;
  systemAudioEnabled: boolean;
  hasMicrophone: boolean;
  hasSystemAudio: boolean;
}

function sendExtensionMessage<T>(
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

const CONTROL_ACTION_LOG_LABEL: Partial<Record<ExtensionMessage['action'], string>> = {
  SET_MICROPHONE_ENABLED: 'microphone toggled',
  SET_SYSTEM_AUDIO_ENABLED: 'system audio toggled',
};

function toWidgetState(session: LocalVideoSession): WidgetState {
  return {
    sessionId: session.sessionId,
    status: session.status,
    microphoneEnabled: session.microphoneEnabled ?? true,
    systemAudioEnabled: session.systemAudioEnabled ?? true,
    hasMicrophone: Boolean(session.hasMicrophone),
    hasSystemAudio: Boolean(session.hasSystemAudio),
  };
}

const WIDGET_SIZE = 40;
const EDGE_MARGIN = 16;
const DRAG_THRESHOLD = 4;

interface DragState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

const RecordingWidget: React.FC = () => {
  const [state, setState] = useState<WidgetState | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Purely presentational drag-to-reposition state for the floating icon;
  // does not affect recording/session state in any way.
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  // Default to the original top-right placement, then keep it inside the
  // viewport if the window is resized after a manual drag.
  useEffect(() => {
    const clampToViewport = (x: number, y: number) => {
      const maxX = Math.max(0, window.innerWidth - WIDGET_SIZE);
      const maxY = Math.max(0, window.innerHeight - WIDGET_SIZE);
      return { x: Math.min(Math.max(x, 0), maxX), y: Math.min(Math.max(y, 0), maxY) };
    };

    setPosition((prev) =>
      prev ?? clampToViewport(window.innerWidth - EDGE_MARGIN - WIDGET_SIZE, EDGE_MARGIN)
    );

    const handleResize = () => {
      setPosition((prev) => (prev ? clampToViewport(prev.x, prev.y) : prev));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Suppresses the click-to-toggle when the pointerdown/up pair was actually
  // a drag, without changing the click-based toggle path itself (a real
  // `click` still follows `pointerup` in the browser, same as before dragging
  // was added).
  const suppressNextClickRef = useRef(false);

  const handleIconPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!position) return;
      dragStateRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: position.x,
        originY: position.y,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [position]
  );

  const handleIconPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragState.moved = true;
    const maxX = Math.max(0, window.innerWidth - WIDGET_SIZE);
    const maxY = Math.max(0, window.innerHeight - WIDGET_SIZE);
    setPosition({
      x: Math.min(Math.max(dragState.originX + dx, 0), maxX),
      y: Math.min(Math.max(dragState.originY + dy, 0), maxY),
    });
  }, []);

  const handleIconPointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (dragState?.moved) {
      logger.info('[RecordingWidget] icon repositioned');
      suppressNextClickRef.current = true;
    }
  }, []);

  const handleIconClick = useCallback(() => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }
    logger.info('[RecordingWidget] icon clicked');
    setExpanded((prevExpanded) => {
      const next = !prevExpanded;
      logger.info(`[RecordingWidget] expanded=${next}`);
      return next;
    });
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  // Fetch current session state on mount; RecorderService/IndexedDB (via the
  // service worker) is the authority, this is purely a read.
  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const response = await sendExtensionMessage<LocalVideoSession | null>('GET_SESSION_STATUS');
        if (cancelled) return;
        if (response.success && response.data && response.data.status === 'RECORDING') {
          logger.info(`[RecordingWidget] recording started (session=${response.data.sessionId})`);
          setState(toWidgetState(response.data));
          logger.info('[RecordingWidget] floating icon visible');
        } else {
          setState(null);
        }
      } catch (err) {
        logger.warn('[RecordingWidget] failed to fetch session status:', err);
      }
    };

    fetchStatus();

    const messageListener = (message: ExtensionMessage) => {
      if (message.action !== 'RECORDING_STATE_CHANGED') return;
      const payload = message.payload as RecordingStateChangedPayload;

      if (payload.status === 'RECORDING') {
        logger.info(`[RecordingWidget] recording started (session=${payload.sessionId})`);
        setState({
          sessionId: payload.sessionId,
          status: payload.status,
          microphoneEnabled: payload.microphoneEnabled ?? true,
          systemAudioEnabled: payload.systemAudioEnabled ?? true,
          hasMicrophone: Boolean(payload.hasMicrophone),
          hasSystemAudio: Boolean(payload.hasSystemAudio),
        });
        logger.info('[RecordingWidget] floating icon visible');
      } else {
        // STOPPED / ERROR / any terminal status: hide the widget.
        logger.info(`[RecordingWidget] recording stopped (status=${payload.status})`);
        setState(null);
        setExpanded(false);
        logger.info('[RecordingWidget] widget removed');
      }
    };

    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(messageListener);
    }

    return () => {
      cancelled = true;
      if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.removeListener(messageListener);
      }
    };
  }, []);

  // Collapse when clicking outside the widget.
  useEffect(() => {
    if (!expanded) return;

    const handlePointerDown = (event: MouseEvent) => {
      const path = event.composedPath();
      if (containerRef.current && !path.includes(containerRef.current)) {
        setExpanded(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown, true);
    return () => document.removeEventListener('mousedown', handlePointerDown, true);
  }, [expanded]);

  if (!state || !position) return null;

  const runControlAction = async (
    action: ExtensionMessage['action'],
    payload: unknown,
    failureMessage: string
  ) => {
    if (pending) return;
    logger.info(`[RecordingWidget] ${CONTROL_ACTION_LOG_LABEL[action] || action}`, payload);
    setPending(true);
    try {
      const response = await sendExtensionMessage<RecordingControlResponseData>(action, payload);
      logger.info(`[RecordingWidget] Control action response for ${action}:`, response);
      if (!response.success) {
        showToast(response.error?.message || failureMessage);
        return;
      }
      setState((prev) =>
        prev
          ? {
              ...prev,
              status: response.data.status,
              microphoneEnabled: response.data.microphoneEnabled,
              systemAudioEnabled: response.data.systemAudioEnabled,
              hasMicrophone: response.data.hasMicrophone,
              hasSystemAudio: response.data.hasSystemAudio,
            }
          : prev
      );
    } catch (err) {
      showToast(err instanceof Error ? err.message : failureMessage);
    } finally {
      setPending(false);
    }
  };

  const handleStop = async () => {
    if (pending) return;
    logger.info('[RecordingWidget] stop clicked');
    setPending(true);
    setExpanded(false);
    try {
      const response = await sendExtensionMessage('STOP_RECORDING', {
        sessionId: state.sessionId,
        reason: 'USER_ACTION',
      });
      logger.info('[RecordingWidget] Stop Recording response:', response);
      if (!response.success) {
        showToast(response.error?.message || 'Failed to stop recording');
        return;
      }
      setState(null);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to stop recording');
    } finally {
      setPending(false);
    }
  };

  const handleToggleMicrophone = () =>
    runControlAction(
      'SET_MICROPHONE_ENABLED',
      { sessionId: state.sessionId, enabled: !state.microphoneEnabled },
      'Failed to toggle microphone'
    );

  const handleToggleSystemAudio = () =>
    runControlAction(
      'SET_SYSTEM_AUDIO_ENABLED',
      { sessionId: state.sessionId, enabled: !state.systemAudioEnabled },
      'Failed to toggle system audio'
    );

  return (
    <div
      ref={containerRef}
      style={{
        // Reset first: Shadow DOM blocks Google Meet's *selectors* from matching our
        // elements, but it does NOT block *inherited* properties (pointer-events, font,
        // color, line-height, direction, ...) from cascading in from Meet's own
        // ancestors (e.g. an overlay layer with `pointer-events: none`). Resetting to
        // the CSS-initial values here, then re-declaring only what we need below,
        // guarantees this widget is clickable regardless of what Meet's page does.
        all: 'initial',
        position: 'fixed',
        top: `${position.y}px`,
        left: `${position.x}px`,
        // Locked to exactly the icon's own box so dragging (or the panel
        // opening) never moves it — the panel/toast below are positioned
        // absolutely relative to this box instead of sharing its layout.
        width: `${WIDGET_SIZE}px`,
        height: `${WIDGET_SIZE}px`,
        zIndex: 2147483647,
        isolation: 'isolate',
        pointerEvents: 'auto',
        display: 'block',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      }}
    >
      <button
        type="button"
        onClick={handleIconClick}
        onPointerDown={handleIconPointerDown}
        onPointerMove={handleIconPointerMove}
        onPointerUp={handleIconPointerUp}
        onPointerCancel={handleIconPointerUp}
        aria-label={expanded ? 'Close recording controls' : 'Recording active, click for controls, or drag to move'}
        title={expanded ? 'Close' : 'Recording active — drag to move'}
        style={{
          width: '40px',
          height: '40px',
          borderRadius: '50%',
          border: 'none',
          background: '#1e293b',
          boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
          pointerEvents: 'auto',
        }}
      >
        {expanded ? (
          <span
            style={{
              position: 'relative',
              width: '14px',
              height: '14px',
              display: 'block',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: '6px',
                left: '0',
                width: '14px',
                height: '2px',
                borderRadius: '1px',
                background: '#e2e8f0',
                transform: 'rotate(45deg)',
              }}
            />
            <span
              style={{
                position: 'absolute',
                top: '6px',
                left: '0',
                width: '14px',
                height: '2px',
                borderRadius: '1px',
                background: '#e2e8f0',
                transform: 'rotate(-45deg)',
              }}
            />
          </span>
        ) : (
          <span
            style={{
              width: '12px',
              height: '12px',
              borderRadius: '50%',
              background: '#ef4444',
              animation: 'openplan-rec-pulse 1.6s ease-in-out infinite',
            }}
          />
        )}
      </button>

      {(expanded || toast) && (
        <div
          style={{
            position: 'absolute',
            // Anchor to whichever side of the icon has room (horizontally and
            // vertically), so a dragged-near-an-edge icon doesn't pop its
            // panel off-screen — the icon's own box above is unaffected.
            ...(position.y + WIDGET_SIZE / 2 > window.innerHeight / 2
              ? { bottom: '48px' }
              : { top: '48px' }),
            ...(position.x + WIDGET_SIZE / 2 > window.innerWidth / 2
              ? { right: '0' }
              : { left: '0' }),
            display: 'flex',
            flexDirection: 'column',
            alignItems:
              position.x + WIDGET_SIZE / 2 > window.innerWidth / 2 ? 'flex-end' : 'flex-start',
          }}
        >
          {expanded && (
            <div
              data-testid="openplan-recording-controls-panel"
              style={{
                width: '210px',
                background: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '10px',
                boxShadow: '0 4px 18px rgba(0,0,0,0.4)',
                overflow: 'hidden',
                color: '#e2e8f0',
                fontSize: '13px',
                pointerEvents: 'auto',
              }}
            >
              <ControlRow
                label="Stop Recording"
                icon="⏹"
                onClick={handleStop}
                disabled={pending}
                danger
              />
              <ControlRow
                label="Microphone"
                icon={state.microphoneEnabled ? '🎙' : '🔇'}
                stateLabel={state.hasMicrophone ? (state.microphoneEnabled ? 'On' : 'Off') : 'N/A'}
                onClick={handleToggleMicrophone}
                disabled={pending || !state.hasMicrophone}
              />
              <ControlRow
                label="System Audio"
                icon={state.systemAudioEnabled ? '🔊' : '🔇'}
                stateLabel={state.hasSystemAudio ? (state.systemAudioEnabled ? 'On' : 'Off') : 'N/A'}
                onClick={handleToggleSystemAudio}
                disabled={pending || !state.hasSystemAudio}
                last
              />
            </div>
          )}

          {toast && (
            <div
              style={{
                marginTop: expanded ? '8px' : '0',
                padding: '8px 10px',
                background: '#7f1d1d',
                color: '#fecaca',
                borderRadius: '6px',
                fontSize: '12px',
                maxWidth: '220px',
                boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                pointerEvents: 'auto',
              }}
            >
              {toast}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes openplan-rec-pulse {
          0% { opacity: 1; }
          50% { opacity: 0.35; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
};

const ControlRow: React.FC<{
  label: string;
  icon: string;
  stateLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  last?: boolean;
}> = ({ label, icon, stateLabel, onClick, disabled, danger, last }) => (
  <button
    type="button"
    onClick={(event) => {
      // Control rows live inside the same container the outside-click collapse
      // handler watches; stopping propagation here means a control click can
      // never race with — and get collapsed by — that handler before the
      // command is sent.
      event.stopPropagation();
      logger.info(`[RecordingWidget] Control row clicked: ${label}`);
      onClick();
    }}
    disabled={disabled}
    style={{
      width: '100%',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '10px 12px',
      background: 'transparent',
      border: 'none',
      borderBottom: last ? 'none' : '1px solid #33415580',
      color: danger ? '#f87171' : '#e2e8f0',
      fontSize: '13px',
      fontWeight: danger ? 600 : 500,
      pointerEvents: disabled ? 'none' : 'auto',
      textAlign: 'left',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.5 : 1,
    }}
  >
    <span style={{ width: '16px', textAlign: 'center' }}>{icon}</span>
    <span style={{ flex: 1 }}>{label}</span>
    {stateLabel && <span style={{ fontSize: '11px', color: '#94a3b8' }}>{stateLabel}</span>}
  </button>
);

export function mountRecordingWidget(): void {
  logger.info(
    `[RecordingWidget] content script loaded (url=${window.location.href}, origin=${window.location.origin}, readyState=${document.readyState})`
  );

  if (document.getElementById('openplan-recording-widget-host')) {
    logger.info('[RecordingWidget] widget already mounted, skipping');
    return;
  }

  logger.info('[RecordingWidget] mounting widget');

  const host = document.createElement('div');
  host.id = 'openplan-recording-widget-host';
  // Explicit inline styles (highest specificity short of !important) so Meet's
  // page stylesheets cannot hide/displace the host itself. The host has no
  // width/height, so it never intercepts clicks elsewhere on the page; the
  // actual widget inside the shadow root positions itself with `position: fixed`.
  host.setAttribute(
    'style',
    'all: initial; display: block; position: fixed; top: 0; left: 0; width: 0; height: 0; ' +
      'z-index: 2147483647; pointer-events: none;'
  );

  const shadowRoot = host.attachShadow({ mode: 'open' });
  const mountPoint = document.createElement('div');
  mountPoint.style.pointerEvents = 'auto';
  shadowRoot.appendChild(mountPoint);

  (document.body || document.documentElement).appendChild(host);

  ReactDOM.createRoot(mountPoint).render(
    <React.StrictMode>
      <RecordingWidget />
    </React.StrictMode>
  );

  logger.info(`[RecordingWidget] widget mounted (host connected=${host.isConnected})`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountRecordingWidget, { once: true });
} else {
  mountRecordingWidget();
}
