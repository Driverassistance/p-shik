import Fastify from 'fastify';
import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { runMigrateV1 } from './migrate.js';
import { q } from './db.js';


async function issueCreditForUser(tg_user_id: number, device_id: string, reason: string, days: number) {
  const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  let code = '';
  for (let i = 0; i < 15; i++) {
    code = genCode6();
    const rows = await q("SELECT id FROM credits WHERE code=$1 AND status='active'", [code]);
    if (rows.length === 0) break;
  }
  if (!code) throw new Error('code_gen_failed');

  await q(
    `INSERT INTO credits (code, tg_user_id, device_id, issued_reason, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [code, tg_user_id, device_id, reason, expires_at.toISOString()]
  );

  return { code, expires_at };
}

function genCode6() {

  return Math.floor(100000 + Math.random() * 900000).toString();
}

import { mainMenuKeyboard, sendMessage, answerCallbackQuery, editMessage } from './telegram.js';

const bot = new Telegraf(config.botToken);

const app = Fastify({ logger: true });

// --- Health check ---

// ===================== Telegram Webhook =====================
app.post('/telegram/webhook', async (req, reply) => {
  await bot.handleUpdate(req.body as any);
  reply.send({ ok: true });
});
// ===========================================================

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

// ===================== Credits API (v1) =====================
// POST /api/bot/issue-credit
// Body: { tg_user_id, device_id, reason, days? }
// Returns: { ok, code, expires_at }
app.post('/api/bot/issue-credit', async (req, reply) => {
  const body: any = req.body || {};
  const tg_user_id = Number(body.tg_user_id);
  const device_id = String(body.device_id || '');
  const reason = String(body.reason || 'problem');
  const days = Number(body.days || 7);

  if (!tg_user_id || !device_id) return reply.code(400).send({ ok:false, error:'bad_request' });

  const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  let code = '';
  for (let i=0; i<15; i++) {
    code = genCode6();
    const rows = await q('SELECT id FROM credits WHERE code=$1 AND status=\'active\'', [code]);
    if (rows.length === 0) break;
  }
  if (!code) return reply.code(500).send({ ok:false, error:'code_gen_failed' });

  await q(
    `INSERT INTO credits (code, tg_user_id, device_id, issued_reason, expires_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [code, tg_user_id, device_id, reason, expires_at.toISOString()]
  );

  return reply.send({ ok:true, code, expires_at });
});

// POST /api/device/redeem-credit
// Headers: x-device-api-key: <DEVICE_API_KEY>
// Body: { device_id, code }
// Returns: { ok, result, reason? }
app.post('/api/device/redeem-credit', async (req, reply) => {
  const apiKey = (req.headers['x-device-api-key'] ?? '').toString();
  if (apiKey !== config.deviceApiKey) return reply.code(401).send({ ok:false, result:'DENIED', reason:'bad_key' });

  const body: any = req.body || {};
  const device_id = String(body.device_id || '');
  const code = String(body.code || '').trim();

  if (!device_id || !code) return reply.code(400).send({ ok:false, result:'DENIED', reason:'bad_request' });

  const rows: any[] = await q(
    `SELECT id, status, expires_at, device_id AS bound_device
     FROM credits WHERE code=$1 LIMIT 1`,
    [code]
  );
  if (rows.length === 0) return reply.send({ ok:true, result:'DENIED', reason:'not_found' });

  const c = rows[0];
  if (c.bound_device !== device_id) return reply.send({ ok:true, result:'DENIED', reason:'wrong_device' });
  if (c.status !== 'active') return reply.send({ ok:true, result:'DENIED', reason:'not_active' });

  const exp = new Date(c.expires_at);
  if (Date.now() > exp.getTime()) {
    await q(`UPDATE credits SET status='expired' WHERE id=$1 AND status='active'`, [c.id]);
    await q(`INSERT INTO redemptions (credit_id, device_id, result) VALUES ($1,$2,'denied')`, [c.id, device_id]);
    return reply.send({ ok:true, result:'DENIED', reason:'expired' });
  }

  const upd: any[] = await q(
    `UPDATE credits SET status='used', used_at=now()
     WHERE id=$1 AND status='active'
     RETURNING id`,
    [c.id]
  );

  if (upd.length === 0) {
    await q(`INSERT INTO redemptions (credit_id, device_id, result) VALUES ($1,$2,'denied')`, [c.id, device_id]);
    return reply.send({ ok:true, result:'DENIED', reason:'race' });
  }

  await q(`INSERT INTO redemptions (credit_id, device_id, result) VALUES ($1,$2,'success')`, [c.id, device_id]);
  return reply.send({ ok:true, result:'OK' });
});
// =============================================================

// ===================== Telegram: Problem menu =====================
bot.action('CB_PROBLEM_MENU', async (ctx) => {
  await ctx.editMessageText('Выберите проблему:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Аппарат не сработал', callback_data: 'CB_PROBLEM_NO_SPRAY' }],
        [{ text: 'Деньги списались, пшика не было', callback_data: 'CB_PROBLEM_NO_SPRAY' }],
        [{ text: 'Слабый пшик', callback_data: 'CB_PROBLEM_WEAK' }],
        [{ text: 'Закончился аромат', callback_data: 'CB_PROBLEM_EMPTY' }],
        [{ text: 'Другое', callback_data: 'CB_PROBLEM_OTHER' }],
        [{ text: '⬅ Назад', callback_data: 'CB_MAIN_MENU' }],
      ],
    },
  });
});

// Общий обработчик компенсации
async function handleCompensation(ctx: any, reason: string, days: number) {
  const tg_user_id = ctx.from.id;
  const device_id = ctx.session?.device_id || 'UNKNOWN';

  const { code, expires_at } = await issueCreditForUser(tg_user_id, device_id, reason, days);

  await ctx.editMessageText(
    `🎁 Компенсация сервисом

Ваш бесплатный пшик готов.

` +
    `Код: *${code}*
` +
    `Срок действия: ${expires_at.toLocaleDateString()}

` +
    `Введите код на терминале.`,
    { parse_mode: 'Markdown' }
  );
}

bot.action('CB_PROBLEM_NO_SPRAY', async (ctx) => {
  await handleCompensation(ctx, 'problem', 30);
});

bot.action('CB_PROBLEM_WEAK', async (ctx) => {
  await handleCompensation(ctx, 'problem', 7);
});

bot.action('CB_PROBLEM_EMPTY', async (ctx) => {
  await handleCompensation(ctx, 'problem', 7);
});

bot.action('CB_PROBLEM_OTHER', async (ctx) => {
  await ctx.editMessageText(
    'Если вы не нашли нужный пункт, напишите нам одним сообщением. Мы обязательно учтём ваше обращение.'
  );
});
// ================================================================





// --- Telegram webhook setup ---
if (process.env.WEBHOOK_URL) {
  const url = process.env.WEBHOOK_URL + '/telegram/webhook';
  bot.telegram.setWebhook(url);
}
// ------------------------------

app.listen(
{ port: config.port, host: '0.0.0.0' })
  .then(() => app.log.info(`Up: ${config.baseUrl}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
