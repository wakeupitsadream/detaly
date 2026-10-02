import { describe, expect, it } from 'vitest';
import {
  isAllowedWebhookIp,
  parseWebhookIpAllowlist,
  WebhookIpAllowlistError,
  YOOKASSA_DOCUMENTED_WEBHOOK_NETWORKS,
} from '../src';

const allowlist = parseWebhookIpAllowlist(YOOKASSA_DOCUMENTED_WEBHOOK_NETWORKS);

describe('isAllowedWebhookIp (decision Б4)', () => {
  it.each([
    // 185.71.76.0/27: .0 … .31
    ['185.71.76.0', true],
    ['185.71.76.1', true],
    ['185.71.76.31', true],
    ['185.71.76.32', false],
    ['185.71.75.255', false],
    ['185.71.77.31', true],
    ['185.71.77.32', false],
    // 77.75.153.0/25 and 77.75.154.128/25
    ['77.75.153.127', true],
    ['77.75.153.128', false],
    ['77.75.154.127', false],
    ['77.75.154.128', true],
    ['77.75.154.255', true],
    // single addresses
    ['77.75.156.11', true],
    ['77.75.156.35', true],
    ['77.75.156.12', false],
    // 2a02:5180::/32
    ['2a02:5180::1', true],
    ['2a02:5180:ffff:ffff:ffff:ffff:ffff:ffff', true],
    ['2A02:5180:0:0:0:0:0:1', true],
    ['2a02:5181::1', false],
    ['2a02:517f:ffff::1', false],
    // IPv4-mapped IPv6 (dual-stack sockets)
    ['::ffff:185.71.76.1', true],
    ['::FFFF:185.71.76.31', true],
    ['::ffff:b947:4c01', true],
    ['::ffff:185.71.76.32', false],
    ['0:0:0:0:0:ffff:4d4b:9c0b', true],
    // others
    ['127.0.0.1', false],
    ['::1', false],
    ['10.0.0.1', false],
  ])('%s → %s', (ip, expected) => {
    expect(isAllowedWebhookIp(ip, allowlist)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    'garbage',
    '185.71.76',
    '185.71.76.1.5',
    '185.71.076.1',
    '185.71.76.256',
    '185.71.76.1:443',
    '[2a02:5180::1]',
    '2a02:5180::1%eth0',
    '185.71.76.0/27',
    '185.71.76.1, 10.0.0.1',
    'localhost',
  ])('garbage %j → false', (ip) => {
    expect(isAllowedWebhookIp(ip, allowlist)).toBe(false);
  });

  it('null, undefined and an empty allowlist fail closed', () => {
    expect(isAllowedWebhookIp(null, allowlist)).toBe(false);
    expect(isAllowedWebhookIp(undefined, allowlist)).toBe(false);
    expect(isAllowedWebhookIp('185.71.76.1', [])).toBe(false);
    expect(isAllowedWebhookIp('185.71.76.1', parseWebhookIpAllowlist([]))).toBe(false);
  });

  it('accepts a plain string list and trims the value', () => {
    expect(isAllowedWebhookIp(' 185.71.76.1 ', ['185.71.76.0/27'])).toBe(true);
    expect(isAllowedWebhookIp('185.71.76.1', ['185.71.76.1'])).toBe(true);
    expect(isAllowedWebhookIp('185.71.76.2', ['185.71.76.1'])).toBe(false);
  });
});

describe('parseWebhookIpAllowlist', () => {
  it('parses addresses and networks, skipping blank entries', () => {
    const parsed = parseWebhookIpAllowlist([' 185.71.76.0/27 ', '', '2a02:5180::/32', '::1']);
    expect(parsed.entries).toEqual(['185.71.76.0/27', '2a02:5180::/32', '::1']);
    expect(parsed.size).toBe(3);
    expect(isAllowedWebhookIp('::1', parsed)).toBe(true);
  });

  it('host bits in a network are masked; /0 and /32 are valid', () => {
    expect(isAllowedWebhookIp('185.71.76.31', ['185.71.76.17/27'])).toBe(true);
    expect(isAllowedWebhookIp('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
    expect(isAllowedWebhookIp('77.75.156.11', ['77.75.156.11/32'])).toBe(true);
    expect(isAllowedWebhookIp('77.75.156.12', ['77.75.156.11/32'])).toBe(false);
  });

  it('an IPv4-mapped network in the list covers plain IPv4', () => {
    expect(isAllowedWebhookIp('185.71.76.200', ['::ffff:185.71.76.0/120'])).toBe(true);
    expect(isAllowedWebhookIp('185.71.77.1', ['::ffff:185.71.76.0/120'])).toBe(false);
  });

  it.each([
    'garbage',
    '185.71.76.0/33',
    '185.71.76.0/-1',
    '185.71.76.0/',
    '185.71.76.0/2a',
    '2a02:5180::/129',
    '185.71.76.300',
    '185.71.76.0/27/1',
    'fe80::1%eth0',
  ])('throws on the invalid entry %j', (entry) => {
    expect(() => parseWebhookIpAllowlist(['185.71.76.0/27', entry])).toThrow(
      WebhookIpAllowlistError,
    );
    expect(() => parseWebhookIpAllowlist([entry])).toThrow(entry.trim());
  });

  it('a string list with an invalid entry throws in isAllowedWebhookIp too', () => {
    expect(() => isAllowedWebhookIp('185.71.76.1', ['nope'])).toThrow(WebhookIpAllowlistError);
  });
});
