import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
export const PopupApp = () => {
    const [status, setStatus] = useState('IDLE');
    const [sessionId, setSessionId] = useState(null);
    const [captureMode, setCaptureMode] = useState('SCREEN_SYSTEM_MIC');
    const [durationSeconds, setDurationSeconds] = useState(0);
    const [totalChunks, setTotalChunks] = useState(0);
    const [errorMessage, setErrorMessage] = useState(null);
    const [infoMessage, setInfoMessage] = useState(null);
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
        let interval = null;
        if (status === 'RECORDING') {
            interval = setInterval(() => {
                setDurationSeconds((prev) => prev + 1);
            }, 1000);
        }
        else if (status === 'IDLE') {
            setDurationSeconds(0);
        }
        return () => {
            if (interval)
                clearInterval(interval);
        };
    }, [status]);
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
                setDurationSeconds(Math.round(session.durationSeconds || 0));
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
                // Automatically close popup window so it does not overlay or get captured in the recording
                setTimeout(() => {
                    if (typeof window !== 'undefined' && window.close) {
                        window.close();
                    }
                }, 300);
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
            }
            else {
                setStatus('ERROR');
                setErrorMessage(response?.error?.message || 'Failed to stop recording cleanly');
            }
        });
    };
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
                        }, children: "Open Local Inspector" })] })), status === 'REQUESTING_PERMISSIONS' && (_jsxs("div", { style: { textAlign: 'center', padding: '24px 0' }, children: [_jsx("div", { style: { fontSize: '14px', fontWeight: 500, marginBottom: '8px' }, children: "Requesting Capture Permissions..." }), _jsx("p", { style: { fontSize: '12px', color: '#94a3b8' }, children: "Please select the screen/window to share in the Chrome prompt." })] })), status === 'RECORDING' && (_jsxs("div", { children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '16px' }, children: [_jsx("span", { style: { width: '12px', height: '12px', borderRadius: '50%', background: '#ef4444', animation: 'pulse 1s infinite' } }), _jsx("span", { style: { fontSize: '24px', fontWeight: 'bold', fontFamily: 'monospace' }, children: formatTime(durationSeconds) })] }), _jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#94a3b8', marginBottom: '12px' }, children: [_jsxs("span", { children: ["Chunks Recorded: ", _jsx("strong", { children: totalChunks })] }), _jsxs("span", { children: ["Mode: ", _jsx("strong", { children: captureMode })] })] }), (captureMode === 'SCREEN_SYSTEM' || captureMode === 'SCREEN_ONLY') && (_jsxs("div", { style: { padding: '6px 10px', background: '#eab30820', border: '1px solid #eab308', color: '#fde047', borderRadius: '4px', fontSize: '11px', marginBottom: '12px' }, children: ["\u26A0\uFE0F Mic not enabled (", captureMode === 'SCREEN_SYSTEM' ? 'System Audio only' : 'Screen only', ")."] }))] })), (status === 'STOPPING' || status === 'FINALIZING') && (_jsxs("div", { style: { textAlign: 'center', padding: '24px 0' }, children: [_jsx("div", { style: { fontSize: '14px', fontWeight: 500, marginBottom: '8px' }, children: "Finalizing Local Recording..." }), _jsx("p", { style: { fontSize: '12px', color: '#94a3b8' }, children: "Saving final chunks to IndexedDB offline store." })] })), status === 'STOPPED' && (_jsxs("div", { children: [_jsxs("div", { style: { textAlign: 'center', marginBottom: '16px' }, children: [_jsx("div", { style: { fontSize: '28px', marginBottom: '4px' }, children: "\u2705" }), _jsx("h3", { style: { margin: '0 0 4px 0', fontSize: '16px' }, children: "Recording Completed" }), _jsxs("p", { style: { margin: 0, fontSize: '12px', color: '#94a3b8' }, children: ["Duration: ", formatTime(durationSeconds), " | Total Chunks: ", totalChunks] })] }), _jsx("button", { onClick: openInspector, style: {
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
