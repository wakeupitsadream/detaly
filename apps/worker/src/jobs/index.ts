// Processors of every worked queue, all with the signature (job, deps) => Promise<unknown>.
import type { QueueName } from '@detaly/config';
import type { JobProcessor } from '../deps';
import { processHousekeeping } from './housekeeping';
import { processNotify } from './notify';
import { processPayments } from './payments';
import { processReceipts } from './receipts';
import { processReconciliation } from './reconciliation';
import { processRossko } from './rossko';

/** dead-letter is a parking queue: it has no processor. */
export const PROCESSORS: Record<Exclude<QueueName, 'dead-letter'>, JobProcessor> = {
  payments: processPayments,
  receipts: processReceipts,
  rossko: processRossko,
  notify: processNotify,
  reconciliation: processReconciliation,
  housekeeping: processHousekeeping,
};
