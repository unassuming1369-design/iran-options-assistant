'use strict';

const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.PORT || 10000);
const TSETMC_URL = 'https://cdn.tsetmc.com/api/Instrument/GetInstrumentOptionMarketWatch/1';
const STARTED_AT = new Date();

let lastFetchAt = null;
let lastFetchError = null;
let lastRawCount = 0;
let lastCandidates = [];
let lastRootKeys = [];
let lastFetchDurationMs = null;
let cache = null;
let cacheAt = 0;
const CACHE_MS = 15000;

function walk(value, path = '$', out = [], depth = 0) {
  if (depth > 12 || value == null) return out;
  if (Array.isArray(value)) {
    if (value.length && value.every(x => x && typeof x === 'object' && !Array.isArray(x))) {
      const keys = [...new Set(value.slice(0, 8).flatMap(x => Object.keys(x)))].sort();
      out.push({ path, count: value.length, keys, sample: value.slice(0, 2) });
    }
    value.slice(0, 2000).forEach((v, i) => walk(v, `${path}[${i}]`, out, depth + 1));
  } else if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, out, depth + 1);
  }
  return out;
}

function findArrays(payload) {
  const found = walk(payload);
  // Prefer the largest object-array candidates; do not assume they are option contracts.
  return found.sort((a, b) => b.count - a.count).slice(0, 8);
}

async function getMarket(force = false) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const started = Date.now();
  try {
    const response = await fetch(TSETMC_URL, {
      headers: { 'accept': 'application/json', 'user-agent': 'DastyarOption/3.2' },
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error(`TSETMC HTTP ${response.status}`);
    const payload = await response.json();
    const candidates = findArrays(payload);
    const largest = candidates[0];
    lastRootKeys = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload) : [];
    lastCandidates = candidates;
    lastRawCount = largest ? largest.count : (Array.isArray(payload) ? payload.length : 0);
    lastFetchAt = new Date();
    lastFetchError = null;
    lastFetchDurationMs = Date.now() - started;
    cache = { payload, candidates, count: lastRawCount };
    cacheAt = Date.now();
    return cache;
  } catch (err) {
    lastFetchError = err.message || String(err);
    lastFetchDurationMs = Date.now() - started;
    throw err;
  }
}

function dateText(d) {
  if (!d) return 'هنوز دریافت نشده';
  return new Date(d).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' });
}

function statusText() {
  return [
    'وضعیت سامانه: فعال',
    'نسخه: 3.2 (تشخیص ساختار)',
    `TSETMC flow: ${lastFetchAt ? 'دریافت موفق' : 'هنوز دریافت نشده'}`,
    `آخرین دریافت: ${dateText(lastFetchAt)}`,
    `تعداد رکورد خام: ${lastRawCount || 'نامشخص'}`,
    `زمان پاسخ منبع: ${lastFetchDurationMs == null ? 'نامشخص' : lastFetchDurationMs + ' ms'}`,
    `خطای آخر: ${lastFetchError || 'ندارد'}`,
    'مدل زبانی: غیرفعال',
    'سرمایه مبنا: ۵,۰۰۰,۰۰۰ تومان | ریسک هدف: ۰٫۵٪ | سقف ریسک: ۱٪',
    'حالت فعلی: تحلیل تشخیصی؛ تا تأیید ساختار قراردادها سیگنال صادر نمی‌شود.'
  ].join('\n');
}

function debugText() {
  if (!lastCandidates.length) return 'هنوز داده‌ای برای بررسی ساختار دریافت نشده است. ابتدا /market را بزن.';
  const lines = ['گزارش ساختار خام TSETMC (نمونه محدود):'];
  for (const c of lastCandidates.slice(0, 5)) {
    lines.push(`\nمسیر: ${c.path}\nتعداد: ${c.count}\nکلیدها: ${c.keys.join(', ') || 'ندارد'}`);
    const sample = c.sample && c.sample[0];
    if (sample) {
      const compact = {};
      for (const [k, v] of Object.entries(sample).slice(0, 18)) {
        compact[k] = typeof v === 'object' && v !== null ? (Array.isArray(v) ? `[array:${v.length}]` : '[object]') : v;
      }
      lines.push('نمونه رکورد: ' + JSON.stringify(compact).slice(0, 1000));
    }
  }
  return lines.join('\n').slice(0, 3900);
}

