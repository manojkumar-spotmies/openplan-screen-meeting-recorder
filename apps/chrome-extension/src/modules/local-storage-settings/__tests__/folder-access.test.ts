import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isFileSystemAccessSupported,
  pickDirectory,
  checkStoredPermission,
  requestReauthorization,
  testWriteAccess,
} from '../folder-access.js';

interface FakeWritable {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
}

interface FakeFileHandle {
  createWritable: () => Promise<FakeWritable>;
  getFile: () => Promise<{ text: () => Promise<string> }>;
}

interface FakeDirectoryHandle {
  name: string;
  queryPermission: (descriptor?: unknown) => Promise<string>;
  requestPermission: (descriptor?: unknown) => Promise<string>;
  getFileHandle: (name: string, options?: unknown) => Promise<FakeFileHandle>;
  removeEntry: (name: string) => Promise<void>;
}

function makeFakeHandle(overrides: Partial<FakeDirectoryHandle> = {}): FakeDirectoryHandle {
  let writtenContent = '';

  const writable: FakeWritable = {
    write: vi.fn(async (data: string) => {
      writtenContent = data;
    }),
    close: vi.fn(async () => {}),
  };

  const fileHandle: FakeFileHandle = {
    createWritable: vi.fn(async () => writable),
    getFile: vi.fn(async () => ({ text: async () => writtenContent })),
  };

  return {
    name: 'OpenPlanRecordings',
    queryPermission: vi.fn(async () => 'granted'),
    requestPermission: vi.fn(async () => 'granted'),
    getFileHandle: vi.fn(async () => fileHandle),
    removeEntry: vi.fn(async () => {}),
    ...overrides,
  };
}

function asHandle(fake: FakeDirectoryHandle): FileSystemDirectoryHandle {
  return fake as unknown as FileSystemDirectoryHandle;
}

describe('folder-access', () => {
  afterEach(() => {
    // @ts-expect-error — test-only cleanup of a global we stub per-test
    delete window.showDirectoryPicker;
  });

  describe('isFileSystemAccessSupported', () => {
    it('reports false when showDirectoryPicker is unavailable', () => {
      expect(isFileSystemAccessSupported()).toBe(false);
    });

    it('reports true when showDirectoryPicker exists', () => {
      window.showDirectoryPicker = vi.fn();
      expect(isFileSystemAccessSupported()).toBe(true);
    });
  });

  describe('pickDirectory', () => {
    it('throws a clear error when the API is unsupported', async () => {
      await expect(pickDirectory()).rejects.toThrow('ERR_FS_ACCESS_UNSUPPORTED');
    });

    it('returns the picked handle on success', async () => {
      const fake = makeFakeHandle();
      window.showDirectoryPicker = vi.fn(async () => asHandle(fake));

      const result = await pickDirectory();
      expect(result?.name).toBe('OpenPlanRecordings');
    });

    it('7. returns null (not an error) when the user cancels the picker', async () => {
      window.showDirectoryPicker = vi.fn(async () => {
        throw new DOMException('The user aborted a request.', 'AbortError');
      });

      const result = await pickDirectory();
      expect(result).toBeNull();
    });

    it('rethrows unexpected errors from the picker', async () => {
      window.showDirectoryPicker = vi.fn(async () => {
        throw new Error('Something else went wrong');
      });

      await expect(pickDirectory()).rejects.toThrow('Something else went wrong');
    });
  });

  describe('4. permission handling', () => {
    it('checkStoredPermission maps granted/prompt/denied correctly', async () => {
      const granted = makeFakeHandle({ queryPermission: vi.fn(async () => 'granted') });
      const prompt = makeFakeHandle({ queryPermission: vi.fn(async () => 'prompt') });
      const denied = makeFakeHandle({ queryPermission: vi.fn(async () => 'denied') });

      expect(await checkStoredPermission(asHandle(granted))).toBe('granted');
      expect(await checkStoredPermission(asHandle(prompt))).toBe('needs-permission');
      expect(await checkStoredPermission(asHandle(denied))).toBe('denied');
    });

    it('requestReauthorization maps the re-prompt result correctly', async () => {
      const handle = makeFakeHandle({ requestPermission: vi.fn(async () => 'granted') });
      expect(await requestReauthorization(asHandle(handle))).toBe('granted');
      expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    });

    it('8. surfaces denied permission distinctly from other failures', async () => {
      const handle = makeFakeHandle({ requestPermission: vi.fn(async () => 'denied') });
      expect(await requestReauthorization(asHandle(handle))).toBe('denied');
    });
  });

  describe('5 & 6. testWriteAccess', () => {
    it('succeeds and removes the temporary file afterward', async () => {
      const handle = makeFakeHandle();
      const result = await testWriteAccess(asHandle(handle));

      expect(result).toEqual({ ok: true });
      expect(handle.getFileHandle).toHaveBeenCalledWith('.openplan-storage-test.tmp', { create: true });
      expect(handle.removeEntry).toHaveBeenCalledWith('.openplan-storage-test.tmp');
    });

    it('reports write-failed and still attempts cleanup when the folder cannot be written to', async () => {
      const handle = makeFakeHandle({
        getFileHandle: vi.fn(async () => {
          throw new Error('permission-ish failure');
        }),
      });

      const result = await testWriteAccess(asHandle(handle));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('write-failed');
        expect(result.message).toMatch(/Unable to write/);
      }
      expect(handle.removeEntry).toHaveBeenCalled();
    });

    it('reports not-found when the folder was deleted on disk', async () => {
      const handle = makeFakeHandle({
        getFileHandle: vi.fn(async () => {
          throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
        }),
      });

      const result = await testWriteAccess(asHandle(handle));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('not-found');
      }
    });

    it('does not leave the temp file behind even if cleanup itself fails to find it', async () => {
      const handle = makeFakeHandle({
        removeEntry: vi.fn(async () => {
          throw new DOMException('not found', 'NotFoundError');
        }),
      });

      // Should not throw despite removeEntry failing during the success-path cleanup.
      const result = await testWriteAccess(asHandle(handle));
      expect(result.ok).toBe(false);
    });
  });
});
