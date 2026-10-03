/**
 * VIN request templates (docs/phase-1c-implementation.md decision С20, section 7.1 item 2):
 * - vin_received — the request reached the master (messenger only: not in the SMS allowlist);
 * - vin_proposal — the proposal link /p/<token> (SMS allowlisted, PLAN section 4).
 * No PD: the request number, the link and the master's comment with digit runs masked (the
 * master may paste a phone or a document number by mistake, decision С2).
 */
import { maskDigits, type VinNotifyTemplate } from '@detaly/domain';
import { lines } from '../format';
import type { MessageButton, RenderedMessage, VinTemplateData } from '../types';

type Render = (d: VinTemplateData) => RenderedMessage;

const head = (d: VinTemplateData): string => `${d.brandName} · заявка VIN № ${d.requestNumber}`;
const comment = (d: VinTemplateData): string | null => {
  const text = d.comment?.trim();
  return text ? `Комментарий мастера: ${maskDigits(text)}` : null;
};
const proposalButton = (d: VinTemplateData): MessageButton[] =>
  d.proposalUrl ? [{ kind: 'url', text: 'Открыть подборку', url: d.proposalUrl }] : [];

export const VIN_TEMPLATES: Record<VinNotifyTemplate, Render> = {
  vin_received: (d) => ({
    text: lines(
      head(d),
      'Заявка принята. Мастер подберёт детали и пришлёт сюда ссылку на подборку в рабочее время, обычно в течение 4 часов.',
    ),
    buttons: [],
  }),
  vin_proposal: (d) => ({
    text: lines(
      head(d),
      'Подборка готова: цены и сроки — по ссылке, там же можно оформить и оплатить заказ.',
      comment(d),
    ),
    buttons: [proposalButton(d)].filter((row) => row.length > 0),
    // SMS: two segments with the /p/ link; the sender name carries the brand.
    smsText: `Подбор по VIN № ${d.requestNumber} готов: цены и сроки по ссылке.`,
  }),
};

export function renderVinTemplate(
  template: VinNotifyTemplate,
  data: VinTemplateData,
): RenderedMessage {
  return VIN_TEMPLATES[template](data);
}

/** The proposal link message (phase 1B name). */
export function renderVinProposal(data: VinTemplateData): RenderedMessage {
  return renderVinTemplate('vin_proposal', data);
}
