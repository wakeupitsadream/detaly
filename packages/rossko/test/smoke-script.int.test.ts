/**
 * scripts/rossko-smoke.ts as a child process (node --import tsx, like production scripts).
 * No external network: without keys it must stop before any request; with fake keys it talks
 * to the loopback SOAP stub only.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSoapStub, type SoapStub } from './soap-server';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'rossko-smoke.ts');
const KEY1 = 'smoke-fake-key-one-7f3a';
const KEY2 = 'smoke-fake-key-two-9c1e';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runSmoke(args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) if (key.startsWith('ROSSKO_')) delete childEnv[key];
  Object.assign(childEnv, env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      cwd: ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let stub: SoapStub;
let outDir: string;

beforeAll(async () => {
  stub = await startSoapStub();
  outDir = await mkdtemp(join(tmpdir(), 'rossko-smoke-'));
});

afterAll(async () => {
  await stub.close();
  await rm(outDir, { recursive: true, force: true });
});

describe('scripts/rossko-smoke.ts', () => {
  it('without keys exits with code 2 and "ждём ключи", touching nothing', async () => {
    const empty = join(outDir, 'none');
    const result = await runSmoke(['--articles', 'OC90', '--out', empty], { ROSSKO_KEY1: '' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('ждём ключи');
    await expect(readdir(empty)).rejects.toThrow();
  }, 30_000);

  it('without articles exits with a usage error', async () => {
    const result = await runSmoke([], {});
    expect(result.code).toBe(64);
  }, 30_000);

  it('rejects a malformed ROSSKO_TIMEOUT_MS before any request', async () => {
    const result = await runSmoke(['--articles', 'OC90', '--out', join(outDir, 'bad-timeout')], {
      ROSSKO_KEY1: KEY1,
      ROSSKO_KEY2: KEY2,
      ROSSKO_WSDL_BASE: stub.base,
      ROSSKO_TIMEOUT_MS: '15s',
    });
    expect(result.code).toBe(64);
    expect(result.stderr).toContain('ROSSKO_TIMEOUT_MS');
  }, 30_000);

  it('with keys records masked JSON and XML for each call', async () => {
    const out = join(outDir, 'run');
    const result = await runSmoke(['--articles', 'OC90,w 914/2', '--out', out], {
      ROSSKO_KEY1: KEY1,
      ROSSKO_KEY2: KEY2,
      ROSSKO_WSDL_BASE: stub.base,
      ROSSKO_LOCAL_STOCK_IDS: 'ORB1',
      ROSSKO_TIMEOUT_MS: '5000',
    });
    // The stub has no GetCheckoutDetails WSDL: that call fails, searches succeed.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('FAIL GetCheckoutDetails');
    expect(result.stdout).toContain('ok   GetSearch.OC90');
    expect(result.stdout).toMatch(/GetSearch\.OC90 .*offers=5 crosses=3 local=2/);
    expect(result.stdout).toContain('ok   GetSearch.W9142');

    const files = (await readdir(out)).sort();
    expect(files).toEqual([
      'GetSearch.OC90.json',
      'GetSearch.OC90.xml',
      'GetSearch.W9142.json',
      'GetSearch.W9142.xml',
    ]);
    const json = JSON.parse(await readFile(join(out, 'GetSearch.OC90.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(json._meta).toMatchObject({
      synthetic: false,
      method: 'GetSearch',
      args: { text: 'OC90' },
    });
    expect(json).toHaveProperty('SearchResult.success', true);
    expect(await readFile(join(out, 'GetSearch.OC90.xml'), 'utf8')).toContain('Envelope');

    // The stub saw the real keys; nothing written or printed contains them.
    expect(stub.received.at(-1)).toMatchObject({ KEY1, KEY2, text: 'W9142' });
    for (const file of files) {
      const text = await readFile(join(out, file), 'utf8');
      expect(text).not.toContain(KEY1);
      expect(text).not.toContain(KEY2);
    }
    expect(result.stdout + result.stderr).not.toContain(KEY1);
  }, 30_000);
});
