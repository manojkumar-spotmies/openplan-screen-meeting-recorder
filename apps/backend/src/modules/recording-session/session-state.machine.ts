import { SessionStatus } from '@openplan/contracts';

export const TERMINAL_STATES: SessionStatus[] = ['PROCESSING', 'INCOMPLETE', 'FAILED', 'READY'];

export function canTransition(current: SessionStatus, next: SessionStatus): boolean {
  if (current === next) return true; // Idempotent same-state check

  switch (current) {
    case 'INITIALIZED':
      return next === 'RECORDING' || next === 'STOPPED' || next === 'WAITING_FOR_CHUNKS' || next === 'INCOMPLETE' || next === 'FAILED';

    case 'RECORDING':
      return next === 'STOPPED' || next === 'WAITING_FOR_CHUNKS' || next === 'PROCESSING' || next === 'FAILED';

    case 'STOPPED':
      return next === 'PROCESSING' || next === 'WAITING_FOR_CHUNKS' || next === 'INCOMPLETE' || next === 'FAILED';

    case 'WAITING_FOR_CHUNKS':
      return next === 'PROCESSING' || next === 'INCOMPLETE' || next === 'FAILED';

    case 'PROCESSING':
    case 'INCOMPLETE':
    case 'FAILED':
    case 'READY':
      // Terminal states cannot transition further
      return false;

    default:
      return false;
  }
}

export function assertValidTransition(current: SessionStatus, next: SessionStatus): void {
  if (!canTransition(current, next)) {
    throw new Error(`Invalid state transition from ${current} to ${next}`);
  }
}
