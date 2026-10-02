/** Seller bot /ping answer: "pong · heartbeat Ns · db ok · <GIT_SHA>". */
import type { PingData, RenderedMessage } from '../types';

export function renderPing(data: PingData): RenderedMessage {
  const heartbeat =
    data.heartbeatAgeSec === null
      ? 'heartbeat нет'
      : `heartbeat ${Math.round(data.heartbeatAgeSec)}s`;
  const db = data.dbOk ? 'db ok' : 'db fail';
  const sha = data.gitSha ? data.gitSha.slice(0, 7) : 'dev';
  return { text: `pong · ${heartbeat} · ${db} · ${sha}`, buttons: [] };
}
