// Public API of @detaly/domain. Pure functions only: no I/O, no env, no clock reads
// (time is always passed in). Contract subpaths `@detaly/domain/statuses` and
// `@detaly/domain/types` stay import-free for drizzle-kit; this root re-exports them.
export * from './statuses';
export type * from './types';

export * from './money';
export * from './pricing';
export * from './dates';
export * from './excluded';
export * from './offers';
export * from './state-machine';
export * from './phone';
export * from './cart';
export * from './checkout';
// phase 1B
export * from './receipts';
export * from './refunds';
export type * from './recheck-types';
export * from './recheck';
export * from './timers';
export * from './journal';
// storefront: "when will the car be ready" (docs/design.md, section 4)
export * from './work-hours';
export * from './install-window';
export * from './install-load-demo';
