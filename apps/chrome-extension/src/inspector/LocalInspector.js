import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { getAllSessions, getChunksForSession, getMissingSequences, deleteSession, } from '../modules/offline-cache/idb-store.js';
/**
 * Concatenates stored 5-second WebM chunks sorted by 1-indexed sequence number
 * into a single playable Blob for developer preview and export.
 */
export function concatenateChunksToBlob(chunks) {
    if (!chunks || chunks.length === 0) {
        return new Blob([], { type: 'video/webm' });
    }
    const sorted = [...chunks].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const blobs = sorted.map((c) => c.blob).filter((b) => b !== undefined);
    const mimeType = sorted[0]?.mimeType || 'video/webm';
    return new Blob(blobs, { type: mimeType });
}
export const LocalInspector = () => {
    const [sessions, setSessions] = useState([]);
    const [selectedSessionId, setSelectedSessionId] = useState(null);
    const [selectedSession, setSelectedSession] = useState(null);
    const [chunks, setChunks] = useState([]);
    const [missingSequences, setMissingSequences] = useState([]);
    const [videoUrl, setVideoUrl] = useState(null);
    const [loading, setLoading] = useState(true);
    const [errorMessage, setErrorMessage] = useState(null);
    const [micStatus, setMicStatus] = useState(null);
    const handleGrantMicPermission = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach((t) => t.stop());
            setMicStatus('✅ Microphone permission granted to Openplan Extension!');
        }
        catch (err) {
            const msg = err instanceof Error ? `${err.name}: ${err.message}` : 'Permission denied';
            setMicStatus(`⚠️ ${msg}`);
        }
    };
    useEffect(() => {
        loadSessions();
    }, []);
    useEffect(() => {
        if (selectedSessionId) {
            loadSessionDetails(selectedSessionId);
        }
        else {
            setChunks([]);
            setMissingSequences([]);
            if (videoUrl) {
                URL.revokeObjectURL(videoUrl);
                setVideoUrl(null);
            }
        }
    }, [selectedSessionId]);
    const loadSessions = async () => {
        try {
            setLoading(true);
            const list = await getAllSessions();
            setSessions(list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
            if (list.length > 0 && !selectedSessionId) {
                setSelectedSessionId(list[0].sessionId);
            }
        }
        catch (err) {
            setErrorMessage(err instanceof Error ? err.message : 'Failed to load sessions from IndexedDB');
        }
        finally {
            setLoading(false);
        }
    };
    const loadSessionDetails = async (sessionId) => {
        try {
            const sess = sessions.find((s) => s.sessionId === sessionId) || null;
            setSelectedSession(sess);
            const fetchedChunks = await getChunksForSession(sessionId);
            setChunks(fetchedChunks);
            const missing = await getMissingSequences(sessionId);
            setMissingSequences(missing);
            if (fetchedChunks.length > 0) {
                const unifiedBlob = concatenateChunksToBlob(fetchedChunks);
                if (videoUrl) {
                    URL.revokeObjectURL(videoUrl);
                }
                const url = URL.createObjectURL(unifiedBlob);
                setVideoUrl(url);
            }
            else {
                if (videoUrl) {
                    URL.revokeObjectURL(videoUrl);
                    setVideoUrl(null);
                }
            }
        }
        catch (err) {
            setErrorMessage(err instanceof Error ? err.message : 'Failed loading session chunks');
        }
    };
    const handleExportWebM = () => {
        if (!chunks || chunks.length === 0 || !selectedSessionId)
            return;
        const unifiedBlob = concatenateChunksToBlob(chunks);
        const url = URL.createObjectURL(unifiedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recording-${selectedSessionId}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    };
    const handleDeleteSession = async (sessionId) => {
        if (!window.confirm('Are you sure you want to permanently delete this local recording session?')) {
            return;
        }
        try {
            await deleteSession(sessionId);
            if (selectedSessionId === sessionId) {
                setSelectedSessionId(null);
                setSelectedSession(null);
            }
            await loadSessions();
        }
        catch (err) {
            setErrorMessage(err instanceof Error ? err.message : 'Failed to delete recording session');
        }
    };
    const formatBytes = (bytes) => {
        if (!bytes)
            return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    };
    const formatTime = (secs) => {
        if (!secs)
            return '00:00';
        const m = Math.floor(secs / 60);
        const s = Math.floor(secs % 60);
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };
    return (_jsxs("div", { style: { fontFamily: 'sans-serif', padding: '24px', maxWidth: '1000px', margin: '0 auto', color: '#e2e8f0' }, children: [_jsxs("header", { style: { borderBottom: '1px solid #334155', paddingBottom: '16px', marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }, children: [_jsxs("div", { children: [_jsx("h1", { style: { margin: '0 0 8px 0', fontSize: '24px', fontWeight: 700, color: '#f8fafc' }, children: "Openplan Milestone 1 \u2014 Local Inspector Player" }), _jsx("p", { style: { margin: 0, fontSize: '14px', color: '#94a3b8' }, children: "Developer verification tool for IndexedDB 5-second WebM chunk continuity, unified player preview, and export." })] }), _jsx("div", { children: _jsx("button", { onClick: handleGrantMicPermission, style: {
                                padding: '8px 16px',
                                background: '#2563eb',
                                color: '#ffffff',
                                border: 'none',
                                borderRadius: '6px',
                                fontWeight: 600,
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                            }, children: "Grant Microphone Permission" }) })] }), micStatus && (_jsx("div", { style: { padding: '10px 16px', background: micStatus.startsWith('✅') ? '#16a34a20' : '#ef444420', border: '1px solid', borderColor: micStatus.startsWith('✅') ? '#16a34a' : '#ef4444', color: micStatus.startsWith('✅') ? '#4ade80' : '#f87171', borderRadius: '8px', marginBottom: '20px', fontSize: '13px' }, children: micStatus })), errorMessage && (_jsxs("div", { style: { padding: '12px 16px', background: '#ef444420', border: '1px solid #ef4444', color: '#f87171', borderRadius: '8px', marginBottom: '20px' }, children: ["\u26A0\uFE0F ", errorMessage] })), loading ? (_jsx("div", { children: "Loading IndexedDB sessions..." })) : sessions.length === 0 ? (_jsxs("div", { style: { textAlign: 'center', padding: '48px', background: '#1e293b', borderRadius: '12px' }, children: [_jsx("h3", { children: "No Local Recordings Found" }), _jsx("p", { style: { color: '#94a3b8' }, children: "Use the Chrome extension popup to capture a screen recording." })] })) : (_jsxs("div", { style: { display: 'grid', gridTemplateColumns: '300px 1fr', gap: '24px' }, children: [_jsxs("div", { style: { background: '#1e293b', padding: '16px', borderRadius: '12px' }, children: [_jsxs("h3", { style: { margin: '0 0 16px 0', fontSize: '16px', color: '#cbd5e1' }, children: ["Recorded Sessions (", sessions.length, ")"] }), _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: sessions.map((s) => (_jsxs("div", { onClick: () => setSelectedSessionId(s.sessionId), style: {
                                        padding: '12px',
                                        borderRadius: '8px',
                                        cursor: 'pointer',
                                        background: s.sessionId === selectedSessionId ? '#2563eb' : '#0f172a',
                                        border: '1px solid',
                                        borderColor: s.sessionId === selectedSessionId ? '#3b82f6' : '#334155',
                                    }, children: [_jsx("div", { style: { fontWeight: 600, fontSize: '14px', marginBottom: '4px' }, children: s.title }), _jsx("div", { style: { fontSize: '11px', color: s.sessionId === selectedSessionId ? '#dbeafe' : '#94a3b8' }, children: new Date(s.createdAt).toLocaleString() }), _jsxs("div", { style: { fontSize: '11px', marginTop: '6px', display: 'flex', justifyContent: 'space-between' }, children: [_jsx("span", { children: formatTime(s.durationSeconds) }), _jsxs("span", { children: [s.totalChunks, " chunks"] })] })] }, s.sessionId))) })] }), _jsx("div", { children: selectedSession ? (_jsxs("div", { style: { background: '#1e293b', padding: '24px', borderRadius: '12px' }, children: [_jsxs("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }, children: [_jsxs("div", { children: [_jsx("h2", { style: { margin: '0 0 4px 0', fontSize: '20px' }, children: selectedSession.title }), _jsxs("div", { style: { fontSize: '12px', color: '#94a3b8' }, children: ["ID: ", selectedSession.sessionId] })] }), _jsxs("div", { style: { display: 'flex', gap: '8px' }, children: [_jsx("button", { onClick: handleExportWebM, disabled: chunks.length === 0, style: {
                                                        padding: '8px 16px',
                                                        background: '#16a34a',
                                                        color: '#ffffff',
                                                        border: 'none',
                                                        borderRadius: '6px',
                                                        fontWeight: 600,
                                                        cursor: chunks.length === 0 ? 'not-allowed' : 'pointer',
                                                    }, children: "Export WebM" }), _jsx("button", { onClick: () => handleDeleteSession(selectedSession.sessionId), style: {
                                                        padding: '8px 16px',
                                                        background: '#dc2626',
                                                        color: '#ffffff',
                                                        border: 'none',
                                                        borderRadius: '6px',
                                                        fontWeight: 600,
                                                        cursor: 'pointer',
                                                    }, children: "Delete Recording" })] })] }), missingSequences.length > 0 && (_jsxs("div", { style: { padding: '12px', background: '#eab30820', border: '1px solid #eab308', color: '#fde047', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }, children: ["\u26A0\uFE0F ", _jsx("strong", { children: "Recording incomplete:" }), " Missing chunk sequence(s): ", missingSequences.join(', '), "."] })), _jsxs("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', padding: '12px', background: '#0f172a', borderRadius: '8px', marginBottom: '20px', fontSize: '12px' }, children: [_jsxs("div", { children: ["Status: ", _jsx("strong", { children: selectedSession.status })] }), _jsxs("div", { children: ["Mode: ", _jsx("strong", { children: selectedSession.captureMode })] }), _jsxs("div", { children: ["Duration: ", _jsx("strong", { children: formatTime(selectedSession.durationSeconds) })] }), _jsxs("div", { children: ["Size: ", _jsx("strong", { children: formatBytes(selectedSession.fileSizeBytes) })] })] }), videoUrl ? (_jsxs("div", { style: { marginBottom: '20px' }, children: [_jsx("h4", { style: { margin: '0 0 8px 0', fontSize: '14px', color: '#cbd5e1' }, children: "HTML5 Unified Player Preview" }), _jsx("video", { controls: true, src: videoUrl, style: { width: '100%', maxHeight: '450px', background: '#000000', borderRadius: '8px' } })] })) : (_jsx("div", { style: { padding: '32px', textAlign: 'center', background: '#0f172a', borderRadius: '8px', color: '#94a3b8' }, children: "No chunk binary data found for playback." })), _jsxs("div", { children: [_jsxs("h4", { style: { margin: '0 0 12px 0', fontSize: '14px', color: '#cbd5e1' }, children: ["Stored Chunks Manifest (", chunks.length, ")"] }), _jsx("div", { style: { maxHeight: '200px', overflowY: 'auto', background: '#0f172a', borderRadius: '8px', border: '1px solid #334155' }, children: _jsxs("table", { style: { width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }, children: [_jsx("thead", { children: _jsxs("tr", { style: { background: '#1e293b', borderBottom: '1px solid #334155' }, children: [_jsx("th", { style: { padding: '8px 12px' }, children: "Seq #" }), _jsx("th", { style: { padding: '8px 12px' }, children: "Timestamp" }), _jsx("th", { style: { padding: '8px 12px' }, children: "Size" }), _jsx("th", { style: { padding: '8px 12px' }, children: "Type" }), _jsx("th", { style: { padding: '8px 12px' }, children: "isFinal" })] }) }), _jsx("tbody", { children: chunks.map((c) => (_jsxs("tr", { style: { borderBottom: '1px solid #1e293b' }, children: [_jsxs("td", { style: { padding: '8px 12px', fontWeight: 'bold' }, children: ["#", c.sequenceNumber] }), _jsx("td", { style: { padding: '8px 12px', color: '#94a3b8' }, children: new Date(c.timestamp).toLocaleTimeString() }), _jsx("td", { style: { padding: '8px 12px' }, children: formatBytes(c.byteSize) }), _jsx("td", { style: { padding: '8px 12px', color: '#94a3b8' }, children: c.mimeType }), _jsx("td", { style: { padding: '8px 12px' }, children: c.isFinal ? '✅ Yes' : 'No' })] }, `${c.sessionId}-${c.sequenceNumber}`))) })] }) })] })] })) : (_jsx("div", { style: { padding: '48px', textAlign: 'center', background: '#1e293b', borderRadius: '12px', color: '#94a3b8' }, children: "Select a recording session from the sidebar to inspect." })) })] }))] }));
};
