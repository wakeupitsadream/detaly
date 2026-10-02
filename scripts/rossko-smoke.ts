/**
 * Rossko smoke run on real keys: GetCheckoutDetails, GetSearch for each article, GetOrders
 * (only with --orders). Writes every parsed response as JSON and the raw SOAP XML next to it,
 * with KEY1/KEY2 masked, so they can become fixtures after review.
 *
 * Usage (from the repo root; tsx passes --env-file through to node):
 *   pnpm exec tsx --env-file=.env scripts/rossko-smoke.ts --articles OC90,W9142 [--orders 123,456] [--out DIR]
 *
 * Env: ROSSKO_KEY1, ROSSKO_KEY2 (required), ROSSKO_WSDL_BASE, ROSSKO_DELIVERY_ID,
 * ROSSKO_ADDRESS_ID, ROSSKO_LOCAL_STOCK_IDS, ROSSKO_TIMEOUT_MS.
 *
 * Exit codes: 0 all calls succeeded, 1 a call failed, 2 no keys yet ("ждём ключи"),
 * 64 bad arguments. Without keys nothing touches the network.
 *
 * The calls bypass the Redis limiter: a smoke run is a handful of requests made by hand.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  createSoapCaller,
  mapCheckoutDetails,
  maskSecrets,
  normalizeArticle,
  parseSearchResponse,
  ORDERS_BATCH_SIZE,
  type RosskoMethod,
} from '@detaly/rossko';

const EXIT_FAILED = 1;
const EXIT_NO_KEYS = 2;
const EXIT_USAGE = 64;

const USAGE =
  'Использование: pnpm exec tsx --env-file=.env scripts/rossko-smoke.ts --articles OC90,W9142 [--orders 123,456] [--out DIR]';

function list(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        articles: { type: 'string', multiple: true },
        orders: { type: 'string', multiple: true },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    });
  } catch (error) {
    console.error(errorText(error));
    console.error(USAGE);
    return EXIT_USAGE;
  }
  if (parsed.values.help) {
    console.log(USAGE);
    return 0;
  }
  const articles = list(parsed.values.articles);
  const orderIds = list(parsed.values.orders);
  if (articles.length === 0) {
    console.error('Нужен хотя бы один артикул: --articles OC90,W9142');
    console.error(USAGE);
    return EXIT_USAGE;
  }

  const key1 = env('ROSSKO_KEY1');
  const key2 = env('ROSSKO_KEY2');
  if (!key1 || !key2) {
    console.error(
      'Rossko: ждём ключи. Задайте ROSSKO_KEY1 и ROSSKO_KEY2 (ЛК Rossko → API) и запустите снова. Запросов не было.',
    );
    return EXIT_NO_KEYS;
  }

  const secrets = [key1, key2];
  const mask = (text: string) => maskSecrets(text, secrets);
  const wsdlBase = env('ROSSKO_WSDL_BASE') ?? 'https://api.rossko.ru/service/v2.1';
  const timeoutRaw = env('ROSSKO_TIMEOUT_MS');
  const timeoutMs = timeoutRaw === undefined ? 15_000 : Number(timeoutRaw);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    console.error(
      `ROSSKO_TIMEOUT_MS должен быть положительным целым числом, получено «${timeoutRaw}»`,
    );
    return EXIT_USAGE;
  }
  const deliveryId = env('ROSSKO_DELIVERY_ID');
  const addressId = env('ROSSKO_ADDRESS_ID');
  const localStockIds = list([env('ROSSKO_LOCAL_STOCK_IDS') ?? '']);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = resolve(parsed.values.out ?? join('.dev', 'rossko-smoke', stamp));
  await mkdir(outDir, { recursive: true });

  const caller = createSoapCaller({ wsdlBase, timeoutMs });
  let failures = 0;

  async function run(
    method: RosskoMethod,
    suffix: string | null,
    args: Record<string, unknown>,
    summarize: (raw: unknown) => string,
  ): Promise<void> {
    const name = suffix ? `${method}.${suffix}` : method;
    const startedAt = Date.now();
    try {
      const raw = await caller.call(method, { KEY1: key1, KEY2: key2, ...args });
      const ms = Date.now() - startedAt;
      const meta = {
        synthetic: false,
        recordedAt: new Date().toISOString(),
        method,
        args,
        wsdlBase,
      };
      const json = JSON.stringify({ _meta: meta, ...(raw as Record<string, unknown>) }, null, 2);
      await writeFile(join(outDir, `${name}.json`), `${mask(json)}\n`);
      if (caller.lastRawResponse)
        await writeFile(join(outDir, `${name}.xml`), mask(caller.lastRawResponse));
      let summary: string;
      try {
        summary = summarize(raw);
      } catch (error) {
        summary = `маппер не разобрал ответ: ${errorText(error)}`;
      }
      console.log(`ok   ${name} ${ms} ms: ${mask(summary)}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name} ${Date.now() - startedAt} ms: ${mask(errorText(error))}`);
    }
  }

  console.log(`Rossko smoke → ${outDir}`);
  await run('GetCheckoutDetails', null, {}, (raw) => {
    const d = mapCheckoutDetails(raw);
    return `success=${d.success} deliveries=${d.deliveries.map((x) => `${x.id}:${x.name ?? ''}`).join('; ')} payments=${d.payments.map((x) => x.id).join(',')} addresses=${d.addresses.map((x) => x.id).join(',')}`;
  });

  for (const article of articles) {
    const text = normalizeArticle(article);
    if (text === '') {
      console.error(`skip «${article}»: пусто после нормализации`);
      continue;
    }
    const args: Record<string, unknown> = { text };
    if (deliveryId) args.delivery_id = deliveryId;
    if (addressId) args.address_id = addressId;
    await run('GetSearch', text, args, (raw) => {
      const s = parseSearchResponse(raw, { localStockIds });
      const stocks = new Set(s.offers.map((o) => o.stock.stockId));
      return `success=${s.success} offers=${s.offers.length} crosses=${s.offers.filter((o) => o.isCross).length} local=${s.offers.filter((o) => o.stock.isLocal).length} stocks=${[...stocks].join(',')}${s.message ? ` message=«${s.message}»` : ''}`;
    });
  }

  for (let i = 0; i < orderIds.length; i += ORDERS_BATCH_SIZE) {
    const batch = orderIds.slice(i, i + ORDERS_BATCH_SIZE);
    await run(
      'GetOrders',
      batch.length === orderIds.length ? null : String(i / ORDERS_BATCH_SIZE + 1),
      { order_ids: { id: batch } },
      () => `ids=${batch.join(',')}`,
    );
  }

  console.log(failures === 0 ? 'Готово.' : `Ошибок: ${failures}.`);
  return failures === 0 ? 0 : EXIT_FAILED;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(errorText(error));
    process.exitCode = EXIT_FAILED;
  },
);
