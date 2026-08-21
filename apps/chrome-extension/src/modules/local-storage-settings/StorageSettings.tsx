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
import { Badge, CheckIcon, WarnIcon, LinkButton } from '../mic-permission/MicPermissionSettings.js';

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
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', whiteSpace: 'nowrap', fontSize: '13px' }}>
      <FolderIcon />
      <span style={{ color: '#475569', fontWeight: 500 }}>Storage</span>
      <span style={{ fontWeight: 600, color: '#0f172a' }}>Local</span>

      {state.kind === 'unsupported' && (
        <Badge
          tone="error"
          icon={<WarnIcon />}
          title="Your browser doesn't support choosing a local folder (File System Access API unavailable)."
        >
          Unsupported
        </Badge>
      )}

      {(state.kind === 'loading' || state.kind === 'checking') && (
        <span style={{ color: '#94a3b8' }}>{state.kind === 'checking' ? `/ ${state.name}` : 'Loading…'}</span>
      )}

      {state.kind === 'empty' && (
        <>
          <Badge tone="neutral">Not set</Badge>
          <LinkButton label="Choose folder" onClick={handleChooseFolder} disabled={busy} />
        </>
      )}

      {state.kind === 'needs-permission' && (
        <>
          <span style={{ color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>
            / {state.name}
          </span>
          <Badge tone="warn" icon={<WarnIcon />} title="Permission needed to use this folder again.">
            Needs permission
          </Badge>
          <LinkButton label="Grant permission" onClick={handleReauthorize} disabled={busy} />
          <LinkButton label="Change folder" onClick={handleChooseFolder} disabled={busy} />
        </>
      )}

      {state.kind === 'denied' && (
        <>
          <span style={{ color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>
            / {state.name}
          </span>
          <Badge tone="error" icon={<WarnIcon />} title="Permission denied. Choose a folder again to continue.">
            Denied
          </Badge>
          <LinkButton label="Change folder" onClick={handleChooseFolder} disabled={busy} />
        </>
      )}

      {state.kind === 'not-found' && (
        <>
          <span style={{ color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>
            / {state.name}
          </span>
          <Badge tone="error" icon={<WarnIcon />} title="This folder no longer exists. Please choose another one.">
            Missing
          </Badge>
          <LinkButton label="Choose folder" onClick={handleChooseFolder} disabled={busy} />
        </>
      )}

      {state.kind === 'write-failed' && (
        <>
          <span style={{ color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>
            / {state.name}
          </span>
          <Badge tone="error" icon={<WarnIcon />} title={state.message}>
            Write failed
          </Badge>
          <LinkButton label="Change folder" onClick={handleChooseFolder} disabled={busy} />
        </>
      )}

      {state.kind === 'ready' && (
        <>
          <span style={{ color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' }}>
            / {state.name}
          </span>
          <Badge tone="success" icon={<CheckIcon />} title="Folder ready" />
          <LinkButton label="Change folder" onClick={handleChooseFolder} disabled={busy} />
        </>
      )}
    </div>
  );
};

const FolderIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </svg>
);
