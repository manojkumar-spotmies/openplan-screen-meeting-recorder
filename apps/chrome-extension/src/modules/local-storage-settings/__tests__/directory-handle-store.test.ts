import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import {
  saveDirectoryHandle,
  getStoredDirectoryHandle,
  clearStoredDirectoryHandle,
} from '../directory-handle-store.js';

function fakeHandle(name: string): FileSystemDirectoryHandle {
  return { name, kind: 'directory' } as unknown as FileSystemDirectoryHandle;
}

describe('directory-handle-store', () => {
  it('1. returns undefined when no folder has ever been selected', async () => {
    await clearStoredDirectoryHandle();
    const stored = await getStoredDirectoryHandle();
    expect(stored).toBeUndefined();
  });

  it('2 & 3. persists a selected directory handle and retrieves it back', async () => {
    const handle = fakeHandle('OpenPlanRecordings');
    await saveDirectoryHandle(handle);

    const stored = await getStoredDirectoryHandle();
    expect(stored).toBeDefined();
    expect(stored?.name).toBe('OpenPlanRecordings');
  });

  it('overwrites the previously stored handle when the user changes folders', async () => {
    await saveDirectoryHandle(fakeHandle('FirstFolder'));
    await saveDirectoryHandle(fakeHandle('SecondFolder'));

    const stored = await getStoredDirectoryHandle();
    expect(stored?.name).toBe('SecondFolder');
  });

  it('clears the stored handle', async () => {
    await saveDirectoryHandle(fakeHandle('ToBeCleared'));
    await clearStoredDirectoryHandle();

    const stored = await getStoredDirectoryHandle();
    expect(stored).toBeUndefined();
  });
});
