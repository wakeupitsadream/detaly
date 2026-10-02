// Drizzle schema of every phase 1 table (PLAN section 2, phase0-implementation section 3).
// `vehicles` (phase 3) and `chat_messages` (phase 2) come with their own migrations.
export * from './enums';
export * from './people';
export * from './carts';
export * from './orders';
export * from './payments';
export * from './supplier';
export * from './service';
export * from './system';
