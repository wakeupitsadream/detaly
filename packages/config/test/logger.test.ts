import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';
import { QUEUE, QUEUE_NAMES } from '../src/queues';

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('createLogger', () => {
  it('writes JSON with name and redacts secrets and personal data', () => {
    const out = capture();
    const logger = createLogger('test', { destination: out.stream, base: { gitSha: 'abc' } });
    logger.info({ phone: '+79990001122', req: { KEY1: 'k1' }, orderNumber: 'DT-000001' }, 'hello');
    const [line] = out.lines();
    expect(line).toMatchObject({
      name: 'test',
      gitSha: 'abc',
      level: 'info',
      msg: 'hello',
      phone: '[redacted]',
      req: { KEY1: '[redacted]' },
      orderNumber: 'DT-000001',
    });
  });
});

describe('queues', () => {
  it('declares the seven PLAN queues', () => {
    expect(QUEUE_NAMES).toEqual([
      'payments',
      'receipts',
      'rossko',
      'notify',
      'reconciliation',
      'housekeeping',
      'dead-letter',
    ]);
    expect(Object.values(QUEUE).sort()).toEqual([...QUEUE_NAMES].sort());
  });
});
