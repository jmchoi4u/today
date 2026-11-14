// 텔레그램 봇 API (긴 폴링). 토큰이 주소에 들어가므로 주소는 절대 기록하지 않는다.
export class TelegramError extends Error {
  constructor(method, code, description, retryAfter) {
    super(`telegram ${method}: ${code} ${description || ''}`.trim());
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function createTelegram({ token, fetchFn = globalThis.fetch }) {
  if (!/^\d+:[\w-]{20,}$/.test(String(token || ''))) throw new Error('텔레그램 봇 토큰 모양이 아니에요 (숫자:문자열)');
  const base = `https://api.telegram.org/bot${token}`;
  async function call(method, body = {}, timeoutMs = 30000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try {
      r = await fetchFn(`${base}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new TelegramError(method, 'network', e?.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
    }
    let j = null;
    try {
      j = await r.json();
    } catch {
      /* 본문이 JSON이 아니면 아래에서 상태 코드로 처리 */
    }
    if (!j?.ok) throw new TelegramError(method, j?.error_code || r.status, j?.description, j?.parameters?.retry_after);
    return j.result;
  }
  const keyboard = buttons => (buttons?.length ? { inline_keyboard: buttons } : undefined);
  return {
    getMe: () => call('getMe'),
    getUpdates: (offset, timeout = 50) => call('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, (timeout + 15) * 1000),
    send: (chatId, text, buttons) => call('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), link_preview_options: { is_disabled: true }, reply_markup: keyboard(buttons) }),
    answer: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text: text ? String(text).slice(0, 190) : undefined }),
    clearButtons: (chatId, messageId) => call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  };
}
