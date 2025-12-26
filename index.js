require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET = process.env.CHANNEL_ID; // -100… or @channel_username

// ---------- tiny in-memory store ----------
/*
state per user:
{
  pending: { fromChatId, msgId },
  step: 'city' | 'date' | 'tag' | null,
  city: string|null,
  dateISO: string|null,
  awaitingIg: boolean,
  shadowDrop: boolean   // NEW: true if city >15 chars (we won't forward)
}
*/
const store = new Map();
const getState = (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return null;
  if (!store.has(uid)) store.set(uid, {});
  return store.get(uid);
};
const setState = (ctx, patch) => {
  const s = getState(ctx);
  if (!s) return;
  Object.assign(s, patch);
  store.set(ctx.from.id, s);
};
const clearState = (ctx) => { if (ctx.from?.id) store.delete(ctx.from.id); };

// LTR helpers (for @ display)
const LRI = '\u2066', PDI = '\u2069';
const ltr = (s) => `${LRI}${s}${PDI}`;

// Link builder for channel messages
function linkForChannelMessage(channelId, messageId) {
  if (!channelId || !messageId) return '';
  const s = String(channelId);
  if (s.startsWith('@')) return `https://t.me/${s.slice(1)}/${messageId}`;
  const m = s.match(/-100(\d+)/);
  return m ? `https://t.me/c/${m[1]}/${messageId}` : '';
}

// --- parsing flexible dates ---
function pad(n){return n<10?`0${n}`:`${n}`;}
function toISO(y,m,d){return `${y}-${pad(m)}-${pad(d)}`;}
function isValidYMD(y,m,d){
  if(!y||!m||!d) return false;
  const dt = new Date(y, m-1, d);
  return dt.getFullYear()===y && (dt.getMonth()+1)===m && dt.getDate()===d;
}
function parseDateToISO(text){
  const t = (text||'').trim();
  let m;
  if ((m = t.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/))) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (isValidYMD(y,mo,d)) return toISO(y,mo,d);
  }
  if ((m = t.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/))) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (isValidYMD(y,mo,d)) return toISO(y,mo,d);
  }
  return null;
}

// --- UI helpers ---
const askCity = (ctx) =>
  ctx.reply(
    'این ویدیو مربوط به کدام شهر است؟ (می‌توانید رد کنید)',
    Markup.inlineKeyboard([[Markup.button.callback('رد کردن شهر', 'skip_city')]])
  );

const askDate = (ctx) =>
  ctx.reply(
    'تاریخ اجرا را بفرمایید (مثال: 2025-08-18 یا 18/08/2025). (می‌توانید رد کنید)',
    Markup.inlineKeyboard([[Markup.button.callback('رد کردن تاریخ', 'skip_date')]])
  );

const askTag = (ctx) =>
  ctx.reply(
    'آیا مایلید در ریل/پست اینستاگرام تگ شوید؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('بله، تگم کن', 'tag_yes'),
       Markup.button.callback('نه، لازم نیست', 'tag_no')],
    ])
  );

// --- flow helpers ---
async function maybeForward(ctx, extraNoteLines=[]) {
  const st = getState(ctx);
  const pending = st?.pending;
  if (!pending) return;

  // If shadowDrop flagged (city too long), do NOT forward
  if (st?.shadowDrop) {
    setState(ctx, { pending: null, step: null, city: null, dateISO: null, awaitingIg: false, shadowDrop: false });
    return;
  }

  try {
    const copy = await ctx.telegram.copyMessage(TARGET, pending.fromChatId, pending.msgId);
    const link = linkForChannelMessage(TARGET, copy.message_id);

    const cityLine = st?.city ? `🏙️ شهر: ${st.city}` : '';
    const dateLine = st?.dateISO ? `📅 تاریخ: ${st.dateISO}` : '';

    const noteLines = [cityLine, dateLine, ...extraNoteLines].filter(Boolean);
    if (noteLines.length) {
      await ctx.telegram.sendMessage(TARGET, noteLines.join('\n') + (link ? `\n🔗 ${link}` : ''));
    }

    setState(ctx, { pending: null, step: null, city: null, dateISO: null, awaitingIg: false, shadowDrop: false });
  } catch (e) {
    console.warn('forward failed:', e.message);
    await ctx.reply('❌ مشکلی پیش آمد، دوباره تلاش کنید.');
  }
}

