import React, { useState, useEffect } from 'react';
import { LocalVideoSession, LocalVideoChunk } from '@openplan/contracts';
import {
  getAllSessions,
  getChunksForSession,
  getMissingSequences,
  deleteSession,
} from '../modules/offline-cache/idb-store.js';

/**
 * Concatenates stored 5-second WebM chunks sorted by 1-indexed sequence number
 * into a single playable Blob for developer preview and export.
 */
export function concatenateChunksToBlob(chunks: LocalVideoChunk[]): Blob {
  if (!chunks || chunks.length === 0) {
    return new Blob([], { type: 'video/webm' });
  }
  const sorted = [...chunks].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const blobs = sorted.map((c) => c.blob).filter((b): b is Blob => b !== undefined);
  const mimeType = sorted[0]?.mimeType || 'video/webm';
  return new Blob(blobs, { type: mimeType });
}


export const LocalInspector: React.FC = () => {
  const [sessions, setSessions] = useState<LocalVideoSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<LocalVideoSession | null>(null);
  const [chunks, setChunks] = useState<LocalVideoChunk[]>([]);
  const [missingSequences, setMissingSequences] = useState<number[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<string | null>(null);

  const handleGrantMicPermission = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      setMicStatus('✅ Microphone permission granted to Openplan Extension!');
    } catch (err) {
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
    } else {
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
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load sessions from IndexedDB');
    } finally {
      setLoading(false);
    }
  };

  const loadSessionDetails = async (sessionId: string) => {
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
      } else {
        if (videoUrl) {
          URL.revokeObjectURL(videoUrl);
          setVideoUrl(null);
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed loading session chunks');
    }
  };

  const handleExportWebM = () => {
    if (!chunks || chunks.length === 0 || !selectedSessionId) return;

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

  const handleDeleteSession = async (sessionId: string) => {
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
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to delete recording session');
    }
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  };

  const formatTime = (secs?: number) => {
    if (!secs) return '00:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '24px', maxWidth: '1000px', margin: '0 auto', color: '#e2e8f0' }}>
      <header style={{ borderBottom: '1px solid #334155', paddingBottom: '16px', marginBottom: '24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: '0 0 8px 0', fontSize: '24px', fontWeight: 700, color: '#f8fafc' }}>
            Openplan Milestone 1 — Local Inspector Player
          </h1>
          <p style={{ margin: 0, fontSize: '14px', color: '#94a3b8' }}>
            Developer verification tool for IndexedDB 5-second WebM chunk continuity, unified player preview, and export.
          </p>
        </div>
        <div>
          <button
            onClick={handleGrantMicPermission}
            style={{
              padding: '8px 16px',
              background: '#2563eb',
              color: '#ffffff',
              border: 'none',
              borderRadius: '6px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Grant Microphone Permission
          </button>
        </div>
      </header>

      {micStatus && (
        <div style={{ padding: '10px 16px', background: micStatus.startsWith('✅') ? '#16a34a20' : '#ef444420', border: '1px solid', borderColor: micStatus.startsWith('✅') ? '#16a34a' : '#ef4444', color: micStatus.startsWith('✅') ? '#4ade80' : '#f87171', borderRadius: '8px', marginBottom: '20px', fontSize: '13px' }}>
          {micStatus}
        </div>
      )}

      {errorMessage && (
        <div style={{ padding: '12px 16px', background: '#ef444420', border: '1px solid #ef4444', color: '#f87171', borderRadius: '8px', marginBottom: '20px' }}>
          ⚠️ {errorMessage}
        </div>
      )}

      {loading ? (
        <div>Loading IndexedDB sessions...</div>
      ) : sessions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px', background: '#1e293b', borderRadius: '12px' }}>
          <h3>No Local Recordings Found</h3>
          <p style={{ color: '#94a3b8' }}>Use the Chrome extension popup to capture a screen recording.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '24px' }}>
          {/* Sidebar Session List */}
          <div style={{ background: '#1e293b', padding: '16px', borderRadius: '12px' }}>
            <h3 style={{ margin: '0 0 16px 0', fontSize: '16px', color: '#cbd5e1' }}>Recorded Sessions ({sessions.length})</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {sessions.map((s) => (
                <div
                  key={s.sessionId}
                  onClick={() => setSelectedSessionId(s.sessionId)}
                  style={{
                    padding: '12px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    background: s.sessionId === selectedSessionId ? '#2563eb' : '#0f172a',
                    border: '1px solid',
                    borderColor: s.sessionId === selectedSessionId ? '#3b82f6' : '#334155',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: '14px', marginBottom: '4px' }}>{s.title}</div>
                  <div style={{ fontSize: '11px', color: s.sessionId === selectedSessionId ? '#dbeafe' : '#94a3b8' }}>
                    {new Date(s.createdAt).toLocaleString()}
                  </div>
                  <div style={{ fontSize: '11px', marginTop: '6px', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{formatTime(s.durationSeconds)}</span>
                    <span>{s.totalChunks} chunks</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Main Inspection & Player Panel */}
          <div>
            {selectedSession ? (
              <div style={{ background: '#1e293b', padding: '24px', borderRadius: '12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
                  <div>
                    <h2 style={{ margin: '0 0 4px 0', fontSize: '20px' }}>{selectedSession.title}</h2>
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>ID: {selectedSession.sessionId}</div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={handleExportWebM}
                      disabled={chunks.length === 0}
                      style={{
                        padding: '8px 16px',
                        background: '#16a34a',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '6px',
                        fontWeight: 600,
                        cursor: chunks.length === 0 ? 'not-allowed' : 'pointer',
                      }}
                    >
                      Export WebM
                    </button>
                    <button
                      onClick={() => handleDeleteSession(selectedSession.sessionId)}
                      style={{
                        padding: '8px 16px',
                        background: '#dc2626',
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: '6px',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Delete Recording
                    </button>
                  </div>
                </div>

                {/* Missing sequence gap warning */}
                {missingSequences.length > 0 && (
                  <div style={{ padding: '12px', background: '#eab30820', border: '1px solid #eab308', color: '#fde047', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
                    ⚠️ <strong>Recording incomplete:</strong> Missing chunk sequence(s): {missingSequences.join(', ')}.
                  </div>
                )}

                {/* Metadata details */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', padding: '12px', background: '#0f172a', borderRadius: '8px', marginBottom: '20px', fontSize: '12px' }}>
                  <div>Status: <strong>{selectedSession.status}</strong></div>
                  <div>Mode: <strong>{selectedSession.captureMode}</strong></div>
                  <div>Duration: <strong>{formatTime(selectedSession.durationSeconds)}</strong></div>
                  <div>Size: <strong>{formatBytes(selectedSession.fileSizeBytes)}</strong></div>
                </div>

                {/* Unified Video Player Preview */}
                {videoUrl ? (
                  <div style={{ marginBottom: '20px' }}>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#cbd5e1' }}>HTML5 Unified Player Preview</h4>
                    <video controls src={videoUrl} style={{ width: '100%', maxHeight: '450px', background: '#000000', borderRadius: '8px' }} />
                  </div>
                ) : (
                  <div style={{ padding: '32px', textAlign: 'center', background: '#0f172a', borderRadius: '8px', color: '#94a3b8' }}>
                    No chunk binary data found for playback.
                  </div>
                )}

                {/* Chunk Inspection Table */}
                <div>
                  <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#cbd5e1' }}>Stored Chunks Manifest ({chunks.length})</h4>
                  <div style={{ maxHeight: '200px', overflowY: 'auto', background: '#0f172a', borderRadius: '8px', border: '1px solid #334155' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ background: '#1e293b', borderBottom: '1px solid #334155' }}>
                          <th style={{ padding: '8px 12px' }}>Seq #</th>
                          <th style={{ padding: '8px 12px' }}>Timestamp</th>
                          <th style={{ padding: '8px 12px' }}>Size</th>
                          <th style={{ padding: '8px 12px' }}>Type</th>
                          <th style={{ padding: '8px 12px' }}>isFinal</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chunks.map((c) => (
                          <tr key={`${c.sessionId}-${c.sequenceNumber}`} style={{ borderBottom: '1px solid #1e293b' }}>
                            <td style={{ padding: '8px 12px', fontWeight: 'bold' }}>#{c.sequenceNumber}</td>
                            <td style={{ padding: '8px 12px', color: '#94a3b8' }}>{new Date(c.timestamp).toLocaleTimeString()}</td>
                            <td style={{ padding: '8px 12px' }}>{formatBytes(c.byteSize)}</td>
                            <td style={{ padding: '8px 12px', color: '#94a3b8' }}>{c.mimeType}</td>
                            <td style={{ padding: '8px 12px' }}>{c.isFinal ? '✅ Yes' : 'No'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: '48px', textAlign: 'center', background: '#1e293b', borderRadius: '12px', color: '#94a3b8' }}>
                Select a recording session from the sidebar to inspect.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
