import Fastify from 'fastify';
import { Telegraf } from 'telegraf';
import { config } from './config.js';
import { runMigrateV1, runMigrateV2 } from './migrate.js';
import { q } from './db.js';

console.log("🚀 P-SHIK BOOT", {
  commit: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GITHUB_SHA || "unknown",
  time: new Date().toISOString()
});

async function issueCreditForUser(tg_user_id: number, device_id: string, reason: string, days: number) {
  const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  // One active code per user: revoke previous active
  await q(
  `UPDATE credits SET status='revoked'
   WHERE tg_user_id=$1 AND status='active'`,
  [tg_user_id]
    );



  let code = '';
  for (let i = 0; i < 15; i++) {
    code = genCode6();
    const rows = await q("SELECT id FROM credits WHERE code=$1", [code]);
    
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

// --- Thanks queue runner (every 60s) ---
setInterval(() => processThanksQueue(bot).catch((e:any)=>console.error("processThanksQueue error", e)), 60_000);
// --------------------------------------

// --- touch tracker: any interaction schedules thanks message ---
bot.use(async (ctx, next) => {
  try {
    const tg_user_id = ctx?.from?.id;
    if (tg_user_id) await markUserTouch(tg_user_id);
  } catch (e) {
    console.error('markUserTouch error', e);
  }
  return next();
});
// -------------------------------------------------------------




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
      const deviceId = (parts[1] ? String(parts[1]).trim() : 'UNKNOWN');

      if (deviceId && deviceId !== 'UNKNOWN') {
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
      await runMigrateV2();
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
    const rows = await q('SELECT id FROM credits WHERE code=$1', [code]);
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
        [{ text: 'Деньги списались, пшика не было', callback_data: 'CB_PROBLEM_CHARGED' }],
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
  // anti-abuse: если уже была компенсация за последние 7 дней — переводим на ручную проверку
  const recent: any[] = await q(
    `SELECT created_at
     FROM comp_requests
     WHERE tg_user_id=$1
       AND created_at > now() - interval '7 days'
     ORDER BY created_at DESC
     LIMIT 1`,
    [tg_user_id]
  );

  if (recent && recent.length > 0) {
    await q(
      `INSERT INTO comp_requests (tg_user_id, device_id, reason, status)
       VALUES ($1,$2,$3,'manual')`,
      [tg_user_id, device_id, reason]
    );
// уведомление администратору
try {
  await bot.telegram.sendMessage(
    Number(process.env.ADMIN_TG_ID || 473294026),
    `⚠️ Manual compensation\n\nUser: ${tg_user_id}\nDevice: ${device_id}\nReason: ${reason}`
  );
} catch (e) {
  console.error('Admin notify error', e);
}
    return ctx.editMessageText(
  '✅ Заявка принята.\n\nМы передали обращение техническому специалисту для проверки работы аппарата.\n\nЕсли проблема срочная или пшика действительно не было, пожалуйста, сразу свяжитесь с сервис-менеджером:',
  {
    reply_markup: {
      inline_keyboard: [
        [{ text: '💬 Написать в WhatsApp', url: 'https://wa.me/77052744440' }],
        [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
      ]
    }
  }
);
  } 
  const { code, expires_at } = await issueCreditForUser(tg_user_id, device_id, reason, days);
  await q(
    `INSERT INTO comp_requests (tg_user_id, device_id, reason, status)
     VALUES ($1,$2,$3,'issued')`,
    [tg_user_id, device_id, reason]
  );
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


bot.action('CB_PROBLEM_CHARGED', async (ctx) => {
  await handleCompensation(ctx, 'charged', 30);
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





// --- DB bootstrap (runs once on server start) ---
async function ensureDbBootstrap() {
  try {
    // --- feedback ---
    await q(`
      CREATE TABLE IF NOT EXISTS feedback (
        id BIGSERIAL PRIMARY KEY,
        tg_user_id BIGINT NOT NULL,
        device_id TEXT,
        rating TEXT,
        reason TEXT,
        message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_feedback_tg_user_id ON feedback (tg_user_id);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_feedback_device_id ON feedback (device_id);`);
    await q(`CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at);`);

    // --- comp_requests (anti-abuse for compensations) ---
    await q(`
      CREATE TABLE IF NOT EXISTS comp_requests (
        id BIGSERIAL PRIMARY KEY,
        tg_user_id BIGINT NOT NULL,
        device_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        status TEXT NOT NULL DEFAULT 'issued' -- issued|manual
      );
    `);
    await q(`CREATE INDEX IF NOT EXISTS idx_comp_requests_user_time ON comp_requests (tg_user_id, created_at DESC);`);

    // --- user_state (for flows like "Написать нам") ---
    await q(`
      CREATE TABLE IF NOT EXISTS user_state (
        tg_user_id BIGINT PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'idle',
        payload JSONB,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // harden old schemas (safe even if columns exist)
    await q(`ALTER TABLE user_state ADD COLUMN IF NOT EXISTS state TEXT;`);
    await q(`ALTER TABLE user_state ADD COLUMN IF NOT EXISTS payload JSONB;`);
    await q(`ALTER TABLE user_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;`);

      // --- thanks_queue (auto thank-you message) ---
      await q(`
        CREATE TABLE IF NOT EXISTS thanks_queue (
          tg_user_id BIGINT PRIMARY KEY,
          due_at TIMESTAMPTZ NOT NULL,
          last_touch_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          status TEXT NOT NULL DEFAULT 'pending', -- pending|sent
          sent_at TIMESTAMPTZ
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS idx_thanks_queue_due_at ON thanks_queue (due_at);`);
      await q(`CREATE INDEX IF NOT EXISTS idx_thanks_queue_status ON thanks_queue (status);`);


    
      // --- loyalty_claims (1 free spray per 30 days) ---
      await q(`
        CREATE TABLE IF NOT EXISTS loyalty_claims (
          tg_user_id BIGINT NOT NULL,
          device_id TEXT NOT NULL,
          last_claim_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (tg_user_id, device_id)
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS idx_loyalty_claims_last_claim_at ON loyalty_claims (last_claim_at);`);

      // --- user_touch (thank-you followups + loyalty) ---
      await q(`
        CREATE TABLE IF NOT EXISTS user_touch (
          tg_user_id BIGINT PRIMARY KEY,
          last_touch_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          next_thanks_at TIMESTAMPTZ,
          last_thanks_at TIMESTAMPTZ,
          thanks_locked_at TIMESTAMPTZ,
          thanks_processed_at TIMESTAMPTZ
        );
      `);
      await q(`CREATE INDEX IF NOT EXISTS idx_user_touch_next_thanks_at ON user_touch (next_thanks_at);`);

      await q(`ALTER TABLE user_touch ADD COLUMN IF NOT EXISTS thanks_locked_at TIMESTAMPTZ;`);
      await q(`ALTER TABLE user_touch ADD COLUMN IF NOT EXISTS thanks_processed_at TIMESTAMPTZ;`);

      await q(`CREATE INDEX IF NOT EXISTS idx_user_touch_last_thanks_at ON user_touch (last_thanks_at);`);

      console.log("✅ DB bootstrap ok (feedback, user_state)");
  } catch (e) {
    console.error("❌ DB bootstrap failed", e);
    process.exit(1);
  }
}

await ensureDbBootstrap();
// --- Telegram webhook setup ---
if (process.env.WEBHOOK_URL) {
  const url = process.env.WEBHOOK_URL + '/telegram/webhook';
  bot.telegram.setWebhook(url);
}
// ------------------------------

// ===================== Telegram /start =====================

bot.command('myid', async (ctx) => {
  return ctx.reply(String(ctx.from.id));
});

bot.start(async (ctx) => {
  const tg_user_id = ctx.from.id;
  const device_id = extractDeviceIdFromStart(ctx) || 'UNKNOWN';

  // upsert user + last location
  await q(
    `INSERT INTO users (tg_user_id, current_device_id, first_seen_at, last_seen_at)
     VALUES ($1, $2, now(), now())
     ON CONFLICT (tg_user_id)
     DO UPDATE SET last_seen_at=now(), current_device_id=COALESCE(EXCLUDED.current_device_id, users.current_device_id)`,
    [tg_user_id, device_id]
  );

  return await ctx.reply(
    '👋 Добро пожаловать в *П-Шик*\n\nЯ помогу быстро и без лишних вопросов.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🛠 Сервис', callback_data: 'CB_SERVICE_MENU' }],
          [{ text: '⚠️ Проблема', callback_data: 'CB_PROBLEM_MENU' }],
          [{ text: 'Ароматы', callback_data: 'CB_AROMAS_MENU' }],
          [{ text: '📄 Сертификаты', callback_data: 'CB_CERTS_V2_MENU' }],
          [{ text: '💬 Обратная связь', callback_data: 'CB_FEEDBACK_V2_MENU' }],
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
          { text: '📄 Сертификаты', callback_data: 'CB_CERTS_V2_MENU' }
        ],
        [
          { text: '💬 Обратная связь', callback_data: 'CB_FEEDBACK_V2_MENU' }
        ]
      ]
    }
  };
}

async function goMainMenu(ctx) {
  // UX: always send a NEW menu message so it appears at the bottom (auto-scroll)
  try { return await ctx.reply('🏠 *Главное меню*', renderMainMenu()); } catch (_) {}
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
          [{ text: '🎁 Бесплатный пшик', callback_data: 'CB_LOYALTY_CLAIM' }],
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
bot.action('CB_LOYALTY_CLAIM', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}

  const tg_user_id = ctx.from.id;
  const device_id = await getUserDeviceId(tg_user_id);

  if (!device_id || device_id === 'UNKNOWN') {
    return await ctx.editMessageText(
      '🎁 *Бесплатный пшик раз в 30 дней*\n\nЧтобы активировать подарок, откройте бот через QR аппарата.',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад', callback_data: 'CB_SERVICE_MENU' }],
            [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
          ]
        }
      }
    );
  }

  const rows = await q(
    `SELECT last_claim_at
     FROM loyalty_claims
     WHERE tg_user_id=$1 AND device_id=$2
     LIMIT 1`,
    [tg_user_id, device_id]
  );

  const last = rows?.[0]?.last_claim_at ? new Date(rows[0].last_claim_at) : null;
  const now = new Date();
  const ms30d = 30 * 24 * 60 * 60 * 1000;

  if (last && (now.getTime() - last.getTime()) < ms30d) {
    const next = new Date(last.getTime() + ms30d);
    const nextStr = next.toISOString().slice(0, 10);

    return await ctx.editMessageText(
      `🎁 *Бесплатный пшик раз в 30 дней*\n\nСледующий подарок будет доступен: *${nextStr}*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад', callback_data: 'CB_SERVICE_MENU' }],
            [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
          ]
        }
      }
    );
  }

  const { code } = await issueCreditForUser(tg_user_id, device_id, 'loyalty', 30);

  await q(
    `INSERT INTO loyalty_claims (tg_user_id, device_id, last_claim_at)
     VALUES ($1,$2, now())
     ON CONFLICT (tg_user_id, device_id)
     DO UPDATE SET last_claim_at=EXCLUDED.last_claim_at`,
    [tg_user_id, device_id]
  );

  return await ctx.editMessageText(
    `🎁 *Ваш бесплатный пшик готов!*\n\nКод: *${code}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: 'CB_SERVICE_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
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


// === CERTS_V1_START ===

// Сертификаты — меню
bot.action('CB_CERTS_MENU', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '📄 *Сертификаты и безопасность*\n\nМы открыты и ничего не скрываем. Выберите раздел:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🧾 Сертификаты оборудования', callback_data: 'CB_CERTS_EQUIP' }],
          [{ text: '📦 Официальность поставок', callback_data: 'CB_CERTS_DOCS' }],
          [{ text: '⚠️ Предупреждения', callback_data: 'CB_CERTS_WARN' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// Сертификаты оборудования
bot.action('CB_CERTS_EQUIP', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '🧾 *Сертификаты оборудования*\n\nСертификаты будут доступны здесь (PDF/фото).\n\nП-Шик работает на оборудовании, рассчитанном на общественные места и ежедневное использование.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: 'CB_CERTS_V2_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// Официальность поставок / документы
bot.action('CB_CERTS_DOCS', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '📦 *Официальность поставок*\n\nМы работаем как ТОО в Казахстане.\nДокументы и подтверждения поставок/закупок будем публиковать здесь по мере обновления.\n\nЦель — максимальная прозрачность и доверие.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: 'CB_CERTS_V2_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// Предупреждения
bot.action('CB_CERTS_WARN', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '⚠️ *Предупреждения и безопасность*\n\n• Возможна индивидуальная реакция\n• Не распылять в глаза/лицо\n• При аллергии лучше не использовать\n\nЕсли вам нужен совет — напишите через “Обратная связь”.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: 'CB_CERTS_V2_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// === CERTS_V1_END ===


// === CERTS_V2_START ===

bot.action('CB_CERTS_V2_MENU', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '📄 *Сертификаты и безопасность*\n\nМы открыты и ничего не скрываем. Выберите раздел:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🧾 Сертификаты оборудования', callback_data: 'CB_CERTS_V2_EQUIP' }],
          [{ text: '📦 Официальность поставок', callback_data: 'CB_CERTS_V2_DOCS' }],
          [{ text: '⚠️ Предупреждения', callback_data: 'CB_CERTS_V2_WARN' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_MAIN_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

bot.action('CB_CERTS_V2_EQUIP', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '🧾 *Сертификаты оборудования*\n\nЗдесь будут опубликованы сертификаты (PDF/фото).\n\nОборудование рассчитано на общественные места и ежедневное использование.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: 'CB_CERTS_V2_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

bot.action('CB_CERTS_V2_DOCS', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '📦 *Официальность поставок*\n\nМы работаем как ТОО в Казахстане.\nДокументы и подтверждения будем публиковать здесь по мере обновления.\n\nЦель — прозрачность и доверие.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: 'CB_CERTS_V2_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

bot.action('CB_CERTS_V2_WARN', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '⚠️ *Предупреждения и безопасность*\n\n• Возможна индивидуальная реакция\n• Не распылять в глаза/лицо\n• При аллергии лучше не использовать\n\nЕсли хотите оставить сообщение — зайдите в “Обратная связь”.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⬅️ Назад', callback_data: 'CB_CERTS_V2_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// === CERTS_V2_END ===


// === FEEDBACK_V2_START ===

const FEEDBACK_GIFT_COOLDOWN_DAYS = 7;
// FB_WRITE pending (in-memory fallback, no DB needed)
const FB_WRITE_TTL_MS = 30 * 60 * 1000;
const FB_WRITE_PENDING = new Map<number, number>();

const FEEDBACK_TEXT_COOLDOWN_HOURS = 6;

// feedback menu
bot.action('CB_FEEDBACK_V2_MENU', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '💬 *Обратная связь*\n\nВыберите действие:',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⭐ Оставить отзыв', callback_data: 'CB_FB_RATE' }],
          [{ text: '✍️ Написать нам', callback_data: 'CB_FB_WRITE' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// rate
bot.action('CB_FB_RATE', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    '⭐ *Оцените сервис:*',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '👍 Понравилось', callback_data: 'CB_FB_LIKE' }],
          [{ text: '😐 Нормально', callback_data: 'CB_FB_OK' }],
          [{ text: '👎 Не понравилось', callback_data: 'CB_FB_BAD' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_FEEDBACK_V2_MENU' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

async function fbSave(tg_user_id, device_id, rating, reason, message) {
  await q(
    `INSERT INTO feedback (tg_user_id, device_id, rating, reason, message, created_at)
     VALUES ($1,$2,$3,$4,$5, now())`,
    [tg_user_id, device_id, rating, reason, message]
  );
}

async function getUserDeviceId(tg_user_id) {
  const rows = await q('SELECT current_device_id FROM users WHERE tg_user_id=$1 LIMIT 1', [tg_user_id]);
  return rows?.[0]?.current_device_id || 'UNKNOWN';
}

// --- THANKS (auto follow-up) ---
const THANKS_DELAY_MINUTES = Number(process.env.THANKS_DELAY_MINUTES || 60);

async function markUserTouch(tg_user_id: number) {
  // если next_thanks_at уже стоит в будущем — не трогаем (не спамим)
  await q(
    `
    INSERT INTO user_touch (tg_user_id, last_touch_at, next_thanks_at)
    VALUES ($1, now(), now() + ($2 || ' minutes')::interval)
    ON CONFLICT (tg_user_id) DO UPDATE
      SET last_touch_at = now(),
          next_thanks_at = CASE
            WHEN user_touch.next_thanks_at IS NULL THEN now() + ($2 || ' minutes')::interval
            WHEN user_touch.next_thanks_at < now() THEN now() + ($2 || ' minutes')::interval
            ELSE user_touch.next_thanks_at
          END
    `,
    [tg_user_id, String(THANKS_DELAY_MINUTES)]
  );
}

async function processThanksQueue(bot: any) {
  try {
    const rows = await q(
      `
      WITH candidates AS (
        SELECT tg_user_id
        FROM user_touch
        WHERE next_thanks_at IS NOT NULL
          AND next_thanks_at <= now()
          AND (last_thanks_at IS NULL OR last_thanks_at <= now() - interval '24 hours')
          AND (thanks_locked_at IS NULL OR thanks_locked_at <= now() - interval '10 minutes')
        ORDER BY next_thanks_at ASC
        LIMIT 50
      )
      UPDATE user_touch ut
      SET thanks_locked_at = now()
      FROM candidates c
      WHERE ut.tg_user_id = c.tg_user_id
      RETURNING ut.tg_user_id
      `
    );

    for (const r of rows) {
      const uid = Number(r.tg_user_id);
      if (!uid) continue;

      const text =
        "Спасибо, что выбрали *П-Шик* 🙌\n\n" +
        "Мы очень дорожим репутацией и благодарим вас за доверие. " +
        "В наших аппаратах только оригинальный парфюм, подтверждённый сертификатами.\n\n" +
        "Если вдруг появятся вопросы или сомнения — напишите нам в боте через “Обратная связь”.\n\n" +
        "*Всё, что вам нужно — это П-Шик.*\n" +
        "Удачи вам и вашей семье 🤝";

      try {
        await bot.telegram.sendMessage(uid, text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: [[{ text: "🏠 Меню", callback_data: "CB_MAIN_MENU" }]] }
        });
      } catch (e) {
        // если юзер заблокировал/не доступен — не падаем, но обязательно снимаем лок
        await q(
          `UPDATE user_touch SET thanks_locked_at=NULL WHERE tg_user_id=$1`,
          [uid]
        );
        continue;
      }

      await q(
        `UPDATE user_touch
         SET last_thanks_at=now(),
             thanks_processed_at=now(),
             next_thanks_at=NULL,
             thanks_locked_at=NULL
         WHERE tg_user_id=$1`,
        [uid]
      );
    }
  } catch (e) {
      console.error('[THANKS] queue error', e);
  }
}
// --- /THANKS ---

// ================= USER_STATE (DB state manager) =================
async function setUserState(tg_user_id, state, payload = null) {
  await q(
    `INSERT INTO user_state (tg_user_id, state, payload, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (tg_user_id)
     DO UPDATE SET state = EXCLUDED.state, payload = EXCLUDED.payload, updated_at = now()`,
    [tg_user_id, state, payload]
  );
}

async function getUserState(tg_user_id) {
  const r = await q(
    `SELECT state, payload
     FROM user_state
     WHERE tg_user_id = $1
     LIMIT 1`,
    [tg_user_id]
  );
  if (!r || r.length === 0) return { state: "idle", payload: null };
  return { state: r[0].state || "idle", payload: r[0].payload ?? null };
}

async function clearUserState(tg_user_id) {
  await setUserState(tg_user_id, "idle", null);
}
// ===============================================================


// like -> save immediately (no reason)
bot.action('CB_FB_LIKE', async (ctx) => {


  try { await ctx.answerCbQuery(); } catch (_) {}
  const tg_user_id = ctx.from.id;
  const device_id = await getUserDeviceId(tg_user_id);
  await fbSave(tg_user_id, device_id, 'like', null, null);

  await ctx.editMessageText(
    'Спасибо за отзыв 🙌\n\nХотите подарок?',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎁 Получить подарок', callback_data: 'CB_FB_GIFT' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
});

// ok/bad -> ask reason
bot.action('CB_FB_OK', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    'Понял 🙌\n\nЧто именно?',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Сильный', callback_data: 'CB_FB_REASON_OK_STRONG' }],
          [{ text: 'Слабый', callback_data: 'CB_FB_REASON_OK_WEAK' }],
          [{ text: 'Не мой профиль', callback_data: 'CB_FB_REASON_OK_PROFILE' }],
          [{ text: 'Другое', callback_data: 'CB_FB_REASON_OK_OTHER' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_FB_RATE' }]
        ]
      }
    }
  );
});

bot.action('CB_FB_BAD', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  await ctx.editMessageText(
    'Жаль 😕\n\nЧто именно не понравилось?',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Сильный', callback_data: 'CB_FB_REASON_BAD_STRONG' }],
          [{ text: 'Слабый', callback_data: 'CB_FB_REASON_BAD_WEAK' }],
          [{ text: 'Не мой профиль', callback_data: 'CB_FB_REASON_BAD_PROFILE' }],
          [{ text: 'Другое', callback_data: 'CB_FB_REASON_BAD_OTHER' }],
          [{ text: '⬅️ Назад', callback_data: 'CB_FB_RATE' }]
        ]
      }
    }
  );
});

async function fbFinalizeWithReason(ctx, rating, reason) {
  const tg_user_id = ctx.from.id;
  const device_id = await getUserDeviceId(tg_user_id);
  await fbSave(tg_user_id, device_id, rating, reason, null);

  await ctx.editMessageText(
    'Спасибо, мы учтём 🙌\n\nХотите подарок?',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎁 Получить подарок', callback_data: 'CB_FB_GIFT' }],
          [{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]
        ]
      }
    }
  );
}

// OK reasons
bot.action('CB_FB_REASON_OK_STRONG', (ctx) => fbFinalizeWithReason(ctx, 'ok', 'strong'));
bot.action('CB_FB_REASON_OK_WEAK', (ctx) => fbFinalizeWithReason(ctx, 'ok', 'weak'));
bot.action('CB_FB_REASON_OK_PROFILE', (ctx) => fbFinalizeWithReason(ctx, 'ok', 'profile'));
bot.action('CB_FB_REASON_OK_OTHER', (ctx) => fbFinalizeWithReason(ctx, 'ok', 'other'));

// BAD reasons
bot.action('CB_FB_REASON_BAD_STRONG', (ctx) => fbFinalizeWithReason(ctx, 'dislike', 'strong'));
bot.action('CB_FB_REASON_BAD_WEAK', (ctx) => fbFinalizeWithReason(ctx, 'dislike', 'weak'));
bot.action('CB_FB_REASON_BAD_PROFILE', (ctx) => fbFinalizeWithReason(ctx, 'dislike', 'profile'));
bot.action('CB_FB_REASON_BAD_OTHER', (ctx) => fbFinalizeWithReason(ctx, 'dislike', 'other'));

// Gift with cooldown
bot.action('CB_FB_GIFT', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch (_) {}
  const tg_user_id = ctx.from.id;
  const device_id = await getUserDeviceId(tg_user_id);

  if (!device_id || device_id === 'UNKNOWN') {
    return ctx.editMessageText(
      '⚠️ Чтобы выдать подарок, отсканируйте QR на аппарате (привязка к локации).',
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]] } }
    );
  }

  // cooldown: 1 gift per X days (issued_reason='feedback')
  const rows = await q(
    `SELECT 1
     FROM credits
     WHERE tg_user_id=$1 AND issued_reason='feedback'
       AND created_at > now() - ($2 || ' days')::interval
     LIMIT 1`,
    [tg_user_id, String(FEEDBACK_GIFT_COOLDOWN_DAYS)]
  );

  if (rows && rows.length > 0) {
    return ctx.editMessageText(
      '🎁 Подарок уже выдавался недавно.\n\nПопробуйте позже 🙂',
      { reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]] } }
    );
  }

  // issue credit (uses existing helper)
  const { code, expires_at } = await issueCreditForUser(tg_user_id, device_id, 'feedback', 14);

  await ctx.editMessageText(
    `🎁 Ваш подарок готов!\n\n*Код:* \`${code}\`\nДействует до: *${expires_at.toISOString().slice(0,10)}*\n\nВведите код на аппарате.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]] }
    }
  );
});


// Write us (free text)
  bot.action('CB_FB_WRITE', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (_) {}
    await ctx.editMessageText(
      '✍️ Напишите сообщение (до 500 символов).\n\nМы читаем каждое и улучшаем качество.',
      { reply_markup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'CB_FEEDBACK_V2_MENU' }],[{ text: '🏠 Меню', callback_data: 'CB_MAIN_MENU' }]] } }
    );

    // waiting mode (in-memory)
    await setUserState(ctx.from.id, 'fb_write', null);
    FB_WRITE_PENDING.set(ctx.from.id, Date.now() + FB_WRITE_TTL_MS);

  });

// capture free text (best-effort)
bot.on('text', async (ctx, next) => {
  try {
      const tg_user_id = ctx.from.id;

      const pendingUntil = FB_WRITE_PENDING.get(tg_user_id) || 0;
      const pending = pendingUntil > Date.now();
      const st = pending ? { state: 'fb_write' } : await getUserState(tg_user_id);
        if (st?.state !== 'fb_write') return next();
      console.log('[FB_WRITE] text from', tg_user_id, 'pending=', pending, 'state=', st?.state, 'text=', ctx.message?.text);
      if (st && st.state !== 'fb_write') return next();



    const device_id = await getUserDeviceId(tg_user_id);
    const msg = String(ctx.message.text || '').slice(0, 500);
    await fbSave(tg_user_id, device_id, null, null, msg);
      FB_WRITE_PENDING.delete(tg_user_id);

      await clearUserState(tg_user_id);
    return await ctx.reply('Спасибо! Сообщение принято 🙌', { reply_markup: { inline_keyboard: [[{ text:'🏠 Меню', callback_data:'CB_MAIN_MENU' }]] } });
  } catch (e) {
    return next();
  }
});

// === FEEDBACK_V2_END ===
