import React, { useEffect, useState, useCallback } from 'react';
import { logger } from '@openplan/core';
import { getStoredDirectoryHandle, saveDirectoryHandle } from './directory-handle-store.js';
import {
  isFileSystemAccessSupported,
  pickDirectory,
  checkStoredPermission,
  requestReauthorization,
  testWriteAccess,
} from './folder-access.js';

type FolderState =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'checking'; name: string }
  | { kind: 'needs-permission'; name: string }
  | { kind: 'denied'; name: string }
  | { kind: 'not-found'; name: string }
  | { kind: 'ready'; name: string }
  | { kind: 'write-failed'; name: string; message: string };

export const StorageSettings: React.FC = () => {
  const [state, setState] = useState<FolderState>({ kind: 'loading' });
  const [handle, setHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [busy, setBusy] = useState(false);

  const evaluateHandle = useCallback(async (h: FileSystemDirectoryHandle) => {
    setState({ kind: 'checking', name: h.name });
    const permission = await checkStoredPermission(h);

    if (permission === 'denied') {
      setState({ kind: 'denied', name: h.name });
      return;
    }
    if (permission === 'needs-permission') {
      // Never auto-prompt here — requestPermission() requires a user gesture, and
      // silently retrying it on every load would either fail or spam the user.
      setState({ kind: 'needs-permission', name: h.name });
      return;
    }

    const writeResult = await testWriteAccess(h);
    if (!writeResult.ok) {
      if (writeResult.code === 'not-found') {
        setState({ kind: 'not-found', name: h.name });
      } else {
        setState({ kind: 'write-failed', name: h.name, message: writeResult.message });
      }
      return;
    }
    setState({ kind: 'ready', name: h.name });
  }, []);

  useEffect(() => {
    if (!isFileSystemAccessSupported()) {
      setState({ kind: 'unsupported' });
      return;
    }

    (async () => {
      try {
        const stored = await getStoredDirectoryHandle();
        if (!stored) {
          setState({ kind: 'empty' });
          return;
        }
        setHandle(stored);
        await evaluateHandle(stored);
      } catch (err) {
        logger.error('Failed to load stored recording folder handle:', err);
        setState({ kind: 'empty' });
      }
    })();
  }, [evaluateHandle]);

  const handleChooseFolder = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const picked = await pickDirectory();
      if (!picked) {
        // User cancelled — leave whatever was previously shown untouched.
        return;
      }
      await saveDirectoryHandle(picked);
      setHandle(picked);
      await evaluateHandle(picked);
    } catch (err) {
      logger.error('Folder selection failed:', err);
      setState({
        kind: 'write-failed',
        name: handle?.name ?? 'selected folder',
        message: err instanceof Error ? err.message : 'Failed to select a folder.',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleReauthorize = async () => {
    if (!handle || busy) return;
    setBusy(true);
    try {
      const result = await requestReauthorization(handle);
      if (result === 'granted') {
        await evaluateHandle(handle);
      } else if (result === 'denied') {
        setState({ kind: 'denied', name: handle.name });
      } else {
        setState({ kind: 'needs-permission', name: handle.name });
      }
    } catch (err) {
      logger.error('Re-authorization failed:', err);
      setState({ kind: 'needs-permission', name: handle.name });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ fontFamily: 'sans-serif', color: '#e2e8f0', maxWidth: '420px' }}>
      <h3 style={{ margin: '0 0 12px 0', fontSize: '16px', color: '#f8fafc' }}>Storage</h3>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#3b82f6' }} />
        <span style={{ fontSize: '13px', fontWeight: 600 }}>Local</span>
      </div>

      <div style={{ background: '#1e293b', padding: '16px', borderRadius: '10px' }}>
        <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '6px' }}>Recording folder</div>

        {state.kind === 'unsupported' && (
          <FolderPanel message="Your browser doesn't support choosing a local folder (File System Access API unavailable)." tone="error" />
        )}

        {(state.kind === 'loading' || state.kind === 'checking') && (
          <FolderPanel message={state.kind === 'checking' ? state.name : 'Loading…'} tone="neutral" />
        )}

        {state.kind === 'empty' && (
          <>
            <FolderPanel message="No folder selected" tone="neutral" />
            <ActionButton label="Choose Folder" onClick={handleChooseFolder} disabled={busy} />
          </>
        )}

        {state.kind === 'needs-permission' && (
          <>
            <FolderPanel message={state.name} tone="neutral" />
            <StatusLine tone="warn" text="Permission needed to use this folder again." />
            <ActionButton label="Grant Permission" onClick={handleReauthorize} disabled={busy} />
            <ActionButton label="Change Folder" onClick={handleChooseFolder} disabled={busy} secondary />
          </>
        )}

        {state.kind === 'denied' && (
          <>
            <FolderPanel message={state.name} tone="neutral" />
            <StatusLine tone="error" text="Permission denied. Choose a folder again to continue." />
            <ActionButton label="Change Folder" onClick={handleChooseFolder} disabled={busy} />
          </>
        )}

        {state.kind === 'not-found' && (
          <>
            <FolderPanel message={state.name} tone="neutral" />
            <StatusLine tone="error" text="This folder no longer exists. Please choose another one." />
            <ActionButton label="Choose Folder" onClick={handleChooseFolder} disabled={busy} />
          </>
        )}

        {state.kind === 'write-failed' && (
          <>
            <FolderPanel message={state.name} tone="neutral" />
            <StatusLine tone="error" text={state.message} />
            <ActionButton label="Change Folder" onClick={handleChooseFolder} disabled={busy} />
          </>
        )}

        {state.kind === 'ready' && (
          <>
            <FolderPanel message={state.name} tone="neutral" />
            <StatusLine tone="success" text="Folder ready" />
            <ActionButton label="Change Folder" onClick={handleChooseFolder} disabled={busy} secondary />
          </>
        )}
      </div>
    </div>
  );
};

const FolderPanel: React.FC<{ message: string; tone: 'neutral' | 'error' }> = ({ message, tone }) => (
  <div
    style={{
      fontSize: '14px',
      fontWeight: 600,
      color: tone === 'error' ? '#f87171' : '#f1f5f9',
      marginBottom: '10px',
    }}
  >
    {message}
  </div>
);

const StatusLine: React.FC<{ tone: 'success' | 'warn' | 'error'; text: string }> = ({ tone, text }) => {
  const colors = {
    success: { color: '#4ade80', icon: '✓' },
    warn: { color: '#fde047', icon: '⚠️' },
    error: { color: '#f87171', icon: '⚠️' },
  } as const;
  const { color, icon } = colors[tone];
  return (
    <div style={{ fontSize: '12px', color, marginBottom: '10px' }}>
      {icon} {text}
    </div>
  );
};

const ActionButton: React.FC<{ label: string; onClick: () => void; disabled?: boolean; secondary?: boolean }> = ({
  label,
  onClick,
  disabled,
  secondary,
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    style={{
      padding: '8px 14px',
      background: secondary ? 'transparent' : '#2563eb',
      color: secondary ? '#94a3b8' : '#ffffff',
      border: secondary ? '1px solid #475569' : 'none',
      borderRadius: '6px',
      fontSize: '12px',
      fontWeight: 600,
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      marginRight: '8px',
    }}
  >
    {label}
  </button>
);
