require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

/* ================= CACHE ================= */
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

/* ================= FAST API ================= */
async function fastApi(url) {
  const now = Date.now();

  if (CACHE.has(url)) {
    const { time, data } = CACHE.get(url);
    if (now - time < CACHE_TTL) return data;
    CACHE.delete(url);
  }

  try {
    const res = await axios.get(url, { timeout: 5000 });
    CACHE.set(url, { time: now, data: res });
    return res;
  } catch {
    const proxyUrl = `${process.env.PROXY_API_URL}${encodeURIComponent(url)}`;
    const res = await axios.get(proxyUrl, { timeout: 8000 });
    CACHE.set(url, { time: now, data: res });
    return res;
  }
}

/* ================= HELPERS ================= */
function hasMovieKeyword(text) {
  return /movie|film/i.test(text);
}

function hasTvKeyword(text) {
  return /tv|series|show/i.test(text);
}

function cleanQuery(text) {
  return text
    .replace(/movie|film|tv|series|show|link|watch|download/gi, '')
    .trim();
}

/* ================= SKELETON ================= */
async function showSkeleton(chatId) {
  const msg = await bot.sendMessage(
    chatId,
`🎬 *Loading...*

▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
▓▓▓▓▓▓▓▓▓▓▓▓▓▓
▓▓▓▓▓▓▓▓▓▓▓▓`,
    { parse_mode: 'Markdown' }
  );

  return {
    remove: async () =>
      bot.deleteMessage(chatId, msg.message_id).catch(() => {})
  };
}

/* ================= START ================= */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
`🎬 *CINEFLOW BOT*

Type movie or TV name directly:
• rrr
• dark
• squid

Use keywords if needed:
• rrr movie
• dark tv`,
    { parse_mode: 'Markdown' }
  );
});

/* ================= SEARCH ================= */
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;

  const chatId = msg.chat.id;
  const rawText = msg.text.trim();
  const query = cleanQuery(rawText);

  if (!query) {
    return bot.sendMessage(chatId, '❌ Please enter a movie or TV name');
  }

  // Decide endpoint
  let endpoint = 'multi';
  if (hasMovieKeyword(rawText) && !hasTvKeyword(rawText)) endpoint = 'movie';
  if (hasTvKeyword(rawText) && !hasMovieKeyword(rawText)) endpoint = 'tv';

  let res;
  try {
    res = await fastApi(
      `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(
        query
      )}&api_key=${process.env.TMDB_API_KEY}`
    );
  } catch {
    return bot.sendMessage(chatId, '⚠️ TMDB busy, try again');
  }

  if (!res.data?.results?.length) {
    return bot.sendMessage(
      chatId,
      `❌ *No results found*\n\nTry Google 👇`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            {
              text: '🔍 Search on Google',
              url: `https://www.google.com/search?q=${encodeURIComponent(rawText)}`
            }
          ]]
        }
      }
    );
  }

  const buttons = res.data.results
    .filter(r => r.media_type !== 'person')
    .slice(0, 10)
    .map(r => {
      const type = r.media_type || endpoint;
      const year =
        type === 'movie'
          ? r.release_date?.slice(0, 4)
          : r.first_air_date?.slice(0, 4);

      return [{
        text: `${type === 'movie' ? '🎬' : '📺'} ${r.title || r.name} (${year || 'N/A'})`,
        callback_data: `select_${type}_${r.id}`
      }];
    });

  bot.sendMessage(chatId, `🔍 Results for *${query}*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
});

/* ================= SELECT ================= */
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  if (!data.startsWith('select_')) return;

  const [, type, id] = data.split('_');

  await bot.answerCallbackQuery(q.id, { text: 'Loading...' });
  const skeleton = await showSkeleton(chatId);

  let res;
  try {
    res = await fastApi(
      `https://api.themoviedb.org/3/${type}/${id}?api_key=${process.env.TMDB_API_KEY}`
    );
  } catch {
    await skeleton.remove();
    return bot.sendMessage(chatId, '⚠️ Failed to load details');
  }

  await skeleton.remove();
  const m = res.data;

  bot.sendPhoto(
    chatId,
    `https://image.tmdb.org/t/p/w500${m.poster_path}`,
    {
      caption:
`🎬 *${m.title || m.name}* (${(m.release_date || m.first_air_date || '').slice(0,4)})
⭐ ${m.vote_average}

${m.overview}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          {
            text: '▶️ Watch 1',
            url: `https://cineflow1.vercel.app/${type}/${id}`
          },
          {
            text: '▶️ Watch 2',
            url: `https://cineflow-rose.vercel.app/${type}/${id}`
          },
          {
            text: '📩 download',
            url: `https://cineflow1.vercel.app/download/${type}/${id}`
          }
        ]]
      }
    }
  );
});
