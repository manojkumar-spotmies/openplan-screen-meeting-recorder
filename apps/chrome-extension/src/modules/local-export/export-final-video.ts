import { logger } from '@openplan/core';
import { LocalExportState, LocalExportSummary } from '@openplan/contracts';
import { getStoredDirectoryHandle } from '../local-storage-settings/directory-handle-store.js';
import { checkStoredPermission } from '../local-storage-settings/folder-access.js';
import { generateUniqueFilename } from './filename.js';
import { setExportStatus } from './export-state-store.js';
import { BACKEND_BASE_URL } from '../../config/backend-config.js';

const DEFAULT_BACKEND_BASE_URL = BACKEND_BASE_URL;
const DEFAULT_USER_ID = 'dev-user-1';

export interface ExportOutcome {
  state: LocalExportState;
  folderName?: string;
  fileName?: string;
  errorMessage?: string;
}

// Two extra, non-terminal states used only while a call to exportFinalVideoToLocalFolder
// is in flight — never returned from it, but visible to anyone reading export-state-store
// mid-export (e.g. the Inspector open in another tab).
type InProgressState = 'PENDING' | 'EXPORTING';

function toSummary(outcome: ExportOutcome): LocalExportSummary {
  return {
    state: outcome.state,
    folderName: outcome.folderName,
    fileName: outcome.fileName,
    errorMessage: outcome.errorMessage,
  };
}

async function persist(
  sessionId: string,
  state: LocalExportState | InProgressState,
  details: { folderName?: string; fileName?: string; errorMessage?: string } = {}
): Promise<void> {
  await setExportStatus({
    sessionId,
    state,
    ...details,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Exports the backend's completed final video for `sessionId` to the user's selected
 * local folder (Step 2A's persisted FileSystemDirectoryHandle). Safe to call multiple
 * times for the same session — e.g. as a manual retry after a prior failure — since
 * filename collision handling never overwrites a previous export, and the backend's own
 * final/meeting.webm is only ever read here, never modified or deleted. On success, also
 * asks the backend to clean up its disposable working files for the session (never the
 * final video) — best-effort, and never allowed to affect the outcome returned here.
 *
 * Never throws: every failure mode is caught, persisted via export-state-store, and
 * returned as a typed outcome instead.
 */
export async function exportFinalVideoToLocalFolder(
  sessionId: string,
  title: string,
  options: { backendBaseUrl?: string; userId?: string; recordedAt?: Date | string } = {}
): Promise<ExportOutcome> {
  const backendBaseUrl = options.backendBaseUrl || DEFAULT_BACKEND_BASE_URL;
  const userId = options.userId || DEFAULT_USER_ID;
  // Prefer the recording's actual start time over "now" (export time) so the filename
  // reflects when the meeting happened, not when this export attempt happened to run —
  // those can differ on a retry. Falls back to now if the caller doesn't have it.
  const recordedAt = options.recordedAt ? new Date(options.recordedAt) : new Date();

  await persist(sessionId, 'PENDING');

  let handle: FileSystemDirectoryHandle | undefined;
  try {
    handle = await getStoredDirectoryHandle();
  } catch (err) {
    logger.error(`[LocalExport] Failed to read stored directory handle for session ${sessionId}:`, err);
  }

  if (!handle) {
    await persist(sessionId, 'NO_FOLDER');
    return { state: 'NO_FOLDER' };
  }

  const folderName = handle.name;

  let permission: 'granted' | 'needs-permission' | 'denied';
  try {
    permission = await checkStoredPermission(handle);
  } catch (err) {
    logger.error(`[LocalExport] Permission check failed for session ${sessionId}:`, err);
    const errorMessage = 'Unable to check local folder permission.';
    await persist(sessionId, 'FAILED', { folderName, errorMessage });
    return { state: 'FAILED', folderName, errorMessage };
  }

  if (permission === 'needs-permission') {
    await persist(sessionId, 'NEEDS_PERMISSION', { folderName });
    return { state: 'NEEDS_PERMISSION', folderName };
  }
  if (permission === 'denied') {
    await persist(sessionId, 'PERMISSION_DENIED', { folderName });
    return { state: 'PERMISSION_DENIED', folderName };
  }

  await persist(sessionId, 'EXPORTING', { folderName });

  try {
    const response = await fetch(`${backendBaseUrl}/api/v1/sessions/${sessionId}/video`, {
      headers: { 'x-user-id': userId },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new Error(`Failed to download final video (HTTP ${response.status}): ${bodyText}`);
    }

    // A single Blob download (rather than base64/text conversion) keeps this to one
    // in-memory copy of the video, consistent with how the rest of the extension
    // already handles recording bytes (see sync-worker.ts / LocalInspector.tsx).
    const videoBlob = await response.blob();
    if (videoBlob.size === 0) {
      throw new Error('Downloaded final video is empty.');
    }

    const fileName = await generateUniqueFilename(handle, title, recordedAt);

    const fileHandle = await handle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(videoBlob);
    await writable.close();

    const writtenFile = await fileHandle.getFile();
    if (writtenFile.size === 0) {
      throw new Error('Exported file is empty after write.');
    }
    if (writtenFile.size !== videoBlob.size) {
      throw new Error(
        `Exported file size (${writtenFile.size}) does not match downloaded size (${videoBlob.size}).`
      );
    }

    await persist(sessionId, 'COMPLETED', { folderName, fileName });
    logger.info(`[LocalExport] Saved session ${sessionId} to "${folderName}/${fileName}"`);

    // The file is now verified on disk in the user's folder — safe to ask the backend
    // to drop its disposable working files for this session (assembly buffer, FFmpeg
    // scratch dir). Best-effort: a failure here never changes the export outcome above,
    // since the local copy is already safely saved; the backend cleanup can simply be
    // retried on a later export/call and is a no-op once already done.
    try {
      await fetch(`${backendBaseUrl}/api/v1/sessions/${sessionId}/cleanup-local`, {
        method: 'POST',
        headers: { 'x-user-id': userId },
      });
    } catch (err) {
      logger.warn(`[LocalExport] Backend cleanup request failed for session ${sessionId} (safe to retry):`, err);
    }

    return { state: 'COMPLETED', folderName, fileName };
  } catch (err) {
    logger.error(`[LocalExport] Export failed for session ${sessionId}:`, err);

    // A NotFoundError surfacing here means the folder itself (not just a sub-file) is
    // gone — distinct from a generic write failure, and needs a different recovery UI.
    const name = err instanceof DOMException ? err.name : undefined;
    if (name === 'NotFoundError') {
      await persist(sessionId, 'FOLDER_UNAVAILABLE', { folderName });
      return { state: 'FOLDER_UNAVAILABLE', folderName };
    }

    const errorMessage = err instanceof Error ? err.message : 'Failed to save recording to the selected folder.';
    await persist(sessionId, 'FAILED', { folderName, errorMessage });
    return { state: 'FAILED', folderName, errorMessage };
  }
}

export { toSummary as exportOutcomeToSummary };
