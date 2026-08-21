import { logger } from '@openplan/core';
import { LocalExportState } from '@openplan/contracts';
import { ExportOutcome } from './export-final-video.js';

// Minimal embedded 48x48 PNG (teal square, white dot) — chrome.notifications requires a
// raster iconUrl and this extension has no icon assets yet; a data URI avoids adding new
// build/manifest infrastructure just for this one notification.
const NOTIFICATION_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAhElEQVR4nO3YuRHAMAwDQXXgTh26fbsFUw9Pz2EGsbChWK7nflduoQcIoAcIoAcIoAcIoAdMBYhkKkBLcECPIIARSQOMjAByfA0iBMiMAHJ8BCFAgAABAgQIWAKQjfi76SxAFiKy57wf2RaAUYiaHefehXohWt/2NkpXAF0BdAXQFUD3A2drEJQtnlaxAAAAAElFTkSuQmCC';

// Recording success is never in question here — a failed local export never affects the
// backend recording (see LocalExportState's own doc comment). Only states where the user
// needs to actually do something get a notification; NO_FOLDER is a deliberate opt-out
// (no folder configured at all) and isn't treated as a failure worth interrupting for.
const NOTIFIABLE_STATES: ReadonlySet<LocalExportState> = new Set([
  'NEEDS_PERMISSION',
  'PERMISSION_DENIED',
  'FOLDER_UNAVAILABLE',
  'FAILED',
]);

function messageFor(outcome: ExportOutcome): string {
  const folder = outcome.folderName ? `"${outcome.folderName}"` : 'your selected folder';
  switch (outcome.state) {
    case 'NEEDS_PERMISSION':
      return `Recording saved to OpenPlan. Saving a copy to ${folder} needs permission again — open the extension's Settings to reconnect it.`;
    case 'PERMISSION_DENIED':
      return `Recording saved to OpenPlan, but access to ${folder} was denied. Choose a folder again in Settings to resume local saving.`;
    case 'FOLDER_UNAVAILABLE':
      return `Recording saved to OpenPlan, but ${folder} could not be found. Choose a folder again in Settings.`;
    case 'FAILED':
    default:
      return `Recording saved to OpenPlan, but saving a local copy to ${folder} failed${outcome.errorMessage ? `: ${outcome.errorMessage}` : '.'}`;
  }
}

/**
 * Surfaces a desktop notification when the automatic local-folder export (triggered
 * silently after a recording finishes, with no user gesture available to re-prompt for
 * permission) didn't succeed — otherwise the only way to discover this is to happen to
 * open the extension's Settings page and notice the warning there.
 */
export function notifyExportOutcomeIfNeeded(outcome: ExportOutcome): void {
  if (!NOTIFIABLE_STATES.has(outcome.state)) {
    return;
  }

  if (typeof chrome === 'undefined' || !chrome.notifications?.create) {
    logger.warn('chrome.notifications unavailable; cannot surface local export failure:', outcome);
    return;
  }

  chrome.notifications.create(
    `openplan-local-export-${Date.now()}`,
    {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON,
      title: 'OpenPlan Recorder',
      message: messageFor(outcome),
      priority: 1,
    },
    () => {
      if (chrome.runtime.lastError) {
        logger.warn('Failed to show local export notification:', chrome.runtime.lastError.message);
      }
    }
  );
}
