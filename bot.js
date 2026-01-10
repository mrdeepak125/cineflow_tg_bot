require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

app.get('/', (req, res) => res.send('Cineflow Bot is running!'));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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

/* ================= SEARCH SESSION MANAGEMENT ================= */
// Store user search sessions
const userSessions = new Map();

function createSearchSession(chatId, query, endpoint, page = 1, totalResults = 0, results = []) {
  const session = {
    query,
    endpoint,
    page,
    totalResults,
    results,
    messageId: null,
    lastUpdate: Date.now()
  };
  
  // Clean up old sessions
  const sessionKey = `${chatId}`;
  userSessions.set(sessionKey, session);
  
  // Auto-cleanup after 10 minutes
  setTimeout(() => {
    if (userSessions.get(sessionKey)?.lastUpdate === session.lastUpdate) {
      userSessions.delete(sessionKey);
    }
  }, 10 * 60 * 1000);
  
  return session;
}

function getSearchSession(chatId) {
  return userSessions.get(`${chatId}`);
}

function updateSearchSession(chatId, updates) {
  const sessionKey = `${chatId}`;
  const session = userSessions.get(sessionKey);
  if (session) {
    Object.assign(session, updates, { lastUpdate: Date.now() });
    userSessions.set(sessionKey, session);
  }
}

function deleteSearchSession(chatId) {
  userSessions.delete(`${chatId}`);
}

/* ================= START ================= */
bot.onText(/\/start/, (msg) => {
  // Clear any existing session
  deleteSearchSession(msg.chat.id);
  
  bot.sendMessage(
    msg.chat.id,
`🎬 *CINEFLOW BOT*

Type movie or TV name directly:
• rrr
• dark
• squid

Use keywords if needed:
• rrr movie
• dark tv

📌 *Note:* Bot messages auto-delete after selection`,
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

  // Clear previous session
  deleteSearchSession(chatId);

  // Decide endpoint
  let endpoint = 'multi';
  if (hasMovieKeyword(rawText) && !hasTvKeyword(rawText)) endpoint = 'movie';
  if (hasTvKeyword(rawText) && !hasMovieKeyword(rawText)) endpoint = 'tv';

  let res;
  try {
    res = await fastApi(
      `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(
        query
      )}&api_key=${process.env.TMDB_API_KEY}&page=1`
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

  // Filter out person results
  const validResults = res.data.results
    .filter(r => r.media_type !== 'person')
    .slice(0, 10);

  // Create search session
  const session = createSearchSession(
    chatId,
    query,
    endpoint,
    1,
    res.data.total_results,
    validResults
  );

  // Create keyboard with results
  const buttons = validResults.map(r => {
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

  // Add pagination if there are more results
  const totalPages = Math.min(Math.ceil(res.data.total_results / 10), 5); // Max 5 pages
  const paginationButtons = [];
  
  if (totalPages > 1) {
    paginationButtons.push({
      text: '➡️ Next',
      callback_data: `page_${endpoint}_${query}_2`
    });
  }

  if (paginationButtons.length > 0) {
    buttons.push(paginationButtons);
  }

  // Add cancel button
  buttons.push([{
    text: '❌ Cancel Search',
    callback_data: 'cancel_search'
  }]);

  // Send the search results message
  const message = await bot.sendMessage(chatId, `🔍 Results for *${query}* (Page 1/${totalPages})`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });

  // Store the bot message ID
  updateSearchSession(chatId, { messageId: message.message_id });
});

/* ================= PAGINATION ================= */
bot.on('callback_query', async (q) => {
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;
  const data = q.data;

  // Handle search cancellation
  if (data === 'cancel_search') {
    await bot.deleteMessage(chatId, messageId).catch(() => {});
    deleteSearchSession(chatId);
    await bot.answerCallbackQuery(q.id, { text: 'Search cancelled' });
    return;
  }

  // Handle pagination
  if (data.startsWith('page_')) {
    await bot.answerCallbackQuery(q.id, { text: 'Loading more results...' });
    
    const [, endpoint, query, pageStr] = data.split('_');
    const page = parseInt(pageStr);
    
    try {
      const res = await fastApi(
        `https://api.themoviedb.org/3/search/${endpoint}?query=${encodeURIComponent(
          query
        )}&api_key=${process.env.TMDB_API_KEY}&page=${page}`
      );

      if (!res.data?.results?.length) {
        await bot.answerCallbackQuery(q.id, { text: 'No more results', show_alert: true });
        return;
      }

      // Filter out person results
      const validResults = res.data.results
        .filter(r => r.media_type !== 'person')
        .slice(0, 10);

      // Create keyboard with results
      const buttons = validResults.map(r => {
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

      // Add pagination buttons
      const totalPages = Math.min(Math.ceil(res.data.total_results / 10), 5);
      const paginationButtons = [];
      
      if (page > 1) {
        paginationButtons.push({
          text: '⬅️ Previous',
          callback_data: `page_${endpoint}_${query}_${page - 1}`
        });
      }
      
      if (page < totalPages) {
        paginationButtons.push({
          text: '➡️ Next',
          callback_data: `page_${endpoint}_${query}_${page + 1}`
        });
      }

      if (paginationButtons.length > 0) {
        buttons.push(paginationButtons);
      }

      // Add cancel button
      buttons.push([{
        text: '❌ Cancel Search',
        callback_data: 'cancel_search'
      }]);

      // Edit the existing message
      await bot.editMessageText(
        `🔍 Results for *${query}* (Page ${page}/${totalPages})`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        }
      );

    } catch (error) {
      await bot.answerCallbackQuery(q.id, { text: 'Failed to load more results', show_alert: true });
    }
    return;
  }

  // Handle movie/TV selection
  if (data.startsWith('select_')) {
    await bot.answerCallbackQuery(q.id, { text: 'Loading details...' });
    
    const [, type, id] = data.split('_');
    const skeleton = await showSkeleton(chatId);

    // Delete the search results message
    await bot.deleteMessage(chatId, messageId).catch(() => {});
    
    // Clear the search session
    deleteSearchSession(chatId);

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

    // Send the details message (this won't auto-delete)
    await bot.sendPhoto(
      chatId,
      `https://image.tmdb.org/t/p/w500${m.poster_path || '/q6y0Go1tsGEsmtFryDOJo3dEmqu.jpg'}`,
      {
        caption:
`🎬 *${m.title || m.name}* (${(m.release_date || m.first_air_date || '').slice(0,4)})
⭐ ${m.vote_average?.toFixed(1) || 'N/A'}

${m.overview || 'No description available.'}`,
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
              text: '📥 Download',
              url: `https://cineflow1.vercel.app/download/${type}/${id}`
            }
          ]]
        }
      }
    );
  }
});

/* ================= CLEANUP OLD SESSIONS ================= */
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of userSessions.entries()) {
    if (now - session.lastUpdate > 10 * 60 * 1000) {
      userSessions.delete(key);
    }
  }
}, 60 * 1000); // Cleanup every minute