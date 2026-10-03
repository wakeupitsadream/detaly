import { isLinkToken } from '@detaly/orders';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { InnerPage, PageBand, PageBody } from '@/components/page/PageBand';
import { VinSent, type VinSentChannel } from '@/components/vin/VinSent';
import { getBrand } from '@/server/brand';
import { serverEnv } from '@/server/env';
import { isDemoMode } from '@/server/mode';

// Reads env (the bot username) at request time; the path carries a one-time link token.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Заявка принята',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** Link tokens are 32 base64url characters (createLinkToken); anything shorter is not ours. */
const MIN_LINK_TOKEN = 16;

type Params = Promise<{ link: string }>;

/**
 * /vin/sent/<link token>: the request is in and Telegram was chosen — «Подключить Telegram»
 * opens the client bot with `?start=<token>` (decision С12). The token is in the path so the
 * Caddy log filter cuts it; the page sends no referrer. The token is checked by the bot, not
 * here: a stale one gets «ссылка устарела» there.
 */
export default async function VinSentLinkPage({ params }: { params: Params }) {
  // DEMO_MODE: no tokens exist (src/proxy.ts answers 404 first).
  if (isDemoMode()) notFound();
  const { link } = await params;
  if (!isLinkToken(link) || link.length < MIN_LINK_TOKEN) notFound();
  const username = serverEnv().TG_CLIENT_BOT_USERNAME;
  // VERIFY: Telegram deep links `https://t.me/<bot>?start=<payload>` take [A-Za-z0-9_-], at most
  // 64 characters (link tokens are 32); checked live only after the client bot is deployed.
  const channel: VinSentChannel = username
    ? {
        kind: 'telegram',
        deepLink: `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(link)}`,
      }
    : { kind: 'sms' };
  return (
    <InnerPage>
      <PageBand eyebrow="Подбор по VIN" title="Заявка отправлена" />
      <PageBody>
        <VinSent channel={channel} hours={getBrand().pickup.hours} demo={false} />
      </PageBody>
    </InnerPage>
  );
}
