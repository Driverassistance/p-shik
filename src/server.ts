import Fastify from 'fastify';
import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { runMigrateV1 } from './migrate.js';
import { q } from './db.js';


async function issueCreditForUser(tg_user_id: number, device_id: string, reason: string, days: number) {
  const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  // One active code per user per device: revoke previous active
  await q(
    `UPDATE credits SET status='revoked'
     WHERE tg_user_id=$1 AND device_id=$2 AND status='active'`,
    [tg_user_id, device_id]
  );

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


function extractDeviceIdFromStart(ctx: any): string | null {
  // Telegraf may provide ctx.startPayload, but also user can type "/start BANYA_01"
  const text = (ctx.message && ctx.message.text) ? String(ctx.message.text) : '';
  const parts = text.split(' ').map((x: string) => x.trim()).filter(Boolean);
  const payload = (ctx.startPayload && String(ctx.startPayload).trim()) || (parts.length >= 2 ? parts[1] : '');
  const device_id = payload ? String(payload).trim() : '';
  // allow only our standard format TYPE_NN (e.g., BANYA_01)
  if (!device_id) return null;
  if (!/^[A-Z]+_\d{2}$/.test(device_id)) return null;
  return device_id;
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

  // One active code per user per device: revoke previous active
  await q(
    `UPDATE credits SET status='revoked'
     WHERE tg_user_id=$1 AND device_id=$2 AND status='active'`,
    [tg_user_id, device_id]
  );

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
  const rows: any[] = await q('SELECT current_device_id FROM users WHERE tg_user_id=$1 LIMIT 1', [tg_user_id]);
  const device_id = rows?.[0]?.current_device_id || 'UNKNOWN';
  if (!device_id || device_id === 'UNKNOWN') {
    return ctx.editMessageText('⚠️ Пожалуйста, отсканируйте QR на аппарате (так мы привяжем компенсацию к вашей локации).');
  }

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

// ===================== Telegram /start =====================

bot.start(async (ctx) => {
  const tg_user_id = ctx.from.id;
  const device_id = extractDeviceIdFromStart(ctx);

  // upsert user + last location
  await q(
    `INSERT INTO users (tg_user_id, current_device_id, first_seen_at, last_seen_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (tg_user_id)
     DO UPDATE SET last_seen_at=now(), current_device_id=COALESCE(EXCLUDED.current_device_id, users.current_device_id)`,
    [tg_user_id, device_id]
  );

  await ctx.reply(
    '👋 Добро пожаловать в *П-Шик*\n\nЯ помогу быстро и без лишних вопросов.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛠 Сервис', callback_data: 'CB_SERVICE_MENU' }],
          [{ text: '⚠️ Проблема', callback_data: 'CB_PROBLEM_MENU' }],
          [{ text: 'Ароматы', callback_data: 'CB_AROMAS_MENU' }],
          [{ text: '📄 Сертификаты', callback_data: 'CB_CERTS_MENU' }],
          [{ text: '💬 Обратная связь', callback_data: 'CB_FEEDBACK_MENU' }],
        ],
      },
    }
  );
});
// ==========================================================



