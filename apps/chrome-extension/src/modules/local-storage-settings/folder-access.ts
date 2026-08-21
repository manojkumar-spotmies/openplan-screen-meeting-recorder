const WRITE_TEST_FILENAME = '.openplan-storage-test.tmp';
const WRITE_TEST_CONTENT = 'openplan-storage-write-test';

export type PermissionCheckResult = 'granted' | 'needs-permission' | 'denied';

export type WriteTestResult =
  | { ok: true }
  | { ok: false; code: 'not-found' | 'write-failed'; message: string };

export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/**
 * Opens the native folder picker. Must be called directly from a user-gesture event
 * handler (e.g. a button's onClick) — the browser rejects the call otherwise.
 * Returns null (not an error) when the user cancels the picker.
 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('ERR_FS_ACCESS_UNSUPPORTED');
  }
  try {
    return await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return null;
    }
    throw err;
  }
}

/** Non-prompting check of whatever permission state is currently in effect for this handle. */
export async function checkStoredPermission(handle: FileSystemDirectoryHandle): Promise<PermissionCheckResult> {
  const state = await handle.queryPermission({ mode: 'readwrite' });
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'needs-permission';
}

/**
 * Re-prompts for permission. Like pickDirectory, this must be invoked from a user-gesture
 * event handler — browsers refuse requestPermission() calls made outside one.
 */
export async function requestReauthorization(handle: FileSystemDirectoryHandle): Promise<PermissionCheckResult> {
  const state = await handle.requestPermission({ mode: 'readwrite' });
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'needs-permission';
}

/**
 * Proves the folder is actually writable by creating a tiny temp file, verifying its
 * content, then deleting it. The temp file must never remain afterward — cleanup runs
 * even on failure, in case creation itself partially succeeded.
 */
export async function testWriteAccess(handle: FileSystemDirectoryHandle): Promise<WriteTestResult> {
  try {
    const fileHandle = await handle.getFileHandle(WRITE_TEST_FILENAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(WRITE_TEST_CONTENT);
    await writable.close();

    const file = await fileHandle.getFile();
    const text = await file.text();
    await handle.removeEntry(WRITE_TEST_FILENAME);

    if (text !== WRITE_TEST_CONTENT) {
      return { ok: false, code: 'write-failed', message: 'Write verification failed: content did not match.' };
    }
    return { ok: true };
  } catch (err) {
    try {
      await handle.removeEntry(WRITE_TEST_FILENAME);
    } catch {
      // Nothing to clean up — the file was likely never created.
    }

    const name = err instanceof DOMException ? err.name : undefined;
    if (name === 'NotFoundError') {
      return { ok: false, code: 'not-found', message: 'The selected folder no longer exists.' };
    }
    return {
      ok: false,
      code: 'write-failed',
      message: 'Unable to write to this folder. Please choose another folder or grant permission.',
    };
  }
}
