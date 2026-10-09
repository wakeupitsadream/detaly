// Drizzle schema of every phase 1 table (PLAN section 2, phase0-implementation section 3).
// relations.ts adds relational-query metadata (no SQL).
// `vehicles` (phase 3) and `chat_messages` (phase 2) come with their own migrations.
export * from './enums';
export * from './people';
export * from './carts';
export * from './orders';
export * from './payments';
export * from './supplier';
export * from './service';
export * from './system';
export * from './workflow';
// step 2: price benchmark and settings audit
export * from './pricing';
// step 4: fit checks by the master (docs/fit-check.md)
export * from './fit-checks';
// step 5: maintenance kits by car model (docs/kits.md)
export * from './kits';
export * from './relations';
