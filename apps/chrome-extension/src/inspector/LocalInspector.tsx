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
import { BACKEND_BASE_URL } from '../config/backend-config.js';
import { StorageSettings } from '../modules/local-storage-settings/StorageSettings.js';
import { MicPermissionSettings } from '../modules/mic-permission/MicPermissionSettings.js';

const DEFAULT_USER_ID = 'dev-user-1';

// Presentational tokens only — no functional/business meaning.
const COLORS = {
  bg: '#f8fafc',
  surface: '#ffffff',
  border: '#e5e7eb',
  textPrimary: '#0f172a',
  textSecondary: '#64748b',
  accent: '#2563eb',
  accentSoft: '#eff6ff',
  success: '#16a34a',
  danger: '#dc2626',
  dangerSoft: '#fef2f2',
  warn: '#b45309',
  warnSoft: '#fffbeb',
} as const;

const thStyle: React.CSSProperties = {
  padding: '8px 12px',
  fontWeight: 600,
  color: COLORS.textSecondary,
  fontSize: '11px',
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 12px',
  color: COLORS.textPrimary,
};

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
  const [exportStatus, setExportStatus] = useState<ExportStatusRecord | undefined>(undefined);
  const [exportBusy, setExportBusy] = useState<boolean>(false);

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
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', minHeight: '100vh', background: COLORS.bg, color: COLORS.textPrimary }}>
      <div style={{ maxWidth: '1120px', margin: '0 auto', padding: '32px 32px 56px' }}>
        <header style={{ borderBottom: `1px solid ${COLORS.border}`, paddingBottom: '24px', marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '24px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: '0 0 6px 0', fontSize: '20px', fontWeight: 600, letterSpacing: '-0.01em', color: COLORS.textPrimary }}>
              Openplan Meeting Recorder
            </h1>
            <p style={{ margin: 0, fontSize: '13px', color: COLORS.textSecondary, maxWidth: '560px', lineHeight: 1.5 }}>
              Capture every meeting. Keep every moment.
            </p>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '20px',
              padding: '12px 18px',
              background: COLORS.surface,
              border: `1px solid ${COLORS.border}`,
              borderRadius: '10px',
              boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
              flexWrap: 'wrap',
            }}
          >
            <MicPermissionSettings />
            <div style={{ width: '1px', height: '16px', background: COLORS.border }} />
            <StorageSettings />
          </div>
        </header>

        {errorMessage && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '10px 14px', background: COLORS.dangerSoft, border: '1px solid #fecaca', color: '#b91c1c', borderRadius: '10px', marginBottom: '20px', fontSize: '13px' }}>
            <span>⚠️</span>
            <span>{errorMessage}</span>
          </div>
        )}

        {loading ? (
          <div style={{ padding: '48px 0', textAlign: 'center', color: COLORS.textSecondary, fontSize: '14px' }}>Loading IndexedDB sessions…</div>
        ) : sessions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '64px 24px' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '6px' }}>No Local Recordings Found</div>
            <div style={{ fontSize: '13px', color: COLORS.textSecondary }}>Use the Chrome extension popup to capture a screen recording.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: '32px', alignItems: 'start' }}>
            {/* Sidebar Session List */}
            <div>
              <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: COLORS.textSecondary, marginBottom: '12px' }}>
                Recorded Sessions ({sessions.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', maxHeight: '640px', overflowY: 'auto', border: `1px solid ${COLORS.border}`, borderRadius: '12px', padding: '4px', background: COLORS.surface }}>
                {sessions.map((s) => {
                  const active = s.sessionId === selectedSessionId;
                  return (
                    <div
                      key={s.sessionId}
                      onClick={() => setSelectedSessionId(s.sessionId)}
                      style={{
                        padding: '10px 12px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        background: active ? COLORS.accentSoft : 'transparent',
                        borderLeft: active ? `3px solid ${COLORS.accent}` : '3px solid transparent',
                      }}
                    >
                      <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '3px', color: COLORS.textPrimary }}>{s.title}</div>
                      <div style={{ fontSize: '11px', color: COLORS.textSecondary, marginBottom: '4px' }}>
                        {new Date(s.createdAt).toLocaleString()}
                      </div>
                      <div style={{ fontSize: '11px', color: COLORS.textSecondary }}>
                        {formatTime(s.durationSeconds)} · {s.totalChunks} chunks
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Main Inspection & Player Panel */}
            <div>
              {selectedSession ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '18px', gap: '16px' }}>
                    <div>
                      <h2 style={{ margin: '0 0 4px 0', fontSize: '16px', fontWeight: 600, color: COLORS.textPrimary }}>{selectedSession.title}</h2>
                      <div style={{ fontSize: '12px', color: COLORS.textSecondary, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                        ID: {selectedSession.sessionId}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                      <button
                        onClick={handleExportWebM}
                        disabled={chunks.length === 0}
                        style={{
                          padding: '7px 14px',
                          background: chunks.length === 0 ? '#93c5fd' : COLORS.accent,
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: '8px',
                          fontSize: '12.5px',
                          fontWeight: 600,
                          cursor: chunks.length === 0 ? 'not-allowed' : 'pointer',
                        }}
                      >
                        Export WebM
                      </button>
                      <button
                        onClick={() => handleDeleteSession(selectedSession.sessionId)}
                        style={{
                          padding: '7px 14px',
                          background: '#ffffff',
                          color: COLORS.danger,
                          border: '1px solid #fecaca',
                          borderRadius: '8px',
                          fontSize: '12.5px',
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
                    <div style={{ padding: '10px 14px', background: COLORS.warnSoft, border: '1px solid #fde68a', color: '#92400e', borderRadius: '10px', marginBottom: '16px', fontSize: '12.5px' }}>
                      ⚠️ <strong>Recording incomplete:</strong> Missing chunk sequence(s): {missingSequences.join(', ')}.
                    </div>
                  )}

                  {/* Metadata details — single compact horizontal bar */}
                  <div style={{ display: 'flex', border: `1px solid ${COLORS.border}`, borderRadius: '10px', marginBottom: '16px', overflow: 'hidden', background: COLORS.surface }}>
                    {[
                      ['Status', selectedSession.status],
                      ['Mode', selectedSession.captureMode],
                      ['Duration', formatTime(selectedSession.durationSeconds)],
                      ['Size', formatBytes(selectedSession.fileSizeBytes)],
                    ].map(([label, value], i) => (
                      <div key={label} style={{ flex: 1, padding: '10px 16px', borderLeft: i === 0 ? 'none' : `1px solid ${COLORS.border}` }}>
                        <div style={{ fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.05em', color: COLORS.textSecondary, marginBottom: '4px' }}>{label}</div>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: COLORS.textPrimary }}>{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Local folder export (Step 2B) — downloads the backend's already-verified
                      final video and writes it to the user's selected folder; independent of
                      recording/session status above, so a failed export never implies the
                      recording itself failed. */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '0 0 16px', marginBottom: '20px', borderBottom: `1px solid ${COLORS.border}`, fontSize: '12.5px' }}>
                    <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>Local folder export</span>
                    <span style={{ flex: 1, color: exportStatusColor(exportStatus?.state) }}>
                      {describeExportStatus(exportStatus)}
                    </span>
                    <button
                      onClick={handleSaveToLocalFolder}
                      disabled={exportBusy}
                      style={{
                        padding: '6px 12px',
                        background: '#ffffff',
                        color: exportBusy ? '#94a3b8' : '#334155',
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: '8px',
                        fontSize: '12px',
                        fontWeight: 600,
                        cursor: exportBusy ? 'default' : 'pointer',
                        opacity: exportBusy ? 0.7 : 1,
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
                    <div style={{ marginBottom: '24px' }}>
                      <div style={{ fontSize: '12.5px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '8px' }}>
                        {videoSource === 'backend' ? 'Final Video' : 'Chunk Preview (local, not yet synced)'}
                      </div>
                      <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: '12px', overflow: 'hidden', background: '#000000' }}>
                        <video controls src={videoUrl} style={{ width: '100%', maxHeight: '460px', display: 'block', background: '#000000' }} />
                      </div>
                    </div>
                  ) : (
                    <div style={{ padding: '28px', textAlign: 'center', color: COLORS.textSecondary, fontSize: '13px', border: `1px dashed ${COLORS.border}`, borderRadius: '12px', marginBottom: '24px' }}>
                      No chunk binary data found for playback.
                    </div>
                  )}

                  {/* Chunk Inspection Table */}
                  <div>
                    <div style={{ fontSize: '12.5px', fontWeight: 600, color: COLORS.textPrimary, marginBottom: '10px' }}>
                      Stored Chunks Manifest ({chunks.length})
                    </div>
                    <div style={{ maxHeight: '200px', overflowY: 'auto', border: `1px solid ${COLORS.border}`, borderRadius: '10px' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', textAlign: 'left' }}>
                        <thead>
                          <tr style={{ background: COLORS.bg, borderBottom: `1px solid ${COLORS.border}` }}>
                            <th style={thStyle}>Seq #</th>
                            <th style={thStyle}>Timestamp</th>
                            <th style={thStyle}>Size</th>
                            <th style={thStyle}>Type</th>
                            <th style={thStyle}>isFinal</th>
                          </tr>
                        </thead>
                        <tbody>
                          {chunks.map((c) => (
                            <tr key={`${c.sessionId}-${c.sequenceNumber}`} style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                              <td style={{ ...tdStyle, fontWeight: 700 }}>#{c.sequenceNumber}</td>
                              <td style={{ ...tdStyle, color: COLORS.textSecondary }}>{new Date(c.timestamp).toLocaleTimeString()}</td>
                              <td style={tdStyle}>{formatBytes(c.byteSize)}</td>
                              <td style={{ ...tdStyle, color: COLORS.textSecondary }}>{c.mimeType}</td>
                              <td style={tdStyle}>{c.isFinal ? '✅ Yes' : 'No'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '64px 24px', textAlign: 'center', color: COLORS.textSecondary, fontSize: '13.5px' }}>
                  Select a recording session from the sidebar to inspect.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
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
  if (state === 'COMPLETED') return COLORS.success;
  if (state === 'PENDING' || state === 'EXPORTING' || state === undefined) return COLORS.textSecondary;
  return COLORS.warn;
}
