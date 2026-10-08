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
export * from './relations';
