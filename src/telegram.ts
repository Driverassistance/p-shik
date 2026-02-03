import { config } from './config.js';

type InlineKeyboardButton = { text: string; callback_data?: string; url?: string };
type InlineKeyboardMarkup = { inline_keyboard: InlineKeyboardButton[][] };

const TG_API = `https://api.telegram.org/bot${config.botToken}`;

async function tg(method: string, payload: any) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(`Telegram API error: ${method} ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
}

export function mainMenuKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🛠 Сервис', callback_data: 'MENU:SERVICE' }],
      [{ text: '⚠️ Проблема', callback_data: 'MENU:PROBLEM' }],
      [{ text: '🌿 Ароматы', callback_data: 'MENU:AROMAS' }],
      [{ text: '📄 Сертификаты', callback_data: 'MENU:CERTS' }],
      [{ text: '💬 Обратная связь', callback_data: 'MENU:FEEDBACK' }],
    ],
  };
}

export async function sendMessage(chat_id: number, text: string, keyboard?: InlineKeyboardMarkup) {
  return tg('sendMessage', {
    chat_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ?? undefined,
  });
}

export async function answerCallbackQuery(callback_query_id: string) {
  return tg('answerCallbackQuery', { callback_query_id });
}

export async function editMessage(chat_id: number, message_id: number, text: string, keyboard?: InlineKeyboardMarkup) {
  return tg('editMessageText', {
    chat_id,
    message_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ?? undefined,
  });
}
