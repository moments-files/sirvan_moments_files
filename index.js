require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET = process.env.CHANNEL_ID; // -100… or @channel_username

// ---- tiny in-memory store per user (no telegraf/session) ----
const store = new Map(); // userId -> { awaitingIg?:boolean, lastSubmission?:{channelMessageId, at:number} }

function getState(ctx) {
  const uid = ctx.from?.id;
  if (!uid) return null;
  if (!store.has(uid)) store.set(uid, {});
  return store.get(uid);
}
function setState(ctx, patch) {
  const st = getState(ctx);
  if (!st) return;
  Object.assign(st, patch);
  store.set(ctx.from.id, st);
}

// Build a public link to the copied message in channel
function linkForChannelMessage(channelId, messageId) {
  if (!channelId || !messageId) return '';
  const s = String(channelId);
  if (s.startsWith('@')) return `https://t.me/${s.slice(1)}/${messageId}`;        // public channel
  const m = s.match(/-100(\d+)/);                                                 // private channel
  return m ? `https://t.me/c/${m[1]}/${messageId}` : '';
}

const askTag = (ctx) =>
  ctx.reply(
    'آیا مایلید در ریل/پست اینستاگرام تگ شوید؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('بله، تگم کن', 'tag_yes'),
       Markup.button.callback('نه، لازم نیست', 'tag_no')],
    ])
  );

// Greeting
bot.start((ctx) =>
  ctx.reply('👋 خوش آمدید!\n\nلطفاً ویدیوهای خود را با بالاترین کیفیت و ترجیحاً به صورت فایل ارسال کنید.')
);

// Handle media (photos, videos, or image/video documents)
bot.on(['video', 'photo', 'document'], async (ctx) => {
  const msg = ctx.message;
  const isPhoto = Boolean(msg.photo && msg.photo.length);
  const isVideo = Boolean(msg.video);
  const doc = msg.document;
  const mt = (doc && doc.mime_type) || '';
  const isMediaDoc = doc && (mt.startsWith('video/') || mt.startsWith('image/'));
  if (!(isPhoto || isVideo || isMediaDoc)) return;

  // 1) Copy to channel (critical step)
  let channelMessageId = null;
  try {
    const res = await ctx.copyMessage(TARGET); // { message_id }
    channelMessageId = res.message_id;
  } catch (err) {
    console.error('COPY FAILED:', err);
    // typical reasons: wrong CHANNEL_ID, bot not admin
    await ctx.reply('❌ مشکلی پیش آمد، دوباره تلاش کنید.');
    return;
  }

  // 2) Remember last submission for IG tagging
  setState(ctx, { lastSubmission: { channelMessageId, at: Date.now() }, awaitingIg: false });

  // 3) Acknowledge + ask tagging (non-fatal if these fail)
  try { await ctx.reply('✔️ دریافت شد'); } catch (e) { console.warn('ack failed:', e.message); }
  try { await askTag(ctx); } catch (e) { console.warn('ask failed:', e.message); }
});

// YES → ask for IG handle
bot.action('tag_yes', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  setState(ctx, { awaitingIg: true });
  try {
    await ctx.editMessageText('عالی! لطفاً آیدی اینستاگرام‌تان را ارسال کنید (مثال: @example).');
  } catch (e) {
    console.warn('editMessageText failed; sending new message:', e.message);
    await ctx.reply('عالی! لطفاً آیدی اینستاگرام‌تان را ارسال کنید (مثال: @example).');
  }
});

// NO → log a small note in channel
bot.action('tag_no', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  setState(ctx, { awaitingIg: false });

  try { await ctx.editMessageText('باشه، بدون تگ منتشر می‌شود. متشکرم 🙏'); }
  catch (e) { console.warn('edit failed:', e.message); await ctx.reply('باشه، بدون تگ منتشر می‌شود. متشکرم 🙏'); }

  const st = getState(ctx);
  const sub = st?.lastSubmission;
  if (sub?.channelMessageId) {
    const link = linkForChannelMessage(TARGET, sub.channelMessageId);
    const from = ctx.from?.username ? '@' + ctx.from.username : ctx.from?.id;
    try {
      await ctx.telegram.sendMessage(TARGET, `ℹ️ ارسال بدون تگ از ${from}${link ? `\n🔗 ${link}` : ''}`);
    } catch (e) {
      console.warn('channel note failed (non-fatal):', e.message);
    }
  }
});

// Capture IG handle
bot.on('text', async (ctx) => {
  const st = getState(ctx);
  if (!st?.awaitingIg) return;

  let handle = (ctx.message.text || '').trim();
  handle = handle.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/+$/g, '');
  if (!handle.startsWith('@')) handle = '@' + handle;

  const ok = /^@[A-Za-z0-9._]{1,30}$/.test(handle);
  if (!ok) return ctx.reply('فرمت آیدی درست نیست. لطفاً چیزی مثل @example ارسال کنید.');

  setState(ctx, { awaitingIg: false });

  try { await ctx.reply(`متشکرم! آیدی شما ثبت شد: ${handle}`); } catch {}

  const sub = getState(ctx)?.lastSubmission;
  const link = sub?.channelMessageId ? linkForChannelMessage(TARGET, sub.channelMessageId) : '';
  const from = ctx.from?.username ? '@' + ctx.from.username : ctx.from?.id;

  try {
    await ctx.telegram.sendMessage(
      TARGET,
      `🔖 تگ اینستاگرام: ${handle}\n👤 تلگرام: ${from}${link ? `\n🔗 ${link}` : ''}`
    );
  } catch (e) {
    console.warn('channel IG note failed (non-fatal):', e.message);
  }
});

// Helpful logs + graceful stop
bot.catch((err, ctx) => console.error('Bot error:', err));
bot.launch().then(() => console.log('Bot running… (single instance expected)'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
