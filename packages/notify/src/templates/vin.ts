/** VIN proposal link (/p/<token>), one of the SMS allowlisted templates. */
import { lines } from '../format';
import type { RenderedMessage, VinProposalData } from '../types';

export function renderVinProposal(data: VinProposalData): RenderedMessage {
  return {
    text: lines(
      `${data.brandName} · подбор по VIN готов`,
      data.comment,
      'Цены и сроки — по ссылке.',
    ),
    buttons: [[{ kind: 'url', text: 'Открыть подборку', url: data.proposalUrl }]],
  };
}
