export type MicPermissionState = 'granted' | 'needs-permission' | 'denied' | 'unsupported';

function isGetUserMediaSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

function isPermissionsQuerySupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.permissions && typeof navigator.permissions.query === 'function';
}

/**
 * Non-prompting check of the current microphone permission state for this origin.
 * Falls back to 'needs-permission' (rather than guessing) when the Permissions API
 * can't answer 'microphone' queries — some engines don't support querying it even
 * though getUserMedia itself works.
 */
export async function checkMicPermission(): Promise<MicPermissionState> {
  if (!isGetUserMediaSupported()) {
    return 'unsupported';
  }
  if (!isPermissionsQuerySupported()) {
    return 'needs-permission';
  }
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (status.state === 'granted') return 'granted';
    if (status.state === 'denied') return 'denied';
    return 'needs-permission';
  } catch {
    return 'needs-permission';
  }
}

/**
 * Re-prompts for microphone access. Must be called directly from a user-gesture event
 * handler (e.g. a button's onClick) in a real, visible tab — browsers reject or silently
 * dismiss this call from ephemeral contexts (extension popups, invisible offscreen
 * documents) instead of showing a real dialog. Immediately stops the granted stream —
 * this call exists only to resolve the permission grant, not to keep a capture open.
 */
export async function requestMicPermission(): Promise<MicPermissionState> {
  if (!isGetUserMediaSupported()) {
    return 'unsupported';
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return 'granted';
  } catch {
    // Re-check rather than trust the rejection directly: a truly denied permission and
    // an undeliverable prompt (Chrome's "Permission dismissed") both reject here, but
    // only queryable state tells them apart.
    return checkMicPermission();
  }
}