// ----------------- Commands -----------------
bot.start((ctx) =>
  ctx.reply('👋 خوش آمدید!\n\nلطفاً ویدیوهای خود را با بالاترین کیفیت و ترجیحاً به صورت فایل ارسال کنید.')
);

bot.command('cancel', (ctx) => {
  clearState(ctx);
  ctx.reply('فرایند لغو شد. می‌توانید دوباره ویدیو ارسال کنید.');
});

// ----------------- Media intake -----------------
bot.on(['video', 'photo', 'document'], async (ctx) => {
  console.log('ABUSE_CHECK:', ctx.from?.id, ctx.from?.username);
  const msg = ctx.message;
  const isPhoto = Boolean(msg.photo && msg.photo.length);
  const isVideo = Boolean(msg.video);
  const doc = msg.document;
  const mt = (doc && doc.mime_type) || '';
  const isMediaDoc = doc && (mt.startsWith('video/') || mt.startsWith('image/'));
  if (!(isPhoto || isVideo || isMediaDoc)) return;

  setState(ctx, {
    pending: { fromChatId: ctx.chat.id, msgId: msg.message_id },
    step: 'city',
    city: null,
    dateISO: null,
    awaitingIg: false,
    shadowDrop: false
  });

  try { await ctx.reply('✔️ دریافت شد'); } catch {}
  try { await askCity(ctx); } catch {}
});

// ----------------- City -----------------
bot.action('skip_city', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  setState(ctx, { city: null, step: 'date' });
  try { await askDate(ctx); } catch { await ctx.reply('تاریخ اجرا را بفرمایید (YYYY-MM-DD).'); }
});

bot.on('text', async (ctx, next) => {
  const st = getState(ctx);
  if (!st?.step && !st?.awaitingIg) return; // not in flow

  // City step
  if (st.step === 'city') {
    const cityInput = (ctx.message.text || '').trim();
    if (cityInput.length > 15) {
      // shadow drop
      setState(ctx, { city: null, step: 'date', shadowDrop: true });
    } else {
      setState(ctx, { city: cityInput, step: 'date' });
    }
    try { await askDate(ctx); } catch {}
    return;
  }

  // Date step
  if (st.step === 'date') {
    const text = (ctx.message.text || '').trim();
    const parsed = parseDateToISO(text);
    setState(ctx, { dateISO: parsed, step: null });
    try { await askTag(ctx); } catch {}
    return;
  }

  // IG handle step
  if (st.awaitingIg) {
    let handle = (ctx.message.text || '').trim();
    handle = handle.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/+$/g, '');
    if (!handle.startsWith('@')) handle = '@' + handle;

    const valid = /^@[A-Za-z0-9._]{1,20}$/.test(handle);
    await ctx.reply('متشکرم! اطلاعات شما با موفقیت ثبت شد 🙏');

    if (!valid) {
      setState(ctx, { awaitingIg: false, pending: null });
      return;
    }

    setState(ctx, { awaitingIg: false });
    const extraLines = [`🔖 تگ اینستاگرام: ${ltr(handle)}`];
    await maybeForward(ctx, extraLines);
    return;
  }

  return next();
});

// ----------------- Date skip -----------------
bot.action('skip_date', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  setState(ctx, { dateISO: null, step: null });
  try { await askTag(ctx); } catch { await ctx.reply('آیا مایلید در ریل/پست اینستاگرام تگ شوید؟'); }
});

// ----------------- Tag actions -----------------
bot.action('tag_no', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  setState(ctx, { awaitingIg: false });

  await ctx.reply('متشکرم! اطلاعات شما با موفقیت ثبت شد 🙏');
  await maybeForward(ctx);
});

bot.action('tag_yes', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  setState(ctx, { awaitingIg: true });
  const prompt = 'عالی! لطفاً آیدی اینستاگرام‌تان را ارسال کنید (مثال: ' + ltr('@example') + ').';
  try { await ctx.reply(prompt); } catch {}
});

// ---- Launch bot ----
bot.launch().then(() => console.log('Bot running…'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
