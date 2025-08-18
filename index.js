require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const TARGET = process.env.CHANNEL_ID; // -100… or @your_channel_username

// Custom greeting message when someone taps Start
bot.start((ctx) => ctx.reply(
  "👋 خوش آمدید!\n\nلطفاً ویدیوهای خود را با بالاترین کیفیت و ترجیحاً به صورت فایل ارسال کنید."
));

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

    await ctx.copyMessage(TARGET);  // copy to your channel
    await ctx.reply('✔️ دریافت شد');
  } catch (err) {
    console.error(err);
    await ctx.reply('❌ مشکلی پیش آمد، دوباره تلاش کنید.');
  }
});

bot.launch().then(() => console.log('Bot running...'));
