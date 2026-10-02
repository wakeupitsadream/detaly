// Shared failure of phase 1B processors that wave 3 has not filled in yet: an early job fails at
// once (UnrecoverableError, no retries) instead of being retried.
import { UnrecoverableError } from 'bullmq';

export const NOT_IMPLEMENTED_MESSAGE = 'not implemented';

export function notImplemented(): never {
  throw new UnrecoverableError(NOT_IMPLEMENTED_MESSAGE);
}
