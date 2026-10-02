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