app.listen(
{ port: config.port, host: '0.0.0.0' })
  .then(() => app.log.info(`Up: ${config.baseUrl}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });


// === UI_V2_START ===

// ---- Telegraf error catcher ----
bot.catch(async (err, ctx) => {
  try {
    console.error('Telegraf error:', err);
  } catch (_) {}
});

// ---- MAIN MENU RENDER ----
function renderMainMenu() {
  return {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🛠 Сервис', callback_data: 'CB_SERVICE_MENU' },
          { text: '⚠️ Проблема', callback_data: 'CB_PROBLEM_MENU' }
        ],
        [
          { text: 'Ароматы', callback_data: 'CB_AROMAS_MENU' },
          { text: '📄 Сертификаты', callback_data: 'CB_CERTS_MENU' }
        ],
        [
          { text: '💬 Обратная связь', callback_data: 'CB_FEEDBACK_MENU' }
        ]
      ]
    }
  };
}

async function goMainMenu(ctx) {
  // UX: always send a NEW menu message so it appears at the bottom (auto-scroll)
  try { await ctx.reply('🏠 *Главное меню*', renderMainMenu()); } catch (_) {}
  // Try to delete previous message to avoid clutter (safe)
  try { if (ctx.updateType === 'callback_query') await ctx.deleteMessage(); } catch (_) {}
}

// ---- MAIN MENU BUTTON ----
bot.action('CB_MAIN_MENU', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await goMainMenu(ctx);
});

// ================= SERVICE =================

bot.action('CB_SERVICE_MENU', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '🛠 *Сервис П-Шик*\n\nВыберите, что вас интересует:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📖 Как пользоваться', callback_data: 'CB_SERVICE_HOW' }],
          [{ text: '💳 Оплата', callback_data: 'CB_SERVICE_PAY' }],
          [{ text: '💨 1 или 2 пшика', callback_data: 'CB_SERVICE_SPRAY' }],
          [{ text: '🎯 Куда распылять', callback_data: 'CB_SERVICE_WHERE' }],
          [{ text: '⚠️ Безопасность', callback_data: 'CB_SERVICE_SAFE' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

bot.action('CB_SERVICE_HOW', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '📖 *Как пользоваться*\n\n1️⃣ Выберите аромат\n2️⃣ Оплатите\n3️⃣ Нажмите кнопку на аппарате',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_SERVICE_MENU' }],[{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]] }
    }
  );
});

bot.action('CB_SERVICE_PAY', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '💳 *Оплата*\n\nQR (Kaspi / Halyk / Freedom)\nNFC / карта',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_SERVICE_MENU' }],[{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]] }
    }
  );
});

bot.action('CB_SERVICE_SPRAY', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '💨 *1 или 2 пшика*\n\n1 — лёгко\n2 — насыщенно',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_SERVICE_MENU' }],[{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]] }
    }
  );
});

bot.action('CB_SERVICE_WHERE', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '🎯 *Куда распылять*\n\nШея / за ухо / одежда\n❌ Не в лицо',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_SERVICE_MENU' }],[{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]] }
    }
  );
});

bot.action('CB_SERVICE_SAFE', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '⚠️ *Безопасность*\n\nИндивидуальная реакция возможна',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_SERVICE_MENU' }],[{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]] }
    }
  );
});

// ================= AROMAS =================

bot.action('CB_AROMAS_MENU', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '*Ароматы*',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👩 Женские', callback_data: 'CB_AROMAS_WOMEN_LIST' }],
          [{ text: '👨 Мужские', callback_data: 'CB_AROMAS_MEN_LIST' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

bot.action('CB_AROMAS_WOMEN', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '👩 *Женские ароматы*\n\nСкоро: W1–W5',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_AROMAS_MENU' }]] }
    }
  );
});

bot.action('CB_AROMAS_MEN', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '👨 *Мужские ароматы*\n\nСкоро: M1–M5',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_AROMAS_MENU' }]] }
    }
  );
});

// ================= STUBS =================

bot.action('CB_CERTS_MENU', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '📄 *Сертификаты*\n\nРаздел в разработке',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]] } }
  );
});

bot.action('CB_FEEDBACK_MENU', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '💬 *Обратная связь*\n\nРаздел в разработке',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }]] } }
  );
});

// === UI_V2_END ===


// === AROMAS_CARDS_V1_START ===

// Women list
bot.action('CB_AROMAS_WOMEN', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '👩 *Женские ароматы*\n\nВыберите аромат:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'W1', callback_data: 'CB_AROMA_W1' }],
          [{ text: 'W2', callback_data: 'CB_AROMA_W2' }],
          [{ text: 'W3', callback_data: 'CB_AROMA_W3' }],
          [{ text: 'W4', callback_data: 'CB_AROMA_W4' }],
          [{ text: 'W5', callback_data: 'CB_AROMA_W5' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_AROMAS_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// Men list
bot.action('CB_AROMAS_MEN', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '👨 *Мужские ароматы*\n\nВыберите аромат:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'M1', callback_data: 'CB_AROMA_M1' }],
          [{ text: 'M2', callback_data: 'CB_AROMA_M2' }],
          [{ text: 'M3', callback_data: 'CB_AROMA_M3' }],
          [{ text: 'M4', callback_data: 'CB_AROMA_M4' }],
          [{ text: 'M5', callback_data: 'CB_AROMA_M5' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_AROMAS_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

function aromaCardText(code) {
  // Пока без названий — только профиль и контекст.
  // Потом заменим на реальные описания, не меняя логику.
  const isW = code.startsWith('W');
  const title = isW ? '👩 *Женский аромат*' : '👨 *Мужской аромат*';

  return (
    title + ' — *' + code + '*\n\n' +
    '✅ *Для чего:* работа / прогулка / вечер\n' +
    '⏰ *Когда:* утро / день / ночь\n\n' +
    '💨 *Сколько пшиков:*\n' +
    '• 1 — лёгкий, аккуратный\n' +
    '• 2 — насыщенный\n\n' +
    'Совет: начните с 1, если пробуете впервые.'
  );
}

async function showAromaCard(ctx, code) {
  try { await ctx.answerCbQuery(); } catch (_) {}
  const backCb = code.startsWith('W') ? 'CB_AROMAS_WOMEN' : 'CB_AROMAS_MEN';

  await ctx.editMessageText(
    aromaCardText(code),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: backCb }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
}

// Women cards
bot.action('CB_AROMA_W1', (ctx) => showAromaCard(ctx, 'W1'));
bot.action('CB_AROMA_W2', (ctx) => showAromaCard(ctx, 'W2'));
bot.action('CB_AROMA_W3', (ctx) => showAromaCard(ctx, 'W3'));
bot.action('CB_AROMA_W4', (ctx) => showAromaCard(ctx, 'W4'));
bot.action('CB_AROMA_W5', (ctx) => showAromaCard(ctx, 'W5'));

// Men cards
bot.action('CB_AROMA_M1', (ctx) => showAromaCard(ctx, 'M1'));
bot.action('CB_AROMA_M2', (ctx) => showAromaCard(ctx, 'M2'));
bot.action('CB_AROMA_M3', (ctx) => showAromaCard(ctx, 'M3'));
bot.action('CB_AROMA_M4', (ctx) => showAromaCard(ctx, 'M4'));
bot.action('CB_AROMA_M5', (ctx) => showAromaCard(ctx, 'M5'));

// === AROMAS_CARDS_V1_END ===


// === AROMAS_V2_START ===

// Women list (v2)
bot.action('CB_AROMAS_WOMEN_LIST', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '👩 *Женские ароматы*\n\nВыберите аромат:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'W1', callback_data: 'CB_A2_W1' }],
          [{ text: 'W2', callback_data: 'CB_A2_W2' }],
          [{ text: 'W3', callback_data: 'CB_A2_W3' }],
          [{ text: 'W4', callback_data: 'CB_A2_W4' }],
          [{ text: 'W5', callback_data: 'CB_A2_W5' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_AROMAS_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// Men list (v2)
bot.action('CB_AROMAS_MEN_LIST', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '👨 *Мужские ароматы*\n\nВыберите аромат:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'M1', callback_data: 'CB_A2_M1' }],
          [{ text: 'M2', callback_data: 'CB_A2_M2' }],
          [{ text: 'M3', callback_data: 'CB_A2_M3' }],
          [{ text: 'M4', callback_data: 'CB_A2_M4' }],
          [{ text: 'M5', callback_data: 'CB_A2_M5' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_AROMAS_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

function aromaV2Text(code, gender) {
  const title = (gender === 'W') ? '👩 *Женский аромат*' : '👨 *Мужской аромат*';
  return (
    title + ' — *' + code + '*\n\n' +
    '✅ *Для чего:* работа / прогулка / вечер\n' +
    '⏰ *Когда:* утро / день / ночь\n\n' +
    '💨 *Сколько пшиков:*\n' +
    '• 1 — лёгкий, аккуратный\n' +
    '• 2 — насыщенный\n\n' +
    'Совет: начните с 1, если пробуете впервые.'
  );
}

async function showAromaV2(ctx, code, gender) {
  try { await ctx.answerCbQuery(); } catch (_) {}
  const backCb = (gender === 'W') ? 'CB_AROMAS_WOMEN_LIST' : 'CB_AROMAS_MEN_LIST';
  await ctx.editMessageText(
    aromaV2Text(code, gender),
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: backCb }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
}

// Women cards (v2)
bot.action('CB_A2_W1', (ctx) => showAromaV2(ctx, 'W1', 'W'));
bot.action('CB_A2_W2', (ctx) => showAromaV2(ctx, 'W2', 'W'));
bot.action('CB_A2_W3', (ctx) => showAromaV2(ctx, 'W3', 'W'));
bot.action('CB_A2_W4', (ctx) => showAromaV2(ctx, 'W4', 'W'));
bot.action('CB_A2_W5', (ctx) => showAromaV2(ctx, 'W5', 'W'));

// Men cards (v2)
bot.action('CB_A2_M1', (ctx) => showAromaV2(ctx, 'M1', 'M'));
bot.action('CB_A2_M2', (ctx) => showAromaV2(ctx, 'M2', 'M'));
bot.action('CB_A2_M3', (ctx) => showAromaV2(ctx, 'M3', 'M'));
bot.action('CB_A2_M4', (ctx) => showAromaV2(ctx, 'M4', 'M'));
bot.action('CB_A2_M5', (ctx) => showAromaV2(ctx, 'M5', 'M'));

// === AROMAS_V2_END ===
