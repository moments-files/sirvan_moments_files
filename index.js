require('dotenv').config();
const { Telegraf, Markup, session } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET = process.env.CHANNEL_ID;              // -100… or @channel_username
const CHANNEL_USERNAME = (''+TARGET).startsWith('@') ? (''+TARGET).slice(1) : null;

// Simple per-user memory (resets when the bot restarts)
bot.use(session());

function askTagQuestion(ctx) {
  return ctx.reply(
    'آیا مایلید در ریل/پست اینستاگرام تگ شوید؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('بله، تگم کن', 'tag_yes'),
       Markup.button.callback('نه، نیاز نیست', 'tag_no')]
    ])
  );
}

bot.start((ctx) => ctx.reply(
  '👋 خوش آمدید!\n\nلطفاً ویدیوهای خود را با بالاترین کیفیت و ترجیحاً به صورت فایل ارسال کنید.'
));

// Handle photos / videos / media documents
bot.on(['video', 'photo', 'document'], async (ctx) => {
  try {
    const msg = ctx.message;
    const isPhoto = Boolean(msg.photo && msg.photo.length);
    const isVideo = Boolean(msg.video);
    const doc = msg.document;
    const mt = (doc && doc.mime_type) || '';
    const isMediaDoc = doc && (mt.startsWith('video/') || mt.startsWith('image/'));
    if (!(isPhoto || isVideo || isMediaDoc)) return;

    // Copy media to your channel and remember the new message_id there
    const copyRes = await ctx.copyMessage(TARGET);  // returns { message_id }
    const channelMessageId = copyRes.message_id;

    // Save context for this user so we can tie the IG handle to this media
    ctx.session.lastSubmission = { channelMessageId, ts: Date.now() };

    // Thank them & ask about tagging
    await ctx.reply('✔️ دریافت شد');
    await askTagQuestion(ctx);

  } catch (err) {
    console.error('Copy error:', err);
    await ctx.reply('❌ مشکلی پیش آمد، دوباره تلاش کنید.');
  }
});

// User tapped "Yes"
bot.action('tag_yes', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaitingIg = true;
  return ctx.editMessageText(
    'عالی! لطفاً آیدی اینستاگرام‌تان را تایپ کنید (مثلاً @example).'
  );
});

// User tapped "No"
bot.action('tag_no', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.awaitingIg = false;
  await ctx.editMessageText('باشه، بدون تگ منتشر می‌شود. متشکرم 🙏');

  // (optional) log a small note next to the media in your channel
  const sub = ctx.session.lastSubmission;
  if (sub?.channelMessageId) {
    const link = CHANNEL_USERNAME ? `https://t.me/${CHANNEL_USERNAME}/${sub.channelMessageId}` : '';
    await ctx.telegram.sendMessage(
      TARGET,
      `ℹ️ ارسال بدون تگ از ${ctx.from.username ? '@'+ctx.from.username : ctx.from.id}${link ? `\n🔗 ${link}` : ''}`
    );
  }
});

// Capture the IG handle text
bot.on('text', async (ctx) => {
  if (!ctx.session.awaitingIg) return;

  let handle = (ctx.message.text || '').trim();
  // Normalize and validate
  if (handle.startsWith('https://www.instagram.com/')) handle = handle.replace('https://www.instagram.com/','');
  if (handle.startsWith('https://instagram.com/')) handle = handle.replace('https://instagram.com/','');
  handle = handle.replace(/\/+$/,''); // drop trailing slash
  if (!handle.startsWith('@')) handle = '@' + handle;

  const ok = /^@[A-Za-z0-9._]{1,30}$/.test(handle);
  if (!ok) {
    return ctx.reply('فرمت آیدی صحیح نیست. لطفاً چیزی مثل @example بفرستید.');
  }

  ctx.session.awaitingIg = false;

  // Confirm to the user
  await ctx.reply(`متشکرم! آیدی شما ثبت شد: ${handle}`);

  // Post a note in your channel linking the media & IG handle
  const sub = ctx.session.lastSubmission;
  const link = (CHANNEL_USERNAME && sub?.channelMessageId)
    ? `\n🔗 https://t.me/${CHANNEL_USERNAME}/${sub.channelMessageId}`
    : '';

  await ctx.telegram.sendMessage(
    TARGET,
    `🔖 تگ اینستاگرام: ${handle}\n👤 تلگرام: ${ctx.from.username ? '@'+ctx.from.username : ctx.from.id}${link}`
  );
});

bot.launch().then(() => console.log('Bot running with IG-tag flow...'));
