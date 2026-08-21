import React, { useState, useEffect } from 'react';
import { LocalVideoSession, LocalVideoChunk } from '@openplan/contracts';
import {
  getAllSessions,
  getChunksForSession,
  getMissingSequences,
  deleteSession,
} from '../modules/offline-cache/idb-store.js';
import { exportFinalVideoToLocalFolder } from '../modules/local-export/export-final-video.js';
import { getExportStatus, ExportStatusRecord } from '../modules/local-export/export-state-store.js';

// Same defaults export-final-video.ts uses for the identical endpoint — kept local rather
// than shared to match this codebase's existing pattern of per-module backend constants
// (see sync-worker.ts, service-worker.ts, export-final-video.ts).
const BACKEND_BASE_URL = 'http://localhost:4000';
const DEFAULT_USER_ID = 'dev-user-1';

/**
 * Fetches the backend's already-verified final video (the same GET endpoint
 * exportFinalVideoToLocalFolder uses) — the authoritative combined recording, and the
 * only source left once sync-worker.ts has purged local chunk blobs after upload. Returns
 * null (not a throw) for any non-success outcome — "not available yet" is an expected,
 * common state (still processing, never synced, backend unreachable), not an error to surface.
 */
export async function fetchBackendVideoBlob(sessionId: string): Promise<Blob | null> {
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/api/v1/sessions/${sessionId}/video`, {
      headers: { 'x-user-id': DEFAULT_USER_ID },
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    return blob.size > 0 ? blob : null;
  } catch {
    return null;
  }
}

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
  const [videoSource, setVideoSource] = useState<'backend' | 'local-chunks' | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micStatus, setMicStatus] = useState<string | null>(null);
  const [exportStatus, setExportStatus] = useState<ExportStatusRecord | undefined>(undefined);
  const [exportBusy, setExportBusy] = useState<boolean>(false);

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
      setExportStatus(undefined);
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
        setVideoUrl(null);
        setVideoSource(null);
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
      setExportStatus(await getExportStatus(sessionId));

      const fetchedChunks = await getChunksForSession(sessionId);
      setChunks(fetchedChunks);

      const missing = await getMissingSequences(sessionId);
      setMissingSequences(missing);

      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
        setVideoUrl(null);
        setVideoSource(null);
      }

      // Prefer the backend's verified final video — it's the authoritative combined
      // recording and, for any session that's finished syncing, the ONLY place a playable
      // copy still exists (see fetchBackendVideoBlob's doc comment). Local chunk blobs are
      // the fallback for sessions that haven't synced yet.
      const backendBlob = await fetchBackendVideoBlob(sessionId);
      if (backendBlob) {
        setVideoUrl(URL.createObjectURL(backendBlob));
        setVideoSource('backend');
      } else if (fetchedChunks.length > 0) {
        const unifiedBlob = concatenateChunksToBlob(fetchedChunks);
        if (unifiedBlob.size > 0) {
          setVideoUrl(URL.createObjectURL(unifiedBlob));
          setVideoSource('local-chunks');
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

  const handleSaveToLocalFolder = async () => {
    if (!selectedSessionId || !selectedSession || exportBusy) return;
    setExportBusy(true);
    try {
      // exportFinalVideoToLocalFolder downloads the backend's already-verified final
      // video (never re-runs recording/chunking/FFmpeg) and persists its own outcome —
      // safe to call again as a retry after a previous failure.
      await exportFinalVideoToLocalFolder(selectedSessionId, selectedSession.title, {
        recordedAt: selectedSession.createdAt,
      });
      setExportStatus(await getExportStatus(selectedSessionId));
    } finally {
      setExportBusy(false);
    }
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

                {/* Local folder export (Step 2B) — downloads the backend's already-verified
                    final video and writes it to the user's selected folder; independent of
                    recording/session status above, so a failed export never implies the
                    recording itself failed. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', background: '#0f172a', borderRadius: '8px', marginBottom: '20px', fontSize: '12px' }}>
                  <span style={{ color: '#94a3b8' }}>Local folder export:</span>
                  <span style={{ flex: 1, color: exportStatusColor(exportStatus?.state) }}>
                    {describeExportStatus(exportStatus)}
                  </span>
                  <button
                    onClick={handleSaveToLocalFolder}
                    disabled={exportBusy}
                    style={{
                      padding: '6px 12px',
                      background: 'transparent',
                      color: '#94a3b8',
                      border: '1px solid #475569',
                      borderRadius: '6px',
                      fontSize: '12px',
                      cursor: exportBusy ? 'default' : 'pointer',
                      opacity: exportBusy ? 0.6 : 1,
                    }}
                  >
                    {exportBusy
                      ? 'Saving…'
                      : exportStatus?.state === 'COMPLETED'
                        ? 'Save Again'
                        : exportStatus
                          ? 'Retry Save'
                          : 'Save to Local Folder'}
                  </button>
                </div>

                {/* Unified Video Player Preview */}
                {videoUrl ? (
                  <div style={{ marginBottom: '20px' }}>
                    <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', color: '#cbd5e1' }}>
                      {videoSource === 'backend' ? 'Final Video (from backend)' : 'Chunk Preview (local, not yet synced)'}
                    </h4>
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

function describeExportStatus(status: ExportStatusRecord | undefined): string {
  if (!status) return 'Not saved yet';
  switch (status.state) {
    case 'PENDING':
    case 'EXPORTING':
      return 'Saving…';
    case 'COMPLETED':
      return `✓ Saved as "${status.fileName}" in ${status.folderName}`;
    case 'NO_FOLDER':
      return 'No local folder configured — open Storage Settings';
    case 'NEEDS_PERMISSION':
      return `Permission needed for "${status.folderName}" — open Storage Settings`;
    case 'PERMISSION_DENIED':
      return `Permission denied for "${status.folderName}"`;
    case 'FOLDER_UNAVAILABLE':
      return `"${status.folderName}" is no longer available`;
    case 'FAILED':
      return status.errorMessage || 'Save failed';
    default:
      return 'Not saved yet';
  }
}

function exportStatusColor(state: ExportStatusRecord['state'] | undefined): string {
  if (state === 'COMPLETED') return '#4ade80';
  if (state === 'PENDING' || state === 'EXPORTING' || state === undefined) return '#94a3b8';
  return '#fde047';
}
