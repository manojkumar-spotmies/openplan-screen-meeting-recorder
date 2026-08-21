import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';

// Everything else (folder-access.ts's permission logic, export-state-store.ts's real
// IndexedDB persistence, filename.ts) runs for real — only the one boundary that would
// otherwise require structured-cloning a fake FileSystemDirectoryHandle (impossible for a
// plain object carrying vi.fn() methods) is mocked, matching how a real
// getStoredDirectoryHandle() would hand back a real, method-bearing handle.
const { getStoredDirectoryHandle } = vi.hoisted(() => ({ getStoredDirectoryHandle: vi.fn() }));
vi.mock('../../local-storage-settings/directory-handle-store.js', () => ({
  getStoredDirectoryHandle,
}));

const { exportFinalVideoToLocalFolder } = await import('../export-final-video.js');
const { getExportStatus } = await import('../export-state-store.js');

interface FakeWritable {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
}

interface FakeFileHandle {
  createWritable: () => Promise<FakeWritable>;
  getFile: () => Promise<{ size: number }>;
}

interface FakeDirectoryHandle {
  name: string;
  queryPermission: (descriptor?: unknown) => Promise<string>;
  requestPermission: (descriptor?: unknown) => Promise<string>;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FakeFileHandle>;
  removeEntry: (name: string) => Promise<void>;
}

function makeFakeHandle(
  overrides: Partial<FakeDirectoryHandle> = {},
  existingFiles: Set<string> = new Set()
): FakeDirectoryHandle {
  const writtenSizes = new Map<string, number>();

  const defaultGetFileHandle = vi.fn(async (name: string, options?: { create?: boolean }) => {
    if (!existingFiles.has(name) && !options?.create) {
      throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
    }
    existingFiles.add(name);

    const fileHandle: FakeFileHandle = {
      createWritable: vi.fn(async () => ({
        write: vi.fn(async (data: Blob) => {
          writtenSizes.set(name, data.size);
        }),
        close: vi.fn(async () => {}),
      })),
      getFile: vi.fn(async () => ({ size: writtenSizes.get(name) || 0 })),
    };
    return fileHandle;
  });

  return {
    name: 'OpenPlanRecordings',
    queryPermission: vi.fn(async () => 'granted'),
    requestPermission: vi.fn(async () => 'granted'),
    getFileHandle: defaultGetFileHandle,
    removeEntry: vi.fn(async () => {}),
    ...overrides,
  };
}

function asHandle(fake: FakeDirectoryHandle): FileSystemDirectoryHandle {
  return fake as unknown as FileSystemDirectoryHandle;
}

function mockFetchOk(bytes: number) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array(bytes)]),
    text: async () => '',
  })) as unknown as typeof fetch;
}

function mockFetchFailed(status: number, body = 'video not ready') {
  return vi.fn(async () => ({
    ok: false,
    status,
    text: async () => body,
  })) as unknown as typeof fetch;
}

const SESSION_ID = 'export-test-session';

