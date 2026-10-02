// grammY Api without network: the transport is replaced through api.config.use, every call is
// recorded, and `fail` turns chosen calls into Bot API errors (GrammyError with error_code).
import { Api } from 'grammy';

export interface FakeTelegramCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface FakeTelegram {
  api: Api;
  calls: FakeTelegramCall[];
  /** Texts sent with sendMessage, by chat id. */
  messages(): { chatId: string; text: string }[];
}

export function fakeTelegram(
  options: {
    fail?: (call: FakeTelegramCall) => { error_code: number; description: string } | null;
  } = {},
): FakeTelegram {
  const api = new Api('123456:test-token-not-real');
  const calls: FakeTelegramCall[] = [];
  api.config.use(async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, unknown> };
    calls.push(call);
    const failure = options.fail?.(call) ?? null;
    if (failure) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: false, ...failure } as any;
    }
    const p = payload as { chat_id?: number | string; text?: string };
    const result = {
      message_id: 1000 + calls.length,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(p.chat_id ?? 0), type: 'private' },
      text: p.text,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, result } as any;
  });
  return {
    api,
    calls,
    messages: () =>
      calls
        .filter((call) => call.method === 'sendMessage')
        .map((call) => ({
          chatId: String(call.payload.chat_id),
          text: String(call.payload.text),
        })),
  };
}
