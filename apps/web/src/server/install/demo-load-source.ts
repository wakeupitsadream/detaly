/** Simulated lift load (packages/domain install-load-demo): no database, the same answer every time. */
import { demoLoadSnapshot, type WeekSchedule } from '@detaly/domain';
import type { LoadSource } from './load-source';

export function createDemoLoadSource(options: {
  schedule: WeekSchedule | null;
  capacity: number;
  timeZone: string;
}): LoadSource {
  const snapshot = demoLoadSnapshot(options);
  return {
    kind: 'demo',
    snapshot: () => Promise.resolve(snapshot),
  };
}