describe('exportFinalVideoToLocalFolder', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    getStoredDirectoryHandle.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('1. reports NO_FOLDER when nothing has been configured, and persists that state', async () => {
    getStoredDirectoryHandle.mockResolvedValue(undefined);

    const outcome = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');

    expect(outcome).toEqual({ state: 'NO_FOLDER' });
    expect((await getExportStatus(SESSION_ID))?.state).toBe('NO_FOLDER');
  });

  // Fixed local time so filenames embedding the recording timestamp are deterministic.
  const RECORDED_AT = new Date(2026, 7, 21, 14, 5, 9);
  const STAMPED_NAME = 'Sales Meeting 2026-08-21 14-05-09.webm';

  it('2-6. downloads and writes the final video when a folder is configured with granted permission', async () => {
    const fakeHandle = makeFakeHandle();
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));
    global.fetch = mockFetchOk(2048);

    const outcome = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting', { recordedAt: RECORDED_AT });

    expect(outcome.state).toBe('COMPLETED');
    expect(outcome.fileName).toBe(STAMPED_NAME);
    expect(outcome.folderName).toBe('OpenPlanRecordings');

    expect(fakeHandle.getFileHandle).toHaveBeenCalledWith(STAMPED_NAME, { create: true });

    const stored = await getExportStatus(SESSION_ID);
    expect(stored?.state).toBe('COMPLETED');
    expect(stored?.fileName).toBe(STAMPED_NAME);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/sessions/${SESSION_ID}/video`),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-user-id': expect.any(String) }) })
    );
  });

  it('7. avoids overwriting an existing file with the same name (same title, same recorded timestamp)', async () => {
    const fakeHandle = makeFakeHandle({}, new Set([STAMPED_NAME]));
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));
    global.fetch = mockFetchOk(1024);

    const outcome = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting', { recordedAt: RECORDED_AT });

    expect(outcome.state).toBe('COMPLETED');
    expect(outcome.fileName).toBe('Sales Meeting 2026-08-21 14-05-09 (1).webm');
  });

  it('names two different sessions with the same title distinctly, using each one\'s own recording time', async () => {
    const fakeHandle = makeFakeHandle();
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));
    global.fetch = mockFetchOk(1024);

    const first = await exportFinalVideoToLocalFolder('session-a', 'Meeting Recording', {
      recordedAt: new Date(2026, 7, 21, 9, 0, 0),
    });
    const second = await exportFinalVideoToLocalFolder('session-b', 'Meeting Recording', {
      recordedAt: new Date(2026, 7, 21, 15, 30, 0),
    });

    expect(first.fileName).toBe('Meeting Recording 2026-08-21 09-00-00.webm');
    expect(second.fileName).toBe('Meeting Recording 2026-08-21 15-30-00.webm');
  });

  it('9. reports NEEDS_PERMISSION without auto-prompting when permission is only "prompt"', async () => {
    const fakeHandle = makeFakeHandle({ queryPermission: vi.fn(async () => 'prompt') });
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));

    const outcome = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');

    expect(outcome).toEqual({ state: 'NEEDS_PERMISSION', folderName: 'OpenPlanRecordings' });
    expect(fakeHandle.requestPermission).not.toHaveBeenCalled();
  });

  it('10. reports PERMISSION_DENIED when permission was denied', async () => {
    const fakeHandle = makeFakeHandle({ queryPermission: vi.fn(async () => 'denied') });
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));

    const outcome = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');

    expect(outcome).toEqual({ state: 'PERMISSION_DENIED', folderName: 'OpenPlanRecordings' });
  });

  it('11. reports FOLDER_UNAVAILABLE when the folder itself no longer exists on disk', async () => {
    const fakeHandle = makeFakeHandle({
      getFileHandle: vi.fn(async () => {
        throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
      }),
    });
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));
    global.fetch = mockFetchOk(1024);

    const outcome = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');

    expect(outcome.state).toBe('FOLDER_UNAVAILABLE');
  });

  it('12. reports FAILED when the backend download itself fails, without touching the folder', async () => {
    const fakeHandle = makeFakeHandle();
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));
    global.fetch = mockFetchFailed(409, 'ERR_VIDEO_NOT_READY');

    const outcome = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');

    expect(outcome.state).toBe('FAILED');
    expect(outcome.errorMessage).toMatch(/Failed to download/);
    expect(fakeHandle.getFileHandle).not.toHaveBeenCalled();
  });

  it('13. reports FAILED when writing to the folder fails', async () => {
    const fakeHandle = makeFakeHandle({
      getFileHandle: vi.fn(async () => ({
        createWritable: vi.fn(async () => ({
          write: vi.fn(async () => {
            throw new Error('disk full');
          }),
          close: vi.fn(async () => {}),
        })),
        getFile: vi.fn(async () => ({ size: 0 })),
      })),
    });
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));
    global.fetch = mockFetchOk(1024);

    const outcome = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');

    expect(outcome.state).toBe('FAILED');
    expect(outcome.errorMessage).toMatch(/disk full/);
  });

  it('14. retry succeeds after a previous failure, without re-downloading being blocked by prior state', async () => {
    const failingHandle = makeFakeHandle({
      getFileHandle: vi.fn(async () => {
        throw new Error('transient failure');
      }),
    });
    getStoredDirectoryHandle.mockResolvedValue(asHandle(failingHandle));
    global.fetch = mockFetchOk(1024);

    const firstAttempt = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');
    expect(firstAttempt.state).toBe('FAILED');

    const workingHandle = makeFakeHandle();
    getStoredDirectoryHandle.mockResolvedValue(asHandle(workingHandle));

    const retry = await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');
    expect(retry.state).toBe('COMPLETED');

    const stored = await getExportStatus(SESSION_ID);
    expect(stored?.state).toBe('COMPLETED');
  });

  it('15. never attempts to delete anything, even on failure — the backend video stays authoritative', async () => {
    const fakeHandle = makeFakeHandle();
    getStoredDirectoryHandle.mockResolvedValue(asHandle(fakeHandle));
    global.fetch = mockFetchFailed(500, 'boom');

    await exportFinalVideoToLocalFolder(SESSION_ID, 'Sales Meeting');

    expect(fakeHandle.removeEntry).not.toHaveBeenCalled();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect((init?.method || 'GET').toUpperCase()).not.toBe('DELETE');
    }
  });
});
