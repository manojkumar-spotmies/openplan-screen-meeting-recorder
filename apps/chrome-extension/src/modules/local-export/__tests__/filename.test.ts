import { describe, it, expect, vi } from 'vitest';
import { sanitizeFilenameBase, generateUniqueFilename } from '../filename.js';

interface FakeDirectoryHandle {
  getFileHandle: (name: string) => Promise<unknown>;
}

function makeFakeHandle(existingFiles: Set<string>): FileSystemDirectoryHandle {
  const handle: FakeDirectoryHandle = {
    getFileHandle: vi.fn(async (name: string) => {
      if (existingFiles.has(name)) {
        return {};
      }
      throw new DOMException('not found', 'NotFoundError');
    }),
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

describe('sanitizeFilenameBase', () => {
  it('strips characters Windows forbids in filenames', () => {
    expect(sanitizeFilenameBase('Sales: <Meeting> "Notes"?*|')).toBe('Sales Meeting Notes');
  });

  it('trims trailing dots and spaces', () => {
    expect(sanitizeFilenameBase('Weekly Standup...   ')).toBe('Weekly Standup');
  });

  it('falls back to a default name when sanitization empties the title', () => {
    expect(sanitizeFilenameBase('///???')).toBe('Recording');
    expect(sanitizeFilenameBase('   ')).toBe('Recording');
  });

  it('disambiguates reserved Windows device names', () => {
    expect(sanitizeFilenameBase('CON')).toBe('CON_recording');
    expect(sanitizeFilenameBase('con')).toBe('con_recording');
    expect(sanitizeFilenameBase('LPT1')).toBe('LPT1_recording');
  });

  it('leaves an ordinary title untouched', () => {
    expect(sanitizeFilenameBase('Sales Meeting')).toBe('Sales Meeting');
  });
});

describe('generateUniqueFilename', () => {
  // Fixed local time so the embedded timestamp is deterministic: 2026-08-21 14:05:09.
  const FIXED_TIME = new Date(2026, 7, 21, 14, 5, 9);

  it('embeds the recording timestamp so same-title recordings get distinct, sortable names', async () => {
    const handle = makeFakeHandle(new Set());
    const name = await generateUniqueFilename(handle, 'Sales Meeting', FIXED_TIME);
    expect(name).toBe('Sales Meeting 2026-08-21 14-05-09.webm');
  });

  it('defaults to the current time when no timestamp is given', async () => {
    const handle = makeFakeHandle(new Set());
    const name = await generateUniqueFilename(handle, 'Sales Meeting');
    expect(name).toMatch(/^Sales Meeting \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.webm$/);
  });

  it('produces different filenames for the same title at different timestamps (the actual bug being fixed)', async () => {
    const handle = makeFakeHandle(new Set());
    const first = await generateUniqueFilename(handle, 'Meeting Recording', new Date(2026, 7, 21, 9, 0, 0));
    const second = await generateUniqueFilename(handle, 'Meeting Recording', new Date(2026, 7, 21, 15, 30, 45));
    expect(first).not.toBe(second);
    expect(first).toBe('Meeting Recording 2026-08-21 09-00-00.webm');
    expect(second).toBe('Meeting Recording 2026-08-21 15-30-45.webm');
  });

  it('7. appends " (1)" when the preferred (title + timestamp) filename already exists', async () => {
    const handle = makeFakeHandle(new Set(['Sales Meeting 2026-08-21 14-05-09.webm']));
    const name = await generateUniqueFilename(handle, 'Sales Meeting', FIXED_TIME);
    expect(name).toBe('Sales Meeting 2026-08-21 14-05-09 (1).webm');
  });

  it('8. keeps incrementing through multiple collisions: (1), (2), (3)', async () => {
    const handle = makeFakeHandle(
      new Set([
        'Sales Meeting 2026-08-21 14-05-09.webm',
        'Sales Meeting 2026-08-21 14-05-09 (1).webm',
        'Sales Meeting 2026-08-21 14-05-09 (2).webm',
      ])
    );
    const name = await generateUniqueFilename(handle, 'Sales Meeting', FIXED_TIME);
    expect(name).toBe('Sales Meeting 2026-08-21 14-05-09 (3).webm');
  });

  it('sanitizes the title before generating the unique name', async () => {
    const handle = makeFakeHandle(new Set());
    const name = await generateUniqueFilename(handle, 'Q3 Review: <final>', FIXED_TIME);
    expect(name).toBe('Q3 Review final 2026-08-21 14-05-09.webm');
  });
});
