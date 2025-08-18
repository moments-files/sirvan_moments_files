require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET = process.env.CHANNEL_ID; // -100… or @channel_username

// ---- tiny in-memory store per user ----
// userId -> { awaitingIg?:boolean, pending?:{ fromChatId:number, msgId:number }, lastCopyId?:number }
const store = new Map();
const getState = (ctx) => {
  const uid = ctx.from?.id;
  if (!uid) return null;
  if (!store.has(uid)) store.set(uid, {});
  return store.get(uid);
};
const setState = (ctx, patch) => {
  const st = getState(ctx);
  if (!st) return;
  Object.assign(st, patch);
  store.set(ctx.from.id, st);
};

// LTR helpers for RTL contexts
const LRI = '\u2066'; // LEFT-TO-RIGHT ISOLATE
const PDI = '\u2069'; // POP DIRECTIONAL ISOLATE
const ltr = (s) => `${LRI}${s}${PDI}`;
const ZWSP = '\u200B'; // zero-width space

// Build public link to a copied message in channel
function linkForChannelMessage(channelId, messageId) {
  if (!channelId || !messageId) return '';
  const s = String(channelId);
  if (s.startsWith('@')) return `https://t.me/${s.slice(1)}/${messageId}`; // public channel
  const m = s.match(/-100(\d+)/);                                          // private channel
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
// IMPORTANT: we DO NOT copy to channel yet — we store msg id and ask tagging first
bot.on(['video', 'photo', 'document'], async (ctx) => {
  const msg = ctx.message;
  const isPhoto = Boolean(msg.photo && msg.photo.length);
  const isVideo = Boolean(msg.video);
  const doc = msg.document;
  const mt = (doc && doc.mime_type) || '';
  const isMediaDoc = doc && (mt.startsWith('video/') || mt.startsWith('image/'));
  if (!(isPhoto || isVideo || isMediaDoc)) return;

  // remember original message so we can copy later if valid
  setState(ctx, {
    pending: { fromChatId: ctx.chat.id, msgId: msg.message_id },
    awaitingIg: false
  });

  try { await ctx.reply('✔️ دریافت شد'); } catch (e) { /* non-fatal */ }
  try { await askTag(ctx); } catch (e) { /* non-fatal */ }
});

// If user chooses NO → copy media now, log note, done
bot.action('tag_no', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  setState(ctx, { awaitingIg: false });

  try { await ctx.editMessageText('باشه، بدون تگ منتشر می‌شود. متشکرم 🙏'); }
  catch { await ctx.reply('باشه، بدون تگ منتشر می‌شود. متشکرم 🙏'); }

  const st = getState(ctx);
  const pending = st?.pending;
  if (pending) {
    try {
      // copy original message from the user chat to your channel
      const copy = await ctx.telegram.copyMessage(TARGET, pending.fromChatId, pending.msgId);
      setState(ctx, { lastCopyId: copy.message_id, pending: null });
      // optional channel note
      const fromRaw = ctx.from?.username ? '@' + ctx.from.username : String(ctx.from?.id || '');
      const noteFrom = ltr(fromRaw);
      const link = linkForChannelMessage(TARGET, copy.message_id);
      await ctx.telegram.sendMessage(
        TARGET,
        `ℹ️ ارسال بدون تگ از ${noteFrom}${link ? `\n🔗 ${link}` : ''}`
      );
    } catch (e) {
      console.warn('copy on NO failed:', e.message);
      await ctx.reply('❌ مشکلی پیش آمد، دوباره تلاش کنید.');
    }
  }
});

// If user chooses YES → ask for IG handle
bot.action('tag_yes', async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  setState(ctx, { awaitingIg: true });
  const prompt = 'عالی! لطفاً آیدی اینستاگرام‌تان را ارسال کنید (مثال: ' + ltr('@example') + ').';
  try { await ctx.editMessageText(prompt); }
  catch { await ctx.reply(prompt); }
});

// Handle IG text
bot.on('text', async (ctx) => {
  const st = getState(ctx);
  if (!st?.awaitingIg) return;

  let handle = (ctx.message.text || '').trim();
  handle = handle.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/+$/g, '');
  if (!handle.startsWith('@')) handle = '@' + handle;

  const valid = /^@[A-Za-z0-9._]{1,20}$/.test(handle);

  if (!valid) {
    // SHADOW-DROP: pretend okay, but don't copy to channel; show a visually-normal (obfuscated) handle
    const fake = '@' + ZWSP + handle.slice(1); // inject zero-width space after @
    try { await ctx.reply(`متشکرم! آیدی شما ثبت شد: ${ltr(fake)}`); } catch {}
    // clear pending so nothing gets forwarded
    setState(ctx, { awaitingIg: false, pending: null });
    return;
  }

  // Valid handle → copy to channel now, then log tag note
  setState(ctx, { awaitingIg: false });
  const pending = getState(ctx)?.pending;

  try { await ctx.reply(`متشکرم! آیدی شما ثبت شد: ${ltr(handle)}`); } catch {}

  if (pending) {
    try {
      const copy = await ctx.telegram.copyMessage(TARGET, pending.fromChatId, pending.msgId);
      setState(ctx, { lastCopyId: copy.message_id, pending: null });
      const link = linkForChannelMessage(TARGET, copy.message_id);
      const fromRaw = ctx.from?.username ? '@' + ctx.from.username : String(ctx.from?.id || '');
      const from = ltr(fromRaw);
      await ctx.telegram.sendMessage(
        TARGET,
        `🔖 تگ اینستاگرام: ${ltr(handle)}\n👤 تلگرام: ${from}${link ? `\n🔗 ${link}` : ''}`
      );
    } catch (e) {
      console.warn('copy/log on VALID failed:', e.message);
      await ctx.reply('❌ مشکلی پیش آمد، دوباره تلاش کنید.');
    }
  }
});

// Errors + graceful stop
bot.catch((err) => console.error('Bot error:', err));
bot.launch().then(() => console.log('Bot running… (single instance expected)'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
