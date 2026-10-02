/**
 * Loopback Rossko GetSearch stub for integration tests: node-soap server on 127.0.0.1:0 with
 * test/wsdl/GetSearch.wsdl, answering from the bundled fixtures. Other paths get a quick 404.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as soap from 'soap';
import { BUNDLED_FIXTURES, stripMeta } from '../src/fixture-caller';
import { normalizeArticle } from '../src/normalize';

export interface SoapStub {
  /** e.g. http://127.0.0.1:12345 — use as ROSSKO_WSDL_BASE. */
  base: string;
  /** GET ...?wsdl requests seen so far. */
  wsdlLoads(): number;
  /** Arguments received by GetSearch. */
  received: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function startSoapStub(): Promise<SoapStub> {
  let wsdlLoads = 0;
  const received: Record<string, unknown>[] = [];
  const server: Server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const template = await readFile(new URL('./wsdl/GetSearch.wsdl', import.meta.url), 'utf8');
  const wsdl = template.replaceAll('{{ENDPOINT}}', `${base}/GetSearch`);
  const services = {
    GetSearchService: {
      GetSearchPort: {
        GetSearch(args: Record<string, unknown>) {
          received.push(args);
          const text = normalizeArticle(String(args.text ?? ''));
          if (text === 'SLOW') {
            return new Promise((resolve) =>
              setTimeout(() => resolve({ SearchResult: { success: false } }), 1500),
            );
          }
          return stripMeta(
            BUNDLED_FIXTURES[`GetSearch.${text}`] ?? BUNDLED_FIXTURES['GetSearch.NOTFOUND'],
          );
        },
      },
    },
  };
  // soap.listen rewires the server's 'request' listeners once the WSDL is parsed, so the
  // counting listener is added after its callback.
  await new Promise<void>((resolve, reject) => {
    soap.listen(server, {
      path: '/GetSearch',
      services,
      xml: wsdl,
      callback: (err: unknown) => (err ? reject(err as Error) : resolve()),
    });
  });
  server.prependListener('request', (req) => {
    if (req.method === 'GET' && req.url?.toLowerCase().endsWith('?wsdl')) wsdlLoads += 1;
  });
  return {
    base,
    wsdlLoads: () => wsdlLoads,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
