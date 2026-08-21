import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyExportOutcomeIfNeeded } from '../export-notifications.js';
import { ExportOutcome } from '../export-final-video.js';

describe('notifyExportOutcomeIfNeeded', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createSpy: any;

  beforeEach(() => {
    createSpy = vi.fn((_id: string, _options: unknown, callback?: () => void) => callback?.());
    (globalThis as { chrome?: unknown }).chrome = {
      notifications: { create: createSpy },
      runtime: { lastError: undefined },
    };
  });

  it.each<ExportOutcome['state']>(['NEEDS_PERMISSION', 'PERMISSION_DENIED', 'FOLDER_UNAVAILABLE', 'FAILED'])(
    'shows a notification for %s',
    (state) => {
      notifyExportOutcomeIfNeeded({ state, folderName: 'Recordings' });
      expect(createSpy).toHaveBeenCalledTimes(1);
      const [, options] = createSpy.mock.calls[0];
      expect(options.title).toBe('OpenPlan Recorder');
      expect(options.message).toContain('Recordings');
      expect(options.iconUrl).toMatch(/^data:image\/png;base64,/);
    }
  );

  it.each<ExportOutcome['state']>(['NO_FOLDER', 'COMPLETED', 'NOT_ATTEMPTED'])(
    'does not show a notification for %s',
    (state) => {
      notifyExportOutcomeIfNeeded({ state, folderName: 'Recordings' });
      expect(createSpy).not.toHaveBeenCalled();
    }
  );

  it('includes the error message for FAILED', () => {
    notifyExportOutcomeIfNeeded({ state: 'FAILED', folderName: 'Recordings', errorMessage: 'disk full' });
    const [, options] = createSpy.mock.calls[0];
    expect(options.message).toContain('disk full');
  });

  it('falls back to a generic folder reference when folderName is missing', () => {
    notifyExportOutcomeIfNeeded({ state: 'NEEDS_PERMISSION' });
    const [, options] = createSpy.mock.calls[0];
    expect(options.message).toContain('your selected folder');
  });

  it('does nothing (does not throw) when chrome.notifications is unavailable', () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    expect(() => notifyExportOutcomeIfNeeded({ state: 'FAILED', folderName: 'Recordings' })).not.toThrow();
  });
});