async function telegram(method, body) {
  if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN تنظیم نشده است.');
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${r.status}`);
  return data;
}

async function reply(chatId, text) {
  // Telegram message limit is 4096 characters.
  const chunks = String(text).match(/[\s\S]{1,3900}/g) || [''];
  for (const chunk of chunks) await telegram('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true });
}

function helpText() {
  return [
    'دستیار اختیار معاملات — نسخه ۳.۲',
    '',
    '/start یا /help — راهنما',
    '/market — دریافت داده خام زنجیره اختیار از TSETMC',
    '/status — وضعیت سرویس و آخرین دریافت',
    '/debug — نمایش مسیرها و کلیدهای رکوردهای دریافتی برای عیب‌یابی',
    '/analyze نماد — درخواست بررسی نماد پایه',
    '/scan — بررسی اولیه زنجیره اختیار',
    '/news نماد — وضعیت منبع اخبار',
    '',
    'نکته: تا وقتی فیلدهای قراردادها و ارتباط نماد پایه با قراردادها تأیید نشود، هیچ قیمت، تحلیل یا سیگنال حدسی ساخته نمی‌شود.'
  ].join('\n');
}

async function handleCommand(chatId, text) {
  const trimmed = (text || '').trim();
  const [rawCommand, ...args] = trimmed.split(/\s+/);
  const command = (rawCommand || '').split('@')[0].toLowerCase();
  const symbol = args.join(' ').trim();

  if (command === '/start' || command === '/help') return reply(chatId, helpText());
  if (command === '/status') return reply(chatId, statusText());
  if (command === '/market') {
    await reply(chatId, 'در حال دریافت زنجیره اختیار از TSETMC...');
    try {
      const data = await getMarket(true);
      const candidate = data.candidates[0];
      return reply(chatId, [
        'دریافت داده از TSETMC موفق بود.',
        `تعداد رکورد در بزرگ‌ترین آرایه: ${data.count}`,
        `مسیر آرایه: ${candidate ? candidate.path : 'تشخیص داده نشد'}`,
        `کلیدهای نمونه: ${candidate ? candidate.keys.join(', ') : 'نامشخص'}`,
        '',
        'این عدد به‌تنهایی به معنی شناسایی قرارداد اختیار نیست. برای بررسی دقیق، دستور /debug را اجرا و خروجی آن را ارسال کن.'
      ].join('\n'));
    } catch (e) {
      return reply(chatId, `خطا در دریافت TSETMC: ${e.message}`);
    }
  }
  if (command === '/debug') return reply(chatId, debugText());
  if (command === '/analyze') {
    if (!symbol) return reply(chatId, 'نماد دارایی پایه را همراه دستور وارد کن. مثال: /analyze فولاد');
    return reply(chatId, `نماد «${symbol}» دریافت شد. اما تحلیل متوقف است: هنوز نگاشت معتبر نماد پایه به قراردادهای اختیار و فیلدهای قیمت/سررسید تأیید نشده است. برای رفع خطا ابتدا /market و سپس /debug را اجرا کن. فعلاً سیگنال صادر نمی‌شود.`);
  }
  if (command === '/scan') {
    try {
      const data = await getMarket();
      return reply(chatId, `دریافت داده انجام شد (${data.count} رکورد خام). اسکن کامل نشد، چون ساختار قراردادهای اختیار هنوز اعتبارسنجی نشده است. برای جلوگیری از سیگنال اشتباه، نتیجه «عدم معامله / داده ناکافی» است. دستور /debug را اجرا کن.`);
    } catch (e) {
      return reply(chatId, `اسکن متوقف شد؛ دریافت داده ناموفق بود: ${e.message}`);
    }
  }
  if (command === '/news') {
    if (!symbol) return reply(chatId, 'نماد را همراه دستور وارد کن. مثال: /news فولاد');
    return reply(chatId, `نماد «${symbol}» دریافت شد؛ اما در این نسخه منبع خبری/پیام‌های ناظر به‌صورت عملیاتی متصل و راستی‌آزمایی نشده است. برای جلوگیری از خبرسازی، خبر یا اثر بنیادی گزارش نمی‌شود.`);
  }
  return reply(chatId, 'دستور شناخته نشد. برای دیدن دستورها /help را بزن.');
}

app.get('/', (_req, res) => res.type('text').send('Iran Options Assistant is running'));
app.get('/health', (_req, res) => res.json({ ok: true, version: '3.2', uptime_seconds: Math.floor(process.uptime()) }));
app.post('/telegram', async (req, res) => {
  if (SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) return res.sendStatus(401);
  res.sendStatus(200);
  const message = req.body && (req.body.message || req.body.edited_message);
  if (!message || !message.chat || !message.text) return;
  try { await handleCommand(message.chat.id, message.text); }
  catch (err) { console.error('Telegram handler error:', err.message); }
});

app.listen(PORT, () => console.log(`Iran Options Assistant v3.2 running on ${PORT}`));
