import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
function sendServiceWorkerMessage(action, payload = {}) {
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
export const PopupApp = () => {
    const [status, setStatus] = useState('IDLE');
    const [sessionId, setSessionId] = useState(null);
    const [captureMode, setCaptureMode] = useState('SCREEN_SYSTEM_MIC');
    const [durationSeconds, setDurationSeconds] = useState(0);
    const [totalChunks, setTotalChunks] = useState(0);
    const [errorMessage, setErrorMessage] = useState(null);
    const [infoMessage, setInfoMessage] = useState(null);
    const [microphoneEnabled, setMicrophoneEnabled] = useState(true);
    const [systemAudioEnabled, setSystemAudioEnabled] = useState(true);
    const [hasMicrophone, setHasMicrophone] = useState(false);
    const [hasSystemAudio, setHasSystemAudio] = useState(false);
    const [controlPending, setControlPending] = useState(false);
    // Wall-clock anchor (ms) for the currently recording session's start. Duration
    // is derived from this on every tick rather than incremented locally, so
    // reopening the popup mid-recording shows the real elapsed time instead of
    // restarting from zero (the session's own `durationSeconds` field is only
    // ever written once, at stop time).
    const [sessionStartedAt, setSessionStartedAt] = useState(null);
    // Poll/Fetch session status on popup open
    useEffect(() => {
        fetchSessionStatus();
        // Listen for runtime state updates
        const messageListener = (message) => {
            if (message.action === 'RECORDING_STATE_CHANGED') {
                const payload = message.payload;
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
    // Duration timer during RECORDING state. Recomputed from sessionStartedAt on
    // every tick (not incremented locally) so it's always correct even though
    // the popup document is torn down and rebuilt from scratch every time it's
    // closed and reopened mid-recording.
    useEffect(() => {
        if (status !== 'RECORDING' || sessionStartedAt === null) {
            if (status === 'IDLE')
                setDurationSeconds(0);
            return;
        }
        const tick = () => setDurationSeconds(Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000)));
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [status, sessionStartedAt]);
    const fetchSessionStatus = () => {
        if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage)
            return;
        const message = {
            target: 'SERVICE_WORKER',
            action: 'GET_SESSION_STATUS',
            payload: {},
            meta: {
                timestamp: new Date().toISOString(),
                requestId: crypto.randomUUID(),
            },
        };
        chrome.runtime.sendMessage(message, (response) => {
            if (response && response.success && response.data) {
                const session = response.data;
                setStatus(session.status);
                setSessionId(session.sessionId);
                setCaptureMode(session.captureMode);
                setTotalChunks(session.totalChunks || 0);
                if (session.status === 'RECORDING') {
                    setSessionStartedAt(new Date(session.createdAt).getTime());
                }
                else {
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
        });
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
            }
            catch (err) {
                // If microphone permission is denied, blocked, or device unavailable,
                // log warning and continue so recording proceeds gracefully degraded (E-02).
                console.warn('Microphone permission prompt denied or unavailable in popup context:', err);
            }
        }
        const message = {
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
        chrome.runtime.sendMessage(message, (response) => {
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
            }
            else {
                setStatus('IDLE');
                if (response.error?.code === 'ERR_SCREEN_CANCELLED') {
                    setInfoMessage('Screen share cancelled by user');
                }
                else {
                    setErrorMessage(response.error?.message || 'Failed to start recording');
                }
            }
        });
    };
    const handleStopRecording = () => {
        setStatus('STOPPING');
        const message = {
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
        chrome.runtime.sendMessage(message, (response) => {
            if (response && response.success) {
                setStatus('STOPPED');
                setTotalChunks(response.data.totalChunks);
                setDurationSeconds(Math.round(response.data.durationSeconds));
                setSessionStartedAt(null);
            }
            else {
                setStatus('ERROR');
                setErrorMessage(response?.error?.message || 'Failed to stop recording cleanly');
            }
        });
    };
    const runControlAction = async (action, payload, failureMessage) => {
        if (controlPending)
            return;
        setControlPending(true);
        setErrorMessage(null);
        try {
            const response = await sendServiceWorkerMessage(action, payload);
            if (!response.success) {
                setErrorMessage(response.error?.message || failureMessage);
                return;
            }
            setStatus(response.data.status);
            setMicrophoneEnabled(response.data.microphoneEnabled);
            setSystemAudioEnabled(response.data.systemAudioEnabled);
            setHasMicrophone(response.data.hasMicrophone);
            setHasSystemAudio(response.data.hasSystemAudio);
        }
        catch (err) {
            setErrorMessage(err instanceof Error ? err.message : failureMessage);
        }
        finally {
            setControlPending(false);
        }
    };
    const handleToggleMicrophone = () => runControlAction('SET_MICROPHONE_ENABLED', { sessionId, enabled: !microphoneEnabled }, 'Failed to toggle microphone');
    const handleToggleSystemAudio = () => runControlAction('SET_SYSTEM_AUDIO_ENABLED', { sessionId, enabled: !systemAudioEnabled }, 'Failed to toggle system audio');
    const openInspector = () => {
        if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
            chrome.tabs.create({ url: chrome.runtime.getURL('src/inspector/index.html') });
        }
    };
    const formatTime = (totalSecs) => {
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };
    return (_jsxs("div", { style: { padding: '16px', fontFamily: 'sans-serif', maxWidth: '360px' }, children: [_jsxs("header", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }, children: [_jsx("h2", { style: { margin: 0, fontSize: '18px', fontWeight: 600 }, children: "Openplan Recorder" }), _jsx("span", { style: {
                            fontSize: '11px',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            background: status === 'RECORDING' ? '#ef4444' : '#3b82f6',
                            color: '#ffffff',
                            fontWeight: 'bold',
                        }, children: status })] }), infoMessage && (_jsxs("div", { style: { padding: '8px 12px', background: '#3b82f620', border: '1px solid #3b82f6', color: '#60a5fa', borderRadius: '6px', fontSize: '12px', marginBottom: '12px' }, children: ["\u2139\uFE0F ", infoMessage] })), errorMessage && (_jsxs("div", { style: { padding: '8px 12px', background: '#ef444420', border: '1px solid #ef4444', color: '#f87171', borderRadius: '6px', fontSize: '12px', marginBottom: '12px' }, children: ["\u26A0\uFE0F ", errorMessage] })), status === 'IDLE' && (_jsxs("div", { children: [_jsx("p", { style: { fontSize: '13px', color: '#94a3b8', marginBottom: '16px' }, children: "Local-first screen, system audio, and microphone recorder." }), _jsx("button", { onClick: handleStartRecording, style: {
                            width: '100%',
                            padding: '10px 16px',
                            background: '#2563eb',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '6px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            marginBottom: '8px',
                        }, children: "Start Recording" }), _jsx("button", { onClick: openInspector, style: {
                            width: '100%',
                            padding: '8px 16px',
                            background: 'transparent',
                            color: '#94a3b8',
                            border: '1px solid #475569',
                            borderRadius: '6px',
                            fontSize: '12px',
                            cursor: 'pointer',
                        }, children: "Open Local Inspector" })] })), status === 'REQUESTING_PERMISSIONS' && (_jsxs("div", { style: { textAlign: 'center', padding: '24px 0' }, children: [_jsx("div", { style: { fontSize: '14px', fontWeight: 500, marginBottom: '8px' }, children: "Requesting Capture Permissions..." }), _jsx("p", { style: { fontSize: '12px', color: '#94a3b8' }, children: "Please select the screen/window to share in the Chrome prompt." })] })), status === 'RECORDING' && (_jsxs("div", { style: { padding: '12px 16px', background: '#3b82f615', border: '1px solid #3b82f640', borderRadius: '8px', textAlign: 'center' }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '6px' }, children: [_jsx("span", { style: {
                                    width: '10px',
                                    height: '10px',
                                    borderRadius: '50%',
                                    background: '#ef4444',
                                } }), _jsx("span", { style: { fontSize: '13px', fontWeight: 600, color: '#38bdf8' }, children: "Recording in progress" })] }), _jsxs("p", { style: { margin: '0 0 12px 0', fontSize: '12px', color: '#94a3b8', lineHeight: '1.4' }, children: ["Duration: ", formatTime(durationSeconds)] }), _jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: [_jsxs("div", { style: { display: 'flex', gap: '8px' }, children: [_jsx("button", { onClick: handleToggleMicrophone, disabled: controlPending || !hasMicrophone, style: {
                                            flex: 1,
                                            padding: '8px 10px',
                                            background: '#1e293b',
                                            color: hasMicrophone ? '#e2e8f0' : '#64748b',
                                            border: '1px solid #334155',
                                            borderRadius: '6px',
                                            fontSize: '12px',
                                            cursor: controlPending || !hasMicrophone ? 'default' : 'pointer',
                                            opacity: controlPending || !hasMicrophone ? 0.6 : 1,
                                        }, children: microphoneEnabled ? '🎙 Mic On' : '🔇 Mic Off' }), _jsx("button", { onClick: handleToggleSystemAudio, disabled: controlPending || !hasSystemAudio, style: {
                                            flex: 1,
                                            padding: '8px 10px',
                                            background: '#1e293b',
                                            color: hasSystemAudio ? '#e2e8f0' : '#64748b',
                                            border: '1px solid #334155',
                                            borderRadius: '6px',
                                            fontSize: '12px',
                                            cursor: controlPending || !hasSystemAudio ? 'default' : 'pointer',
                                            opacity: controlPending || !hasSystemAudio ? 0.6 : 1,
                                        }, children: systemAudioEnabled ? '🔊 Audio On' : '🔇 Audio Off' })] }), _jsx("button", { onClick: handleStopRecording, disabled: controlPending, style: {
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
                                }, children: "\u23F9 Stop Recording" })] })] })), (status === 'STOPPING' || status === 'FINALIZING') && (_jsxs("div", { style: { textAlign: 'center', padding: '24px 0' }, children: [_jsx("div", { style: { fontSize: '14px', fontWeight: 500, marginBottom: '8px' }, children: "Finalizing Local Recording..." }), _jsx("p", { style: { fontSize: '12px', color: '#94a3b8' }, children: "Saving final chunks to IndexedDB offline store." })] })), status === 'STOPPED' && (_jsxs("div", { children: [_jsxs("div", { style: { textAlign: 'center', marginBottom: '16px' }, children: [_jsx("div", { style: { fontSize: '28px', marginBottom: '4px' }, children: "\u2705" }), _jsx("h3", { style: { margin: '0 0 4px 0', fontSize: '16px' }, children: "Recording Completed" }), _jsxs("p", { style: { margin: 0, fontSize: '12px', color: '#94a3b8' }, children: ["Duration: ", formatTime(durationSeconds), " | Total Chunks: ", totalChunks] })] }), _jsx("button", { onClick: openInspector, style: {
                            width: '100%',
                            padding: '10px 16px',
                            background: '#16a34a',
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: '6px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            marginBottom: '8px',
                        }, children: "Open Local Inspector & Player" }), _jsx("button", { onClick: () => setStatus('IDLE'), style: {
                            width: '100%',
                            padding: '8px 16px',
                            background: 'transparent',
                            color: '#94a3b8',
                            border: '1px solid #475569',
                            borderRadius: '6px',
                            fontSize: '12px',
                            cursor: 'pointer',
                        }, children: "Start New Recording" })] })), status === 'ERROR' && (_jsx("div", { children: _jsx("button", { onClick: () => setStatus('IDLE'), style: {
                        width: '100%',
                        padding: '8px 16px',
                        background: '#475569',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '6px',
                        fontSize: '12px',
                        cursor: 'pointer',
                    }, children: "Reset" }) }))] }));
};
