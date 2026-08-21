// Windows forbids these characters anywhere in a filename.
const INVALID_WINDOWS_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

// Windows also rejects trailing dots/spaces and a fixed set of reserved device names,
// regardless of extension (e.g. "CON.webm" is just as invalid as "CON").
const RESERVED_WINDOWS_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const MAX_BASE_NAME_LENGTH = 150;
const DEFAULT_BASE_NAME = 'Recording';

/** Turns an arbitrary recording title into a safe Windows filename base (no extension). */
export function sanitizeFilenameBase(rawName: string): string {
  let name = (rawName || '').trim();
  name = name.replace(INVALID_WINDOWS_CHARS, '');
  name = name.replace(/[.\s]+$/g, ''); // trailing dots/spaces are invalid on Windows

  if (name.length === 0) {
    name = DEFAULT_BASE_NAME;
  }

  if (name.length > MAX_BASE_NAME_LENGTH) {
    name = name.slice(0, MAX_BASE_NAME_LENGTH).replace(/[.\s]+$/g, '') || DEFAULT_BASE_NAME;
  }

  if (RESERVED_WINDOWS_NAMES.has(name.toUpperCase())) {
    name = `${name}_recording`;
  }

  return name;
}

async function fileExistsInDirectory(dirHandle: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dirHandle.getFileHandle(name);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') {
      return false;
    }
    throw err;
  }
}

const MAX_COLLISION_ATTEMPTS = 1000;

/**
 * Formats a Date as `YYYY-MM-DD HH-mm-ss` in local time — filesystem-safe (no `:`), and
 * lexicographically sortable the same as chronological order. Local time rather than UTC
 * because this is read by a person browsing their own folder, not machine-parsed.
 */
function formatTimestampForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/**
 * Picks a `.webm` filename inside `dirHandle` that doesn't collide with anything already
 * there. Every recording shares the same default title ("Meeting Recording" — see
 * PopupApp.tsx), so the title alone was producing "Meeting Recording.webm", "Meeting
 * Recording (1).webm", "Meeting Recording (2).webm", etc. — opaque and unsorted. The
 * timestamp (defaulting to now, but callers should pass the recording's actual start
 * time when known) makes each export distinguishable and chronologically sortable by
 * construction; the numeric-suffix fallback still exists underneath for the rare case
 * two exports land on the exact same second — never silently overwrites an existing file.
 */
export async function generateUniqueFilename(
  dirHandle: FileSystemDirectoryHandle,
  rawTitle: string,
  timestamp: Date = new Date()
): Promise<string> {
  const base = `${sanitizeFilenameBase(rawTitle)} ${formatTimestampForFilename(timestamp)}`;

  const preferred = `${base}.webm`;
  if (!(await fileExistsInDirectory(dirHandle, preferred))) {
    return preferred;
  }

  for (let i = 1; i <= MAX_COLLISION_ATTEMPTS; i++) {
    const numbered = `${base} (${i}).webm`;
    if (!(await fileExistsInDirectory(dirHandle, numbered))) {
      return numbered;
    }
  }

  // Practically unreachable, but guarantees termination instead of looping forever.
  return `${base} (${Date.now()}).webm`;
}
