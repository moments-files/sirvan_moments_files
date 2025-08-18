require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET = process.env.CHANNEL_ID; // -100… or @channel_username

// Derive a clickable link to the copied post when possible
function linkForChannelMessage(channelId, messageId) {
  if (!channelId || !messageId) return '';
  // public channel like @Moments_files
  if (String(channelId).startsWith('@')) {
    const username = String(channelId).slice(1);
    return `https://t.me/${username}/${messageId}`;
  }
  // private numeric id like -1001234567890 -> t.me/c/1234567890/42
  const m = String(channelId).match(/-100(\d+)/);
  if (m) return `https://t.me/c/${m[1]}/${messageId}`;
  return '';
}

// --- sessions to remember the last submission while we ask for IG handle ---
bot.use(session());

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
  ctx.reply(
    '👋 خوش آمدید!\n\nلطفاً ویدیوهای خود را با بالاترین کیفیت و ترجیحاً به صورت فایل ارسال کنید.'
  )
);

// Accept photos, videos, or documents (video/image)
bot.on(['video', 'photo', 'document'], async (ctx) => {
  try {
    const msg = ctx.message;

    const isPhoto = Boolean(msg.photo && msg.photo.length);
    const isVideo = Boolean(msg.video);
    const doc = msg.document;
    const mt = (doc && doc.mime_type) || '';
    const isMediaDoc = doc && (mt.startsWith('video/') || mt.startsWith('image/'));

    if (!(isPhoto || isVideo || isMediaDoc)) return;

    // Copy to your channel
    const copyRes = await ctx.copyMessage(TARGET); // { message_id }
    const channelMessageId = copyRes.message_id;

    // Remember this submission for IG tagging step
    ctx.session.lastSubmission = {
      channelMessageId,
      from: ctx.from,
      at: Date.now(),
    };

    await ctx.reply('✔️ دریافت شد');
    await askTag(ctx);
  } catch (err) {
    console.error('Copy error:', err);
    await ctx.reply('❌ مشکلی پیش آمد، دوباره تلاش کنید.');
  }
});

// Button: YES → ask for IG handle
bot.action('tag_yes', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaitingIg = true;
  await ctx.editMessageText('عالی! لطفاً آیدی اینستاگرام‌تان را ارسال کنید (مثال: @example).');
});

// Button: NO → log “no tag”
bot.action('tag_no', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaitingIg = false;
  await ctx.editMessageText('باشه، بدون تگ منتشر می‌شود. متشکرم 🙏');

  // Optional: note in channel next to the media
  const sub = ctx.session.lastSubmission;
  if (sub?.channelMessageId) {
    const link = linkForChannelMessage(TARGET, sub.channelMessageId);
    const from = ctx.from?.username ? '@' + ctx.from.username : ctx.from?.id;
    await ctx.telegram.sendMessage(
      TARGET,
      `ℹ️ ارسال بدون تگ از ${from}${link ? `\n🔗 ${link}` : ''}`
    );
  }
});

// If user sends text while we're waiting for IG handle, capture & validate it
bot.on('text', async (ctx) => {
  if (!ctx.session.awaitingIg) return;

  let handle = (ctx.message.text || '').trim();
  // Normalize common paste forms
  handle = handle
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/+$/g, '');
  if (!handle.startsWith('@')) handle = '@' + handle;

  // Basic IG handle validation
  const ok = /^@[A-Za-z0-9._]{1,30}$/.test(handle);
  if (!ok) {
    return ctx.reply('فرمت آیدی درست نیست. لطفاً چیزی مثل @example ارسال کنید.');
  }

  ctx.session.awaitingIg = false;
  await ctx.reply(`متشکرم! آیدی شما ثبت شد: ${handle}`);

  // Post a note in your channel, linked to the copied media
  const sub = ctx.session.lastSubmission;
  const link = sub?.channelMessageId ? linkForChannelMessage(TARGET, sub.channelMessageId) : '';
  const from = ctx.from?.username ? '@' + ctx.from.username : ctx.from?.id;

  await ctx.telegram.sendMessage(
    TARGET,
    `🔖 تگ اینستاگرام: ${handle}\n👤 تلگرام: ${from}${link ? `\n🔗 ${link}` : ''}`
  );
});

bot.launch().then(() => console.log('Bot running with IG-tag flow...'));
