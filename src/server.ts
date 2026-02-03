import Fastify from 'fastify';
import { config } from './config.js';
import { runMigrateV1 } from './migrate.js';
import { q } from './db.js';

function genCode6() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

import { mainMenuKeyboard, sendMessage, answerCallbackQuery, editMessage } from './telegram.js';

const app = Fastify({ logger: true });

// --- Health check ---
app.get('/health', async () => {
  return { ok: true, service: 'pshik-bot', env: config.env, time: new Date().toISOString() };
});

// --- Telegram webhook ---
app.post('/webhook/telegram', async (req, reply) => {
  // --- Telegram webhook hardening (Secret Token) ---
  const tgSecret = (req.headers['x-telegram-bot-api-secret-token'] ?? '').toString();
  if (tgSecret !== config.tgSecretToken) {
    req.log.warn({ tgSecretPresent: Boolean(tgSecret) }, 'Denied telegram webhook: bad secret token');
    return reply.code(401).send({ ok: false });
  }

  // Optional security: allow only internal calls with BOT_KEY header (later we can add Telegram secret token)
  // For now keep open; we’ll lock down next step.
  const update: any = req.body;

  try {
    // /start
    if (update?.message?.text?.startsWith('/start')) {
      const textMsg = update.message.text || '';
      const parts = textMsg.split(' ');
      const deviceId = parts[1] || null;

      if (deviceId) {
        await q(
          `INSERT INTO devices (device_id) VALUES ($1)
           ON CONFLICT (device_id) DO NOTHING`,
          [deviceId]
        );
      }

      await q(
        `INSERT INTO users (tg_user_id, current_device_id)
         VALUES ($1, $2)
         ON CONFLICT (tg_user_id)
         DO UPDATE SET last_seen_at = now(), current_device_id = EXCLUDED.current_device_id`,
        [update.message.from.id, deviceId]
      );

      const chatId = update.message.chat.id as number;
      const text =
        'П-Шик — сервис ароматов.\n\nВыберите раздел:';
      await sendMessage(chatId, text, mainMenuKeyboard());
    }

    // callback buttons
    if (update?.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id as number;
      const messageId = cq.message.message_id as number;
      const data = String(cq.data ?? '');

      // close loading state
      await answerCallbackQuery(cq.id);

      // Basic routing skeleton (we’ll fill content next)
      let title = 'П-Шик — выберите раздел:';
      if (data === 'MENU:SERVICE') title = '🛠 Сервис — выберите пункт:';
      if (data === 'MENU:PROBLEM') title = '⚠️ Проблема — выберите ситуацию:';
      if (data === 'MENU:AROMAS') title = '🌿 Ароматы — выберите категорию:';
      if (data === 'MENU:CERTS') title = '📄 Сертификаты — открыто и прозрачно:';
      if (data === 'MENU:FEEDBACK') title = '💬 Обратная связь — выберите вариант:';

      await editMessage(chatId, messageId, title, mainMenuKeyboard());
    }

    reply.send({ ok: true });
  } catch (e: any) {
    app.log.error(e);
    reply.code(200).send({ ok: true }); // Telegram must get 200
  }
});

// --- Auto-migrate (Railway only, controlled by env) ---
if (process.env.AUTO_MIGRATE === '1') {
  try {
    app.log.info('AUTO_MIGRATE=1 → running migrate v1');
    await runMigrateV1();
    app.log.info('✅ migrate v1 ok');
  } catch (e: any) {
    app.log.error(e, '❌ migrate failed');
    process.exit(1);
  }
}

// --- Start ---
app.listen({ port: config.port, host: '0.0.0.0' })
  .then(() => app.log.info(`Up: ${config.baseUrl}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
