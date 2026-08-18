import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { logger } from '@openplan/core';
function sendExtensionMessage(action, payload = {}) {
    return new Promise((resolve, reject) => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
            reject(new Error('Extension messaging is unavailable'));
            return;
        }
        const message = {
            target: 'SERVICE_WORKER',
            action,
            payload,
            meta: {
                timestamp: new Date().toISOString(),
                requestId: crypto.randomUUID(),
            },
        };
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}
const CONTROL_ACTION_LOG_LABEL = {
    SET_MICROPHONE_ENABLED: 'microphone toggled',
    SET_SYSTEM_AUDIO_ENABLED: 'system audio toggled',
};
function toWidgetState(session) {
    return {
        sessionId: session.sessionId,
        status: session.status,
        microphoneEnabled: session.microphoneEnabled ?? true,
        systemAudioEnabled: session.systemAudioEnabled ?? true,
        hasMicrophone: Boolean(session.hasMicrophone),
        hasSystemAudio: Boolean(session.hasSystemAudio),
    };
}
const RecordingWidget = () => {
    const [state, setState] = useState(null);
    const [expanded, setExpanded] = useState(false);
    const [toast, setToast] = useState(null);
    const [pending, setPending] = useState(false);
    const containerRef = useRef(null);
    const toastTimerRef = useRef(null);
    const showToast = useCallback((msg) => {
        setToast(msg);
        if (toastTimerRef.current)
            clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), 3000);
    }, []);
    // Fetch current session state on mount; RecorderService/IndexedDB (via the
    // service worker) is the authority, this is purely a read.
    useEffect(() => {
        let cancelled = false;
        const fetchStatus = async () => {
            try {
                const response = await sendExtensionMessage('GET_SESSION_STATUS');
                if (cancelled)
                    return;
                if (response.success && response.data && response.data.status === 'RECORDING') {
                    logger.info(`[RecordingWidget] recording started (session=${response.data.sessionId})`);
                    setState(toWidgetState(response.data));
                    logger.info('[RecordingWidget] floating icon visible');
                }
                else {
                    setState(null);
                }
            }
            catch (err) {
                logger.warn('[RecordingWidget] failed to fetch session status:', err);
            }
        };
        fetchStatus();
        const messageListener = (message) => {
            if (message.action !== 'RECORDING_STATE_CHANGED')
                return;
            const payload = message.payload;
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
            }
            else {
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
        if (!expanded)
            return;
        const handlePointerDown = (event) => {
            const path = event.composedPath();
            if (containerRef.current && !path.includes(containerRef.current)) {
                setExpanded(false);
            }
        };
        document.addEventListener('mousedown', handlePointerDown, true);
        return () => document.removeEventListener('mousedown', handlePointerDown, true);
    }, [expanded]);
    if (!state)
        return null;
    const runControlAction = async (action, payload, failureMessage) => {
        if (pending)
            return;
        logger.info(`[RecordingWidget] ${CONTROL_ACTION_LOG_LABEL[action] || action}`, payload);
        setPending(true);
        try {
            const response = await sendExtensionMessage(action, payload);
            logger.info(`[RecordingWidget] Control action response for ${action}:`, response);
            if (!response.success) {
                showToast(response.error?.message || failureMessage);
                return;
            }
            setState((prev) => prev
                ? {
                    ...prev,
                    status: response.data.status,
                    microphoneEnabled: response.data.microphoneEnabled,
                    systemAudioEnabled: response.data.systemAudioEnabled,
                    hasMicrophone: response.data.hasMicrophone,
                    hasSystemAudio: response.data.hasSystemAudio,
                }
                : prev);
        }
        catch (err) {
            showToast(err instanceof Error ? err.message : failureMessage);
        }
        finally {
            setPending(false);
        }
    };
    const handleStop = async () => {
        if (pending)
            return;
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
        }
        catch (err) {
            showToast(err instanceof Error ? err.message : 'Failed to stop recording');
        }
        finally {
            setPending(false);
        }
    };
    const handleToggleMicrophone = () => runControlAction('SET_MICROPHONE_ENABLED', { sessionId: state.sessionId, enabled: !state.microphoneEnabled }, 'Failed to toggle microphone');
    const handleToggleSystemAudio = () => runControlAction('SET_SYSTEM_AUDIO_ENABLED', { sessionId: state.sessionId, enabled: !state.systemAudioEnabled }, 'Failed to toggle system audio');
    return (_jsxs("div", { ref: containerRef, style: {
            // Reset first: Shadow DOM blocks Google Meet's *selectors* from matching our
            // elements, but it does NOT block *inherited* properties (pointer-events, font,
            // color, line-height, direction, ...) from cascading in from Meet's own
            // ancestors (e.g. an overlay layer with `pointer-events: none`). Resetting to
            // the CSS-initial values here, then re-declaring only what we need below,
            // guarantees this widget is clickable regardless of what Meet's page does.
            all: 'initial',
            position: 'fixed',
            top: '16px',
            right: '16px',
            zIndex: 2147483647,
            isolation: 'isolate',
            pointerEvents: 'auto',
            display: 'block',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }, children: [_jsx("button", { type: "button", onClick: () => {
                    logger.info('[RecordingWidget] icon clicked');
                    const next = !expanded;
                    logger.info(`[RecordingWidget] expanded=${next}`);
                    setExpanded(next);
                }, "aria-label": "Recording active, click for controls", title: "Recording active", style: {
                    width: '40px',
                    height: '40px',
                    borderRadius: '50%',
                    border: 'none',
                    background: '#1e293b',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    pointerEvents: 'auto',
                }, children: _jsx("span", { style: {
                        width: '12px',
                        height: '12px',
                        borderRadius: '50%',
                        background: '#ef4444',
                        animation: 'openplan-rec-pulse 1.6s ease-in-out infinite',
                    } }) }), expanded && (_jsxs("div", { "data-testid": "openplan-recording-controls-panel", style: {
                    marginTop: '8px',
                    width: '210px',
                    background: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '10px',
                    boxShadow: '0 4px 18px rgba(0,0,0,0.4)',
                    overflow: 'hidden',
                    color: '#e2e8f0',
                    fontSize: '13px',
                    pointerEvents: 'auto',
                }, children: [_jsx(ControlRow, { label: "Stop Recording", icon: "\u23F9", onClick: handleStop, disabled: pending, danger: true }), _jsx(ControlRow, { label: "Microphone", icon: state.microphoneEnabled ? '🎙' : '🔇', stateLabel: state.hasMicrophone ? (state.microphoneEnabled ? 'On' : 'Off') : 'N/A', onClick: handleToggleMicrophone, disabled: pending || !state.hasMicrophone }), _jsx(ControlRow, { label: "System Audio", icon: state.systemAudioEnabled ? '🔊' : '🔇', stateLabel: state.hasSystemAudio ? (state.systemAudioEnabled ? 'On' : 'Off') : 'N/A', onClick: handleToggleSystemAudio, disabled: pending || !state.hasSystemAudio, last: true })] })), toast && (_jsx("div", { style: {
                    marginTop: '8px',
                    padding: '8px 10px',
                    background: '#7f1d1d',
                    color: '#fecaca',
                    borderRadius: '6px',
                    fontSize: '12px',
                    maxWidth: '220px',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                    pointerEvents: 'auto',
                }, children: toast })), _jsx("style", { children: `
        @keyframes openplan-rec-pulse {
          0% { opacity: 1; }
          50% { opacity: 0.35; }
          100% { opacity: 1; }
        }
      ` })] }));
};
const ControlRow = ({ label, icon, stateLabel, onClick, disabled, danger, last }) => (_jsxs("button", { type: "button", onClick: (event) => {
        // Control rows live inside the same container the outside-click collapse
        // handler watches; stopping propagation here means a control click can
        // never race with — and get collapsed by — that handler before the
        // command is sent.
        event.stopPropagation();
        logger.info(`[RecordingWidget] Control row clicked: ${label}`);
        onClick();
    }, disabled: disabled, style: {
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
    }, children: [_jsx("span", { style: { width: '16px', textAlign: 'center' }, children: icon }), _jsx("span", { style: { flex: 1 }, children: label }), stateLabel && _jsx("span", { style: { fontSize: '11px', color: '#94a3b8' }, children: stateLabel })] }));
export function mountRecordingWidget() {
    logger.info(`[RecordingWidget] content script loaded (url=${window.location.href}, origin=${window.location.origin}, readyState=${document.readyState})`);
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
    host.setAttribute('style', 'all: initial; display: block; position: fixed; top: 0; left: 0; width: 0; height: 0; ' +
        'z-index: 2147483647; pointer-events: none;');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const mountPoint = document.createElement('div');
    mountPoint.style.pointerEvents = 'auto';
    shadowRoot.appendChild(mountPoint);
    (document.body || document.documentElement).appendChild(host);
    ReactDOM.createRoot(mountPoint).render(_jsx(React.StrictMode, { children: _jsx(RecordingWidget, {}) }));
    logger.info(`[RecordingWidget] widget mounted (host connected=${host.isConnected})`);
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountRecordingWidget, { once: true });
}
else {
    mountRecordingWidget();
}
