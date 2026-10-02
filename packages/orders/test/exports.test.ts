// Contract of @detaly/orders (docs/phase-1b-implementation.md section 5.1): every public name
// is exported. Wave 1 ships stubs; wave 2 (engine) replaces them and keeps this list.
import { describe, expect, it } from 'vitest';
import * as orders from '../src';

const FUNCTIONS = [
  'loadOrderSettings',
  'loadOrderSnapshot',
  'buildTransitionContext',
  'planItemChanges',
  'applyTransition',
  'persistTransition',
  'recordJournalEvent',
  'enqueueOutbox',
  'canReachClient',
  'availableStaffActions',
  'performStaffAction',
  'performClientAction',
  'preparePayment',
  'recordPaymentCreated',
  'applyPaymentObject',
  'applyRefundObject',
  'applyReceiptObject',
  'createRefund',
] as const;

describe('@detaly/orders exports', () => {
  it.each(FUNCTIONS)('%s is a function', (name) => {
    expect(typeof orders[name]).toBe('function');
  });
});
