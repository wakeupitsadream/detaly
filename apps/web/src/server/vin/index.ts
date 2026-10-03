/**
 * Wiring of the phase 1C VIN handlers with the process dependencies (lazy: nothing is read at
 * import time). Tests build the handlers with their own deps.
 */
import { getCheckoutGate } from '../checkout-gate';
import { getDb } from '../db';
import { getEngineDeps } from '../engine';
import { serverEnv } from '../env';
import { getFileStore } from '../files';
import { getLogger } from '../logger';
import type { VinSubmitDeps } from './submit-handler';
import type { ProposalTakeDeps } from './take-handler';

export function getVinSubmitDeps(): VinSubmitDeps {
  const env = serverEnv();
  const db = getDb();
  const logger = getLogger();
  return {
    db,
    env,
    files: getFileStore(),
    gate: () => getCheckoutGate({ env, db, logger }),
    logger,
    nudge: () => getEngineDeps().nudge?.(),
  };
}

export function getProposalTakeDeps(): ProposalTakeDeps {
  return { db: getDb(), env: serverEnv(), logger: getLogger() };
}
