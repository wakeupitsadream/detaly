// notify/vin (docs/phase-1c-implementation.md decision С20): a VIN request message — to the
// client (vin_received, vin_proposal through the Notifier: messenger bindings, SMS by the
// allowlist) or the sellers card (sellerCards.postVin). The notifications row
// (vin_request_id, dedupe `vin:<id>:<template>:<n>:<channel>`) is written before sending.
//
// Phase 1C wave 1: the contract only; the notify-1c package implements the processor.
import type { VinNotifyTemplate } from '@detaly/domain';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerDeps } from '../../deps';

export interface NotifyVinJobData {
  vinRequestId: string;
  audience: 'client' | 'sellers';
  /** Client template; absent for the sellers card. */
  template?: VinNotifyTemplate | null;
  /** Outbox key of the job (dedupe of the notifications row). */
  key: string;
  /** Number of the proposal sent (vin_requests.proposal_count) for vin_proposal. */
  n?: number;
  /** Extra line of the sellers card without PD («Без ответа 4 ч»). */
  note?: string | null;
}

export type NotifyVinOutcome =
  | { status: 'sent' | 'skipped' | 'failed' | 'duplicate'; channel: string | null }
  | { status: 'posted' };

export async function processNotifyVin(_job: Job, _deps: WorkerDeps): Promise<NotifyVinOutcome> {
  throw new UnrecoverableError('notify/vin: not implemented');
}
