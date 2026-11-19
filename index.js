'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core');
const decisionCenter = require('./decision-center');
const positionManager = require('./position-manager');
const portfolioEngine = require('./portfolio-engine');
const researchSources = require('./research-sources');

const app = express();
app.use(express.json({ limit: '1mb' }));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.WEBHOOK_SECRET;
const PORT = Number(process.env.PORT || 10000);
const VERSION = '5.1.0';
const CAPITAL_TOMAN = Number(process.env.CAPITAL_TOMAN || 5000000);
const ENTRY_BUDGET_PCT = 0.60;
const ENTRY_BUDGET_TOMAN = CAPITAL_TOMAN * ENTRY_BUDGET_PCT;
const POSITION_STOP_PCT = 0.20;
const INITIAL_TARGET_PCT = 0.10;
const RISK_PCT = POSITION_STOP_PCT;
const MAX_RISK_PCT = POSITION_STOP_PCT;
const RAW_MIN_RR = Number(process.env.MIN_RR || 2);
const MIN_RR = Number.isFinite(RAW_MIN_RR) ? Math.max(2, RAW_MIN_RR) : 2;
const RAW_RFR = process.env.RISK_FREE_RATE === undefined || process.env.RISK_FREE_RATE === '' ? null : Number(process.env.RISK_FREE_RATE);
const RISK_FREE_RATE = Number.isFinite(RAW_RFR) && RAW_RFR >= 0 && RAW_RFR <= 1.5 ? RAW_RFR : null;
const ALLOWED_CHAT_IDS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const STARTED_AT = new Date();

let lastMarket = null;
let lastMarketError = null;
let lastMarketAt = null;
let lastUpdateAt = null;
const oiSnapshots = new Map();
const SNAPSHOT_FILE = path.join(process.env.POSITION_DATA_DIR || path.join(__dirname, 'data'), 'oi_history.json');

function safeNumber(n) { return Number.isFinite(Number(n)) ? Number(n) : null; }
function cacheFileLoad() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return;
    const rows = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    for (const [k, v] of Object.entries(rows)) oiSnapshots.set(k, v);
  } catch (e) { console.warn('OI snapshot history not loaded:', e.message); }
}
function cacheFileSave() {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    const obj = Object.fromEntries(oiSnapshots.entries());
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(obj));
  } catch (e) { console.warn('OI snapshot history not saved:', e.message); }
}
cacheFileLoad();

function trackOpenInterest(options) {
  const now = Date.now();
  for (const o of options || []) {
    const identity = o.insCode || o.isin;
    if (!identity || o.openInterest == null) continue;
    const old = oiSnapshots.get(identity);
    o.openInterestChange = old && Number.isFinite(old.value) ? o.openInterest - old.value : null;
    o.openInterestObservedMinutes = old ? Math.max(0, (now - old.at) / 60000) : null;
    oiSnapshots.set(identity, { value: o.openInterest, at: now });
  }
  cacheFileSave();
  return options;
}

async function telegram(method, body) {
  if (!TOKEN) throw new Error('متغیر TELEGRAM_BOT_TOKEN در Render تنظیم نشده است.');
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram HTTP ${response.status}`);
  return data;
}

async function reply(chatId, text) {
  const chunks = String(text || '').match(/[\s\S]{1,3900}/g) || [''];
  for (const chunk of chunks) await telegram('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true });
}

async function safeFetch(path, keys) {
  try { return await core.fetchJson(path, { cacheMs: 120000 }); }
  catch (e) { return { __error: e.message }; }
}

async function getMarket(force = false) {
  if (!force && lastMarket && Date.now() - lastMarketAt < 12000) return lastMarket;
  try {
    const result = await core.getOptionMarket(force);
    if (!result.options.length) {
      const fields = result.selected ? result.selected.keys.join(', ') : 'هیچ آرایه‌ای پیدا نشد';
      throw new Error(`داده دریافت شد اما ساختار قراردادها شناسایی نشد. فیلدهای قابل مشاهده: ${fields}`);
    }
    trackOpenInterest(result.options);
    lastMarket = result; lastMarketAt = Date.now(); lastMarketError = null;
    return result;
  } catch (e) { lastMarketError = e.message; throw e; }
}

function baseInfoFromGroup(group) {
  const firstOption = group.options[0] || {};
  return { code: group.code || firstOption.underlyingCode, ticker: group.ticker || firstOption.underlyingTicker, name: group.name || firstOption.underlyingName, rowSpot: firstOption.spot };
}

async function resolveUnderlying(symbol, market) {
  const q = core.normalizeSymbol(symbol);
  if (!q) return { group: null, base: null, searchError: 'نماد وارد نشده است.' };

  // 1) If the user supplied an option ticker/insCode, resolve it to its underlying first.
  const directOption = (market.options || []).find(o =>
    core.normalizeSymbol(o.ticker) === q || String(o.insCode || '') === String(symbol).trim()
  );
  if (directOption) {
    const code = String(directOption.underlyingCode || '');
    let group = code ? core.groupOptionsByUnderlying(market.options).find(g => String(g.code || '') === code) : null;
    if (!group) group = market.options.filter(o =>
      (code && String(o.underlyingCode || '') === code) ||
      (directOption.underlyingTicker && core.normalizeSymbol(o.underlyingTicker) === core.normalizeSymbol(directOption.underlyingTicker))
    );
    const options = Array.isArray(group) ? group : (group?.options || []);
    const base = {
      code: code || directOption.underlyingCode,
      ticker: directOption.underlyingTicker || (group && !Array.isArray(group) ? group.ticker : null),
      name: directOption.underlyingName || (group && !Array.isArray(group) ? group.name : null),
      rowSpot: directOption.spot || null
    };
    if (base.code && !base.ticker) {
      const info = await safeFetch(`/Instrument/GetInstrumentInfo/${base.code}`);
      const obj = core.findObjectByKey(info, ['instrumentInfo']);
      base.ticker = core.first(obj, ['lVal18AFC','symbol','ticker','instrumentName']) || null;
      base.name = base.name || core.first(obj, ['lVal30','name','companyName']) || null;
    }
    return { group: Array.isArray(group) ? { code: base.code, ticker: base.ticker, name: base.name, options } : group, base, matchedOption: directOption };
  }

  // 2) Resolve an underlying ticker from the already parsed option chain.
  let group = core.findUnderlyingGroup(market.options, symbol);
  if (group && group.code) return { group, base: baseInfoFromGroup(group), search: null };

  // 3) Search TSETMC instrument directory; tolerate response key/casing variations.
  const searchRaw = await safeFetch(`/Instrument/GetInstrumentSearch/${encodeURIComponent(symbol)}`);
  if (searchRaw.__error) return { group: null, base: null, searchError: searchRaw.__error };
  const matches = core.findArrayByKey(searchRaw, ['instrumentSearch','instruments','result','InstrumentSearch','Items']);
  const found = matches.find(x => core.normalizeSymbol(core.first(x,['lVal18AFC','symbol','ticker','insCode']) || '') === q)
    || matches.find(x => {
      const t = core.normalizeSymbol(core.first(x,['lVal18AFC','symbol','ticker','instrumentName']) || '');
      const n = core.normalizeSymbol(core.first(x,['lVal30','name','companyName']) || '');
      return (t && (t.startsWith(q) || q.startsWith(t))) || (n && n.includes(q));
    });
  if (!found) return { group: null, base: null, searchError: 'نماد پایه یا قرارداد متناظر در فهرست TSETMC پیدا نشد.' };
  const code = String(core.first(found,['insCode','InsCode','instrumentCode']) || '');
  if (!code) return { group: null, base: null, searchError: 'نماد پیدا شد، اما شناسه معتبر سهم پایه در پاسخ TSETMC نبود.' };
  const options = market.options.filter(o => String(o.underlyingCode || '') === code);
  const g = options.length ? { code, ticker: core.first(found,['lVal18AFC','symbol','ticker']), name: core.first(found,['lVal30','name']), options,
    totalValue: options.reduce((a,o)=>a+(o.value||0),0), totalVolume: options.reduce((a,o)=>a+(o.volume||0),0) } : null;
  return { group: g, base: { code, ticker: core.first(found,['lVal18AFC','symbol','ticker']), name: core.first(found,['lVal30','name']), rowSpot: null }, search: found };
}

async function enrichWithOrderBooks(options) {
  const targets = [...options].filter(o => o.insCode).sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 6);
  const byCode = new Map();
  for (const option of targets) {
    const raw = await safeFetch(`/BestLimits/${option.insCode}`);
    if (raw.__error) continue;
    const book = core.extractBestLimits(raw);
    if (book.available) byCode.set(option.insCode, book);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return options.map(o => {
    const book = byCode.get(o.insCode);
    if (!book) return o;
    return { ...o, bid: book.bestBid ?? o.bid, bidVolume: book.bestBidVolume ?? o.bidVolume, ask: book.bestAsk ?? o.ask, askVolume: book.bestAskVolume ?? o.askVolume, book };
  });
}

async function analyzeSymbol(symbol) {
  const market = await getMarket();
  const resolved = await resolveUnderlying(symbol, market);
  if (!resolved.base || !resolved.base.code) return { error: resolved.searchError || 'نماد پایه پیدا نشد.', market };
  const base = resolved.base;
  const code = base.code;
  const [quoteRaw, historyRaw, infoRaw, flowRaw, newsRaw, codalRaw] = await Promise.all([
    safeFetch(`/ClosingPrice/GetClosingPriceInfo/${code}`),
    safeFetch(`/ClosingPrice/GetClosingPriceDailyList/${code}/120`),
    safeFetch(`/Instrument/GetInstrumentInfo/${code}`),
    safeFetch(`/ClientType/GetClientType/${code}/1/0`),
    safeFetch(`/Msg/GetMsgByInsCode/${code}`),
    safeFetch(`/Codal/GetPreparedDataByInsCode/9/${code}`),
  ]);
  const quote = quoteRaw.__error ? null : core.extractPriceInfo(quoteRaw);
  const history = historyRaw.__error ? [] : core.findArrayByKey(historyRaw, ['closingPriceDaily', 'closingPrice', 'history']);
  const technical = core.analyzeTechnical(history);
  const fundamentals = infoRaw.__error ? { available: false } : core.extractFundamentals(infoRaw);
  const flow = flowRaw.__error ? { available: false, error: flowRaw.__error } : core.extractClientFlow(flowRaw);
  let news = newsRaw.__error ? [] : core.extractMessages(newsRaw);
  let codal = codalRaw.__error ? [] : core.extractMessages(codalRaw);
  const externalResearch = await Promise.allSettled([
    researchSources.fetchNews(base.ticker || symbol, 12),
    researchSources.fetchCodal(base.ticker || symbol, 12),
  ]);
  const externalNews = externalResearch[0].status === 'fulfilled' ? externalResearch[0].value.items : [];
  const externalCodal = externalResearch[1].status === 'fulfilled' ? externalResearch[1].value.items : [];
  news = news.concat(externalNews.map(x => ({ title:x.title, date:x.date, link:x.link, source:x.source, description:x.description })));
  codal = codal.concat(externalCodal.map(x => ({ title:x.title, date:x.date, link:x.link, source:x.source, symbol:x.symbol })));
  const spot = (quote && (quote.last || quote.close)) || (base.rowSpot > 0 ? base.rowSpot : null) || (market.options.find(o => o.underlyingCode === code && o.spot > 0)?.spot) || (technical.available ? technical.lastClose : null);
  const spotSource = quote && (quote.last || quote.close) ? 'تابلوی قیمت TSETMC' : base.rowSpot > 0 ? 'رکورد زنجیره اختیار' : 'تاریخچه قیمت';
  const contractOptions = (resolved.group?.options || market.options.filter(o => o.underlyingCode === code));
  const withBooks = await enrichWithOrderBooks(contractOptions);
  const enriched = core.enrichOptions(withBooks, spot, Number.isFinite(RISK_FREE_RATE) ? RISK_FREE_RATE : null);
  const riskBudget = Math.max(0, CAPITAL_TOMAN * POSITION_STOP_PCT);
  const compatibleDirection = technical.available ? technical.direction : 'نامشخص';
  const longCandidates = enriched.map(o => core.calcLongOptionCandidate(o, compatibleDirection, technical, spot, riskBudget, o.contractSize, MIN_RR, ENTRY_BUDGET_TOMAN, POSITION_STOP_PCT)).filter(Boolean).sort((a, b) => b.rr - a.rr).slice(0, 2);
  const limitToEntryBudget = (items, unitCost) => items.map(x => {
    const per = unitCost(x);
    if (!(per > 0)) return null;
    const q = Math.min(x.quantity, Math.floor(ENTRY_BUDGET_TOMAN / per));
    if (q < 1) return null;
    const ratio = q / x.quantity;
    return { ...x, quantity: q, maxLoss: x.maxLoss * ratio,
      maxProfit: x.maxProfit == null ? x.maxLoss * ratio : x.maxProfit * ratio,
      targetProfit: x.targetProfit == null ? x.maxLoss * ratio : x.targetProfit * ratio,
      totalCost: per * q };
  }).filter(Boolean);
  const spreads = technical.available ? limitToEntryBudget(core.calcDebitSpreads(enriched, compatibleDirection, riskBudget, MIN_RR),
    x => x.debit * x.buy.contractSize / 10) : [];
  const straddles = technical.available ? limitToEntryBudget(core.calcLongStraddles(enriched, technical, riskBudget, MIN_RR),
    x => x.premium * x.call.contractSize / 10) : [];
  const sortedLiquidity = enriched.map(o => ({ ...o, quality: core.optionQuality(o).score })).sort((a, b) => b.quality - a.quality).slice(0, 5);
  return {
    symbol: base.ticker || symbol, name: base.name, code, spot, spotSource, quote,
    technical, fundamentals, flow, news, codal, options: enriched, sortedLiquidity,
    longCandidates, spreads, straddles, ratios: core.putCallRatios(enriched), sentiment: core.scoreNewsSentiment(news.concat(codal)), fetchedAt: market.fetchedAt, market,
    errors: { quote: quoteRaw.__error, history: historyRaw.__error, info: infoRaw.__error, flow: flowRaw.__error, news: newsRaw.__error || (externalResearch[0].status === 'rejected' ? externalResearch[0].reason.message : null), codal: codalRaw.__error || (externalResearch[1].status === 'rejected' ? externalResearch[1].reason.message : null) },
  };
}

function buildAnalysisText(a) {
  if (a.error) return `تحلیل نماد انجام نشد\nدلیل: ${a.error}\n\nبرای بررسی فهرست نمادها /market را بزن.`;
  const lines = [
    `گزارش بررسی ${a.symbol}${a.name ? ` ـ ${a.name}` : ''}`,
    `زمان دریافت داده: ${a.fetchedAt.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}`,
    `منبع زنجیره اختیار: ${a.market?.source || 'نامشخص'}`,
    `قیمت سهم پایه: ${core.toman(a.spot)} (${a.spotSource})`,
    `زمان ثبت قیمت پایه در منبع: ${a.quote?.date || a.quote?.time ? `${a.quote.date || 'تاریخ نامشخص'} ${a.quote.time || ''}` : 'منبع زمان مستقل آخرین معامله را اعلام نکرده است'}` ,
    'زمان دریافت ربات با زمان آخرین معامله یکی نیست؛ در صورت تأخیر منبع، قیمت را پیش از ورود در تابلوی کارگزاری هم کنترل کن.',
    '', '۱) وضعیت تکنیکال', core.directionExplanation(a.technical),
    '', '۲) وضعیت بنیادی',
  ];
  if (a.fundamentals.available) {
    lines.push(`EPS: ${core.formatNumber(a.fundamentals.eps)} | نسبت P/E: ${core.formatNumber(a.fundamentals.pe, 2)} | P/E گروه: ${core.formatNumber(a.fundamentals.sectorPe, 2)}`);
    if (a.fundamentals.sector) lines.push(`گروه: ${a.fundamentals.sector}`);
    lines.push('این بخش فقط فیلدهای موجود در اطلاعات نماد را نشان می‌دهد؛ تحلیل صورت‌های مالی کامل نیست.');
  } else lines.push('اطلاعات بنیادی کافی از سرویس نماد دریافت نشد؛ نتیجه بنیادی صادر نمی‌شود.');
  lines.push('', '۳) جریان خرید و فروش حقیقی/حقوقی', core.summarizeFlow(a.flow));
  lines.push('', '۴) وضعیت زنجیره اختیار',
    `تعداد قراردادهای شناسایی‌شده: ${core.formatNumber(a.options.length)} (خرید: ${core.formatNumber(a.options.filter(o => o.type === 'call').length)}، فروش: ${core.formatNumber(a.options.filter(o => o.type === 'put').length)})`,
    `تاریخ داخل رکوردها: ${core.getOptionFreshness(a.options)}`,
    `نسبت حجم فروش به خرید (PCR): ${a.ratios.volume == null ? 'قابل محاسبه نیست' : core.formatNumber(a.ratios.volume, 2)} | نسبت ارزش: ${a.ratios.value == null ? 'قابل محاسبه نیست' : core.formatNumber(a.ratios.value, 2)} | نسبت موقعیت باز: ${a.ratios.openInterest == null ? 'داده کافی ندارد' : core.formatNumber(a.ratios.openInterest, 2)}`,
    'نسبت PCR فقط مقایسه حجم/ارزش/موقعیت باز Put با Call است و به‌تنهایی جهت بازار را مشخص نمی‌کند.');
  if (a.sortedLiquidity.length) {
    lines.push('قراردادهای با نقدشوندگی بهتر برای بررسی:');
    for (const o of a.sortedLiquidity.slice(0, 4)) {
      const oi = o.openInterestChange == null ? 'تغییر موقعیت باز: سابقه مقایسه نداریم' : `تغییر موقعیت باز از دریافت قبلی: ${o.openInterestChange > 0 ? '+' : ''}${core.formatNumber(o.openInterestChange)}`;
      const depth = o.book?.imbalance == null ? '' : ` | برتری سفارش خرید/فروش: ${core.formatNumber(o.book.imbalance * 100, 1)}٪`;
      lines.push(`• ${o.typeFa} ${o.ticker} | قیمت اعمال ${core.toman(o.strike)} | روز مانده ${core.formatNumber(o.daysRemaining)} | حجم ${core.formatNumber(o.volume)} | فاصله عرضه/تقاضا ${o.spreadPct == null ? 'نامشخص' : `${core.formatNumber(o.spreadPct, 1)}٪`} | ${oi}${depth}`);
    }
  } else lines.push('قرارداد قابل رتبه‌بندی از نظر نقدشوندگی شناسایی نشد.');
  lines.push('', '۵) بررسی موقعیت و ریسک');
  if (a.longCandidates.length || a.spreads.length || a.straddles.length) {
    for (const c of a.longCandidates) lines.push(`• ${c.strategy}: ${c.option.ticker} | تعداد مجاز با ریسک هدف: ${core.formatNumber(c.quantity)} قرارداد | زیان حداکثری برآوردی: ${core.formatNumber(c.maxLoss)} تومان | سود سناریوی هدف: ${core.formatNumber(c.targetProfit)} تومان | نسبت سود به زیان: ۱ به ${core.formatNumber(c.rr, 2)}`);
    for (const s of a.spreads) lines.push(`• ${s.strategy}: خرید ${s.buy.ticker} و فروش ${s.sell.ticker} | تعداد: ${core.formatNumber(s.quantity)} | حداکثر زیان: ${core.formatNumber(s.maxLoss)} تومان | حداکثر سود: ${core.formatNumber(s.maxProfit)} تومان | نسبت سود به زیان: ۱ به ${core.formatNumber(s.rr, 2)}`);
    for (const s of a.straddles) lines.push(`• ${s.strategy}: ${s.scenario} تا محدوده ${core.toman(s.target)} | خرید ${s.call.ticker} + ${s.put.ticker} | تعداد: ${core.formatNumber(s.quantity)} جفت | حداکثر زیان: ${core.formatNumber(s.maxLoss)} تومان | سود این سناریو: ${core.formatNumber(s.targetProfit)} تومان | نسبت سود به زیان: ۱ به ${core.formatNumber(s.rr, 2)}`);
  } else {
    lines.push('در حال حاضر موقعیتی که هم‌زمان شرایط روند، نقدشوندگی، اطلاعات قیمت و نسبت سود به زیان حداقل ۱ به ۲ را داشته باشد پیدا نشد.');
    lines.push('نتیجه: عدم معامله؛ دنبال‌کردن معامله ضعیف بهتر از ورود اجباری نیست.');
  }
  lines.push('', '۶) اخبار و اطلاعیه‌ها');
  if (a.news.length) for (const n of a.news.slice(0, 3)) lines.push(`• ${n.title}${n.date ? ` ـ ${n.date}` : ''}${n.source ? ` ـ ${n.source}` : ''}${n.link ? `\n${n.link}` : ''}`);
  else lines.push('پیام ناظر مرتبط از سرویس TSETMC دریافت نشد. این به معنی نبود خبر در همه منابع نیست.');
  if (a.codal.length) {
    lines.push('آخرین موارد کدال:');
    for (const c of a.codal.slice(0, 3)) lines.push(`• ${c.title}${c.date ? ` ـ ${c.date}` : ''}${c.link ? `\n${c.link}` : ''}`);
  } else lines.push('اطلاعیه قابل استخراج کدال از مسیر عمومی TSETMC در این دریافت به دست نیامد.');
  lines.push(`جمع‌بندی کلیدواژه‌ای خبرها: ${a.sentiment.label} (مثبت: ${a.sentiment.positiveHits}، منفی: ${a.sentiment.negativeHits})`);
  lines.push('این برچسب فقط غربال اولیه واژه‌هاست و تحلیل معنایی/تأیید خبر محسوب نمی‌شود.');
  lines.push('', 'یادآوری مهم:',
    `سرمایه مبنا ${core.formatNumber(CAPITAL_TOMAN)} تومان است؛ بودجه هر ورود مستقل ${core.formatNumber(ENTRY_BUDGET_TOMAN)} تومان (۶۰٪ سرمایه) و حد زیان برنامه‌ریزی‌شده ۲۰٪ بهای تمام‌شده است؛ در ورود کامل، زیان برنامه‌ریزی‌شده ${core.formatNumber(ENTRY_BUDGET_TOMAN * POSITION_STOP_PCT)} تومان می‌شود.`,
    'محاسبه سود اختیارهای تکی در قیمت هدف، ارزش ذاتی در سررسید را می‌سنجد و ارزش زمانی، تغییر نوسان ضمنی، کارمزد، صف سفارش و لغزش قیمت را تضمین نمی‌کند.',
    'یونانی‌ها و نوسان ضمنی فقط وقتی محاسبه می‌شوند که نرخ بدون ریسک در Render به‌صورت معتبر تنظیم شده باشد؛ این محاسبات نیز با فرض مدل اروپایی تقریبی‌اند.',
    'تغییر موقعیت باز با مقایسه آخرین دریافت ربات محاسبه می‌شود؛ پس از Deploy یا خاموش/روشن‌شدن سرویس Render ممکن است سابقه مقایسه از دست برود.');
  const failedParts = Object.entries(a.errors).filter(([, v]) => v).map(([k]) => ({ quote: 'قیمت سهم', history: 'تاریخچه قیمت', info: 'اطلاعات بنیادی', flow: 'جریان حقیقی/حقوقی', news: 'پیام ناظر', codal: 'اطلاعیه کدال' }[k]));
  if (failedParts.length) lines.push('', `بخش‌هایی که منبعشان پاسخ نداد: ${failedParts.join('، ')}. نتیجه این بخش‌ها در تحلیل وارد نشده است.`);
  return lines.join('\n');
}

function buildMarketText(market) {
  const opts = market.options;
  const calls = opts.filter(o => o.type === 'call'), puts = opts.filter(o => o.type === 'put');
  const groups = core.groupOptionsByUnderlying(opts).filter(g => g.ticker);
  const top = groups.sort((a, b) => b.totalValue - a.totalValue).slice(0, 8);
  const topOpts = [...opts].sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 7);
  const lines = [
    'نمای کلی بازار اختیار معامله',
    `زمان دریافت: ${market.fetchedAt.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}`,
    `منبع داده: ${market.source || 'TSETMC'}`,
    `تعداد قراردادهای شناسایی‌شده: ${core.formatNumber(opts.length)}`,
    `اختیار خرید: ${core.formatNumber(calls.length)} | اختیار فروش: ${core.formatNumber(puts.length)}`,
    `دارایی‌های پایه شناسایی‌شده: ${core.formatNumber(groups.length)}`,
    core.getOptionFreshness(opts),
    `نسبت حجم Put به Call در کل بازار: ${core.putCallRatios(opts).volume == null ? 'نامشخص' : core.formatNumber(core.putCallRatios(opts).volume, 2)}`,
    '', 'نمادهای پایه با بیشترین ارزش معاملات اختیار:'
  ];
  for (const g of top) lines.push(`• ${g.ticker} | ارزش ثبت‌شده مجموع: ${core.toman(g.totalValue)} | حجم مجموع: ${core.formatNumber(g.totalVolume)}`);
  lines.push('', 'قراردادهای با بیشترین ارزش معاملات:');
  for (const o of topOpts) lines.push(`• ${o.ticker} (${o.typeFa}) | ${core.toman(o.value)} | حجم ${core.formatNumber(o.volume)} | سررسید ${o.endDate || 'نامشخص'}`);
  lines.push('', 'برای گزارش کامل یک نماد، دستور /analyze نام‌نماد را بفرست؛ مثلاً /analyze فولاد.');
  return lines.join('\n');
}

function buildChainText(symbol, options, resolved = null) {
  const q = core.normalizeSymbol(symbol);
  let filtered = resolved?.group?.options || [];
  if (!filtered.length) {
    const direct = options.find(o => core.normalizeSymbol(o.ticker) === q || String(o.insCode || '') === String(symbol).trim());
    if (direct) {
      const code = String(direct.underlyingCode || '');
      filtered = options.filter(o => (code && String(o.underlyingCode || '') === code) ||
        (direct.underlyingTicker && core.normalizeSymbol(o.underlyingTicker) === core.normalizeSymbol(direct.underlyingTicker)));
    } else {
      filtered = options.filter(o => (o.underlyingTicker && core.normalizeSymbol(o.underlyingTicker) === q) ||
        (o.underlyingName && core.normalizeSymbol(o.underlyingName) === q) || String(o.underlyingCode || '') === String(symbol).trim());
    }
  }
  if (!filtered.length) return `برای «${symbol}» قراردادی در زنجیره فعلی پیدا نشد. نماد پایه/قرارداد در داده دریافت‌شده قابل اتصال نبود؛ /debug را برای بررسی فیلد uaInsCode اجرا کن.`;
  const title = filtered[0].underlyingTicker || resolved?.base?.ticker || symbol;
  const lines = [`زنجیره اختیار نماد پایه ${title}`, `تعداد قراردادها: ${core.formatNumber(filtered.length)} (Call: ${filtered.filter(o=>o.type==='call').length} | Put: ${filtered.filter(o=>o.type==='put').length})`, ''];
  for (const o of [...filtered].sort((a, b) => (a.daysRemaining ?? 9999) - (b.daysRemaining ?? 9999)).slice(0, 18)) lines.push(core.summarizeOption(o), '────────────');
  return lines.join('\n').slice(0, 3800);
}

function buildScanText(market) {
  const groups = core.groupOptionsByUnderlying(market.options).filter(g => g.ticker).sort((a, b) => b.totalValue - a.totalValue).slice(0, 10);
  if (!groups.length) return 'نماد پایه‌ای برای اسکن پیدا نشد.';
  return ['اسکن اولیه بازار اختیار', 'این فهرست بر اساس ارزش معاملات ثبت‌شده زنجیره مرتب شده؛ به‌تنهایی سیگنال خرید نیست.', '', ...groups.map((g, i) => `${i + 1}) ${g.ticker} | ارزش مجموع اختیارها ${core.toman(g.totalValue)} | حجم ${core.formatNumber(g.totalVolume)} | ${core.formatNumber(g.options.length)} قرارداد`), '', 'برای تحلیل کامل هر نماد: /analyze نام‌نماد'].join('\n');
}

function buildNewsText(symbol, news) {
  if (!news.length) return `برای «${symbol}» پیام ناظر قابل دریافت نبود. این موضوع به معنی نبود خبر یا اطلاعیه در کدال و سایر منابع نیست.`;
  return [`پیام‌های ناظر مرتبط با ${symbol}`, '', ...news.slice(0, 8).map((n, i) => `${i + 1}) ${n.title}\n${n.date ? `تاریخ: ${n.date}\n` : ''}${n.text ? n.text.slice(0, 450) : ''}`)].join('\n\n');
}


function buildDecision(symbol, analysis) {
  return decisionCenter.evaluate(analysis, {
    capitalToman: CAPITAL_TOMAN, riskPct: RISK_PCT, maxRiskPct: MAX_RISK_PCT,
    minRR: MIN_RR, marketFetchedAt: analysis.market?.fetchedAt || null,
    source: analysis.market?.source || 'TSETMC', quote: analysis.quote || null,
    now: new Date(), riskFreeRate: RISK_FREE_RATE,
  });
}

function buildSignalText(symbol, analysis) {
  if (analysis.error) return `سیگنال صادر نشد\nنماد: ${symbol}\nدلیل: ${analysis.error}\nنتیجه: عدم معامله`;
  const d = buildDecision(symbol, analysis);
  const lines = [
    `مرکز تصمیم‌گیری اختیار | ${d.symbol || symbol}`,
    `زمان تحلیل: ${new Date().toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}`,
    `منبع زنجیره: ${analysis.market?.source || 'نامشخص'}`,
    `وضعیت داده: ${d.dataStatus}`, `وضعیت بازار: ${d.marketStatus}`,
    `امتیاز اطمینان تحلیلی: ${d.score}/100 (امتیاز کیفی، نه احتمال موفقیت)`,
    '', `تصمیم نهایی: ${d.decision}`, `جهت ترجیحی: ${d.direction}`,
    `قدرت شواهد: ${d.strength}`, '', 'دلایل تصمیم:', ...d.reasons.map(x => `• ${x}`),
    '', 'وضعیت موتورهای تحلیلی:',
    `تکنیکال: ${d.engines.technical}`, `بنیادی: ${d.engines.fundamental}`,
    `جریان حقیقی/حقوقی: ${d.engines.flow}`, `اخبار و احساسات: ${d.engines.sentiment}`,
    `نقدشوندگی و دفتر سفارش: ${d.engines.liquidity}`,
    `موقعیت باز و جریان قراردادها: ${d.engines.openInterest}`,
    `نسبت Put/Call: ${d.engines.putCall}`
  ];
  if (d.candidate) {
    const c = d.candidate;
    lines.push('', 'سناریوی پیشنهادی مشروط:', `استراتژی: ${c.strategy}`,
      `قرارداد: ${c.contract || 'چند قرارداد'}`, `ورود بر مبنای: ${c.entryBasis}`,
      `تعداد: ${core.formatNumber(c.quantity)} قرارداد`,
      `زیان برنامه‌ریزی‌شده تا حد خروج: ${core.formatNumber(c.maxLoss)} تومان`,
      `سود سناریوی هدف: ${core.formatNumber(c.targetProfit)} تومان`,
      `نسبت سود به زیان: ۱ به ${core.formatNumber(c.rr, 2)}`,
      `ابطال سناریو: ${c.invalidation || 'با نقض سطح تکنیکال یا تغییر شرایط بازار'}`);
  } else lines.push('', 'سناریوی ورود: وجود ندارد؛ هیچ قرارداد یا قیمتی برای ورود پیشنهاد نمی‌شود.');
  lines.push('', 'کنترل ریسک:',
    `سرمایه مبنا: ${core.formatNumber(CAPITAL_TOMAN)} تومان`,
    `بودجه ریسک هدف: ${core.formatNumber(CAPITAL_TOMAN * RISK_PCT)} تومان`,
    `سقف ریسک مجاز: ${core.formatNumber(CAPITAL_TOMAN * MAX_RISK_PCT)} تومان`,
    `حداقل نسبت سود به زیان: ۱ به ${core.formatNumber(MIN_RR, 2)}`,
    'این ربات سفارش ثبت نمی‌کند؛ قیمت و امکان اجرای واقعی باید در کارگزاری دوباره کنترل شود.');
  if (d.blockers.length) lines.push('', 'موارد مانع صدور سیگنال:', ...d.blockers.map(x => `• ${x}`));
  lines.push('', 'محدودیت: خبرخوان جامع، سنجش زنده شبکه‌های اجتماعی، شناسایی هویت نهنگ‌ها و اجرای سفارش در این نسخه وجود ندارد. فقط داده‌های واقعاً برگشتی تحلیل می‌شوند.');
  return lines.join('\n').slice(0, 3900);
}

function buildStrategyText(symbol, analysis, chatId = null) {
  if (analysis.error) return `بررسی استراتژی برای ${symbol} ممکن نیست: ${analysis.error}\nنتیجه: عدم معامله`;
  const d = buildDecision(symbol, analysis);
  const openPositions = chatId == null ? [] : positionManager.list(chatId, true)
    .filter(p => core.normalizeSymbol(p.underlying) === core.normalizeSymbol(d.symbol || symbol));
  const rawCandidates = [
    ...(analysis.longCandidates || []).map(c => ({ raw:c, contract:c.option?.ticker })),
    ...(analysis.spreads || []).map(c => ({ raw:c, contract:`${c.buy?.ticker} + ${c.sell?.ticker}` })),
    ...(analysis.straddles || []).map(c => ({ raw:c, contract:`${c.call?.ticker} + ${c.put?.ticker}` }))
  ];
  const lines = [
    `ارزیابی استراتژی‌ها | ${d.symbol || symbol}`, `وضعیت بازار: ${d.marketStatus}`,
    `اعتبار داده: ${d.dataStatus}`, `تصمیم مرکزی: ${d.decision}`,
    `امتیاز شواهد: ${d.score}/100`, '', 'رتبه‌بندی سناریوهای محدودریسک:'
  ];
  if (!d.strategies.length) lines.push('هیچ استراتژی‌ای با داده فعلی، نقدشوندگی و حداقل نسبت ۱:۲ تأیید نشد.');
  lines.push('بودجه هر ورود مستقل: ۳٬۰۰۰٬۰۰۰ تومان (۶۰٪ سرمایه). حد زیان برنامه‌ریزی‌شده خرید تکی ۲۰٪ بهای تمام‌شده است؛ زیان نهایی خرید اختیار تا کل پرمیوم پرداختی ممکن است برسد.');
  if (openPositions.length) {
    lines.push('', `موتور پرتفوی: ${openPositions.length} موقعیت باز روی ${d.symbol || symbol} شناسایی شد؛ اثر استراتژی جدید با موقعیت‌های هم‌سررسید سنجیده می‌شود.`);
    for (const p of openPositions.slice(0,8)) lines.push(`• موجود: ${p.id} | ${p.optionTicker} | ${p.side} ${p.type} | اعمال ${core.formatNumber(p.strike)} | سررسید ${p.expiry} | ورود ${core.formatNumber(p.entryToman)} تومان × ${p.quantity}`);
  } else {
    lines.push('', 'موتور پرتفوی: موقعیت بازی برای این نماد در حساب همین چت ثبت نشده است.');
  }
  for (const [i, s] of d.strategies.slice(0, 6).entries()) {
    const raw = rawCandidates.find(x => x.contract === s.contract)?.raw;
    const portfolio = raw ? portfolioEngine.evaluate(openPositions, raw, d.symbol || symbol) : null;
    lines.push(`${i + 1}) ${s.strategy} | ${s.contract || 'ترکیب چند قرارداد'} | تعداد ${core.formatNumber(s.quantity)} | ریسک برنامه‌ریزی‌شده ورود ${core.formatNumber(s.maxLoss)} تومان${s.maxLossAtExpiry ? ` | زیان تا سررسید ورود ${core.formatNumber(s.maxLossAtExpiry)} تومان` : ''} | سود سناریویی ${core.formatNumber(s.targetProfit)} تومان | R:R = ۱:${core.formatNumber(s.rr, 2)}`);
    if (portfolio?.ok) {
      lines.push(`   اثر پرتفوی هم‌سررسید: ${portfolio.classification}`);
      const beforeLoss = !portfolio.before.ok ? 'پرتفوی هم‌سررسید قبلی ندارد' : portfolio.before.unboundedLoss ? 'نامحدود' : core.formatNumber(portfolio.before.maxLoss);
      const afterLoss = portfolio.after.unboundedLoss ? 'نامحدود' : core.formatNumber(portfolio.after.maxLoss);
      lines.push(`   زیان حداکثری سناریویی قبل/بعد: ${beforeLoss} / ${afterLoss} تومان`);
      if (portfolio.after.unboundedLoss) lines.push('   هشدار جدی: ساختار کل در قیمت‌های بالای سهم پایه زیان نامحدود بالقوه دارد؛ این گزینه نباید اجرا شود.');
      else lines.push(`   سود حداکثری سناریویی پس از افزودن: ${portfolio.after.unboundedProfit ? 'نامحدود' : core.formatNumber(portfolio.after.maxProfit)} تومان | سربه‌سر(های) سررسید: ${portfolio.after.breakevens.length ? portfolio.after.breakevens.map(x=>core.formatNumber(x,2)).join('، ') : 'در دامنه محاسبه‌شده ندارد'}`);
      if (portfolio.otherExpiryNote) lines.push(`   ${portfolio.otherExpiryNote}`);
    } else if (portfolio?.reason) lines.push(`   اثر پرتفوی محاسبه نشد: ${portfolio.reason}`);
  }
  lines.push('', 'استراتژی‌های بررسی‌شده: خرید Call، خرید Put، اسپرد بدهکار صعودی، اسپرد بدهکار نزولی و استرادل خرید.',
    'فروش اختیار بدون پوشش و استراتژی‌های با زیان نامحدود در خود پیشنهادها مجاز نیستند. موقعیت‌های سررسید متفاوت هرگز در یک نمودار سررسید ادغام نمی‌شوند.',
    'اعداد پرتفوی، سود/زیان نظری در سررسید و بدون کارمزد/لغزش/صف/ارزش زمانی/تغییر IV هستند؛ ارزش روزانه موقعیت با این اعداد یکی نیست. ربات سفارش ثبت یا تغییر نمی‌دهد.');
  if (d.blockers.length) lines.push('', 'محدودیت‌ها:', ...d.blockers.map(x => `• ${x}`));
  return lines.join('\n').slice(0, 3900);
}

function buildPositionManagementText(p, option, analysis) {
  const baseReport = positionManager.report(p, option);
  const tech = analysis?.technical || {};
  const lines = [baseReport, '', 'ارزیابی شرایط بازار برای همین موقعیت:'];
  if (analysis?.error) {
    lines.push(`تحلیل سهم پایه کامل نشد: ${analysis.error}`, 'اقدام: فقط گزارش قیمت فعلی؛ پیشنهاد تغییر استراتژی صادر نمی‌شود.');
    return lines.join('\n');
  }
  lines.push(`نماد پایه: ${analysis.symbol || p.underlying} | قیمت پایه: ${core.toman(analysis.spot)}`);
  lines.push(`روند تکنیکال: ${tech.available ? tech.direction : 'داده کافی نیست'} | RSI: ${tech.rsi14 == null ? 'نامشخص' : core.formatNumber(tech.rsi14,1)}`);
  const aligned = tech.available && ((p.type === 'call' && tech.direction === 'صعودی') || (p.type === 'put' && tech.direction === 'نزولی'));
  const mark = positionManager.mark(p, option);
  if (mark.ok && mark.pct <= -20) lines.push('اقدام اولویت‌دار: زیان به حد برنامه‌ریزی‌شده ۲۰٪ رسیده/عبور کرده؛ خروج یا کاهش ریسک را فوراً با مظنه قابل اجرا بررسی کن. میانگین کم‌کردن برای جبران زیان پیشنهاد نمی‌شود.');
  else if (mark.ok && mark.pct >= 10) lines.push('اقدام اولویت‌دار: هدف اولیه سود ۱۰٪ عبور کرده؛ ذخیره بخشی از سود یا حد خروج شناور را بررسی کن.');
  else if (!tech.available) lines.push('پیشنهاد: پایش بدون تغییر؛ داده تکنیکال کافی نیست و برای تغییر پوزیشن قیمت عملیاتی صادر نمی‌شود.');
  else if (!aligned) lines.push('هشدار: جهت فعلی تکنیکال با نوع قرارداد هم‌جهت نیست؛ سناریوی خروج/کاهش ریسک را جدی بررسی کن. این پیام دستور فروش نیست.');
  else lines.push('وضعیت: جهت تکنیکال فعلاً با نوع قرارداد هم‌جهت است؛ نگهداری فقط مشروط به رعایت حد زیان و نقدشوندگی.');
  if (p.side === 'short') lines.push('ریسک فروش اختیار: زیان بالقوه ممکن است از وجه دریافتی بیشتر شود؛ وجه تضمین و ریسک بازگشایی/بستن باید جداگانه کنترل شود.');
  lines.push('این ارزیابی از داده فعلی بازار استفاده می‌کند؛ برای اسپردها و موقعیت‌های چندپایه، هر پایه باید جداگانه ثبت و ریسک ترکیبی دستی کنترل شود. هیچ سفارشی اجرا یا تغییر داده نمی‌شود.');
  return lines.join('\n');
}

function helpText() {
  return [
    `دستیار اختیار معاملات | نسخه ${VERSION}`,
    'همه گزارش‌ها به زبان ساده نوشته می‌شوند؛ کدهای داخلی API در گزارش معمولی نمایش داده نمی‌شوند.',
    '',
    '/start یا /help — راهنما',
    '/market — نمای کلی بازار اختیار',
    '/scan — نمادهای دارای بیشترین گردش معاملات اختیار',
    '/analyze نماد — تحلیل چندبخشی نماد پایه؛ مثال: /analyze فولاد',
    '/signal نماد — تصمیم نهایی و سیگنال مشروط با کنترل داده و ریسک',
    '/strategy نماد — مقایسه و رتبه‌بندی استراتژی‌های محدودریسک',
    '/chain نماد — فهرست قراردادهای اختیار نماد',
    '/news نماد — پیام‌های ناظر مرتبط با نماد',
    '/research نماد — جست‌وجوی اطلاعیه‌های کدال و خبرگزاری‌ها',
    '/position add نماد قرارداد call|put long|short اعمال سررسید قیمت_ورود تعداد — ثبت موقعیت',
    '/position list — فهرست موقعیت‌های باز',
    '/position check [شناسه] — بررسی دستی موقعیت یا همه موقعیت‌ها',
    '/position close شناسه — بستن پرونده موقعیت (فقط در ربات، نه سفارش بازار)',
    '/risk — سرمایه و حدود ریسک تنظیم‌شده',
    '/status — وضعیت دریافت و موتورهای ربات',
    '/debug — گزارش فنی کوتاه برای عیب‌یابی',
    '',
    'پایش موقعیت‌ها دستی و خودکار است؛ هشدار خودکار در تغییر مهم سود/زیان ارسال می‌شود. ربات هیچ سفارشی ثبت یا تغییر نمی‌دهد.',
    'برای ثبت موقعیت: /position add فولاد نمادقرارداد call long 10000 1405/12/20 850 5 (اندازه قرارداد از زنجیره خوانده می‌شود).',
    'برای ماندگاری پرونده‌ها پس از راه‌اندازی مجدد Render، دیسک پایدار با مسیر /var/data و متغیر POSITION_DATA_DIR=/var/data لازم است.'
  ].join('\n');
}

function statusText() {
  return [
    `وضعیت دستیار: فعال | نسخه ${VERSION}`,
    `شروع سرویس: ${STARTED_AT.toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}`,
    `آخرین دریافت موفق زنجیره: ${lastMarketAt ? new Date(lastMarketAt).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) : 'هنوز دریافت نشده'}`,
    `آخرین تعداد قرارداد شناسایی‌شده: ${lastMarket ? core.formatNumber(lastMarket.options.length) : 'نامشخص'}`,
    `منبع آخرین دریافت: ${lastMarket?.source || 'هنوز دریافت نشده'}`,
    `خطای آخر منبع: ${lastMarketError || 'ندارد'}`,
    `تحلیل تکنیکال: ${lastMarket ? 'آماده اجرا، وابسته به دریافت تاریخچه سهم پایه' : 'در انتظار دریافت داده'}`,
    `جریان حقیقی/حقوقی: اتصال در زمان تحلیل هر نماد` ,
    `نرخ بدون ریسک برای یونانی‌ها: ${RISK_FREE_RATE == null ? 'تنظیم نشده؛ IV و یونانی‌ها غیرفعال' : `${core.formatNumber(RISK_FREE_RATE * 100, 2)}٪ سالانه (تنظیم دستی)`}`,
    `سرمایه: ${core.formatNumber(CAPITAL_TOMAN)} تومان | بودجه هر ورود: ${core.formatNumber(ENTRY_BUDGET_TOMAN)} تومان | حد زیان برنامه‌ریزی‌شده: ۲۰٪ بهای تمام‌شده | هدف اولیه: بیش از ۱۰٪ | حداقل R:R: ۱ به ${core.formatNumber(MIN_RR, 1)}`,
    'ثبت سفارش خودکار: غیرفعال',
  ].join('\n');
}

function debugText(market) {
  if (!market) return `هنوز دریافت موفقی انجام نشده است. خطای آخر: ${lastMarketError || 'ندارد'}\nابتدا /market را اجرا کن.`;
  const keys = market.selected?.keys || [];
  const sample = market.selected?.rows?.[0] || {};
  const recognizedFields = Object.keys(sample).slice(0, 45).map(k => `${k}: ${String(sample[k]).slice(0, 45)}`);
  return [
    'گزارش فنی برای بررسی مشکل',
    `تعداد قراردادهای تبدیل‌شده: ${market.options.length}`,
    `منبع داده: ${market.source || 'نامشخص'}`,
    `آدرس منبع: ${market.sourceUrl || 'نامشخص'}`,
    ...(market.diagnostics || []).map(x => `یادداشت منبع: ${x}`),
    `مسیر آرایه: ${market.selected?.path || 'نامشخص'}`,
    `تعداد رکورد آرایه: ${market.selected?.count || 0}`,
    `کلیدهای اصلی: ${keys.join(', ')}`,
    '', 'نمونه فیلدها:', ...recognizedFields,
    '', 'این گزارش برای عیب‌یابی است؛ گزارش‌های عادی ربات کد فنی نمایش نمی‌دهند.'
  ].join('\n').slice(0, 3800);
}

async function handleCommand(chatId, text) {
  lastUpdateAt = new Date();
  const parts = String(text || '').trim().split(/\s+/);
  const command = (parts.shift() || '').split('@')[0].toLowerCase();
  const symbol = parts.join(' ').trim();
  if (command === '/start' || command === '/help') return reply(chatId, helpText());
  if (command === '/status') return reply(chatId, statusText());
  if (command === '/risk') return reply(chatId, [
    `سرمایه مبنا: ${core.formatNumber(CAPITAL_TOMAN)} تومان`,
    `بودجه هر ورود مستقل: ${core.formatNumber(ENTRY_BUDGET_TOMAN)} تومان (۶۰٪ سرمایه)`,
    `حد زیان برنامه‌ریزی‌شده: ${core.formatNumber(POSITION_STOP_PCT * 100)}٪ بهای تمام‌شده (در ورود ۳ میلیونی: ${core.formatNumber(ENTRY_BUDGET_TOMAN * POSITION_STOP_PCT)} تومان)`,
    `هدف سود اولیه: بیش از ${core.formatNumber(INITIAL_TARGET_PCT * 100)}٪ بهای تمام‌شده`,
    `حداقل نسبت سود به زیان: ۱ به ${core.formatNumber(MIN_RR, 1)}؛ با حد زیان ۲۰٪، هدف متناظر حداقل ۴۰٪ است.`,
    'بودجه هر ورود مستقل است؛ اما مجموع تعهدات باز و زیان هم‌زمان باید جداگانه پایش شود. خرید اختیار می‌تواند تمام پرمیوم را از بین ببرد؛ حد ۲۰٪ تضمین اجرای خروج نیست.'
  ].join('\n'));
  if (command === '/market' || command === '/scan' || command === '/debug') {
    await reply(chatId, command === '/debug' ? 'در حال آماده‌سازی گزارش فنی...' : 'در حال دریافت نمای بازار اختیار از سایت TSETMC / tse.ir...');
    try {
      const market = await getMarket(true);
      if (command === '/market') return reply(chatId, buildMarketText(market));
      if (command === '/scan') return reply(chatId, buildScanText(market));
      return reply(chatId, debugText(market));
    } catch (e) {
      return reply(chatId, `دریافت بازار ناموفق بود.\nدلیل: ${e.message}\n\nتا رفع خطا سیگنال صادر نمی‌شود.`);
    }
  }
  if (command === '/chain') {
    if (!symbol) return reply(chatId, 'نام نماد پایه را بنویس. مثال: /chain فولاد');
    try { const market = await getMarket(true); const resolved = await resolveUnderlying(symbol, market); return reply(chatId, buildChainText(symbol, market.options, resolved)); }
    catch (e) { return reply(chatId, `دریافت زنجیره ناموفق بود: ${e.message}`); }
  }
  if (command === '/analyze') {
    if (!symbol) return reply(chatId, 'نام نماد پایه را بنویس. مثال: /analyze فولاد');
    await reply(chatId, `در حال بررسی سهم پایه، سابقه قیمت، جریان حقیقی/حقوقی، اطلاعیه‌ها و قراردادهای اختیار «${symbol}»...`);
    try {
      const result = await analyzeSymbol(symbol);
      return reply(chatId, buildAnalysisText(result));
    } catch (e) { return reply(chatId, `تحلیل کامل نشد: ${e.message}\n\nبرای جلوگیری از نتیجه اشتباه، فعلاً سیگنال صادر نمی‌شود.`); }
  }
  if (command === '/signal' || command === '/strategy') {
    if (!symbol) return reply(chatId, `نام نماد پایه را بنویس. مثال: ${command} فولاد`);
    await reply(chatId, `در حال اجرای موتور تصمیم‌گیری چندلایه برای «${symbol}»؛ داده، خبر، تکنیکال، جریان معاملات، نقدشوندگی و ریسک بررسی می‌شود...`);
    try {
      const result = await analyzeSymbol(symbol);
      return reply(chatId, command === '/signal' ? buildSignalText(symbol, result) : buildStrategyText(symbol, result, chatId));
    } catch (e) {
      return reply(chatId, `تصمیم‌گیری کامل نشد: ${e.message}\nنتیجه: عدم معامله؛ تا رفع خطا هیچ سیگنالی صادر نمی‌شود.`);
    }
  }
  if (command === '/research') {
    const q = symbol || '';
    await reply(chatId, 'در حال بررسی منابع خبری و اطلاعیه‌های کدال؛ ممکن است بعضی منابع به علت محدودیت شبکه پاسخ ندهند...');
    const [codal, news] = await Promise.allSettled([researchSources.fetchCodal(q, 12), researchSources.fetchNews(q, 15)]);
    const lines = [`گزارش منابع بیرونی${q ? ` | ${q}` : ''}`, `زمان بررسی: ${new Date().toLocaleString('fa-IR',{timeZone:'Asia/Tehran'})}`];
    if (codal.status === 'fulfilled') { lines.push('', `کدال — ${codal.value.items.length} اطلاعیه`); for (const x of codal.value.items.slice(0,8)) lines.push(`• ${x.title}${x.date ? ` | ${x.date}`:''}${x.link ? `\n${x.link}`:''}`); }
    else lines.push('', `کدال پاسخ نداد: ${codal.reason.message}`);
    if (news.status === 'fulfilled') { lines.push('', `خبرگزاری‌ها — ${news.value.items.length} خبر`); for (const x of news.value.items.slice(0,8)) lines.push(`• ${x.title} | ${x.source}${x.date ? ` | ${x.date}`:''}${x.link ? `\n${x.link}`:''}`); if(news.value.errors.length) lines.push(`منابع ناموفق: ${news.value.errors.join('؛ ')}`); }
    else lines.push('', `خبرگزاری‌ها پاسخ ندادند: ${news.reason.message}`);
    lines.push('', 'این خروجی گردآوری خبر است، نه تأیید صحت ادعا یا سیگنال معاملاتی. زمان انتشار و متن اصلی هر خبر را پیش از تصمیم بررسی کن.');
    return reply(chatId, lines.join('\n').slice(0,3900));
  }
  if (command === '/position') {
    const sub = (parts.shift() || '').toLowerCase();
    if (sub === 'add') {
      if (parts.length < 8) return reply(chatId, 'فرمت ثبت:\n/position add فولاد نمادقرارداد call long 10000 1405/12/20 850 5\nنوع: call یا put | سمت: long یا short | قیمت ورود تومان | تعداد\nربات اندازه قرارداد را از زنجیره می‌خواند.');
      const [underlying, ticker, type, side, strike, expiry, entry, qty] = parts;
      try {
        const market = await getMarket(true);
        const option = market.options.find(o => core.normalizeSymbol(o.ticker) === core.normalizeSymbol(ticker) || String(o.insCode) === ticker);
        if (!option) return reply(chatId, 'قرارداد در زنجیره فعلی پیدا نشد؛ نماد دقیق قرارداد را از /chain بررسی کن.');
        if (option.type !== type) return reply(chatId, `نوع قراردادی که وارد کردی با زنجیره نمی‌خواند. نوع واقعی این نماد: ${option.type === 'call' ? 'Call' : 'Put'}`);
        const actualStrikeToman = option.strike / 10;
        if (Math.abs(actualStrikeToman - Number(strike)) > Math.max(1, actualStrikeToman * 0.001)) return reply(chatId, `قیمت اعمال واردشده با قرارداد تطبیق ندارد. قیمت اعمال ثبت‌شده در زنجیره: ${Math.round(actualStrikeToman)} تومان`);
        const resolvedBase = option.underlyingTicker || underlying;
        const p = positionManager.add({chatId, underlying: resolvedBase, optionTicker: option.ticker || option.insCode, type, side, strike: actualStrikeToman, expiry: option.endDate || expiry, entryToman: entry, quantity: qty, contractSize: option.contractSize});
        return reply(chatId, `موقعیت ثبت شد.\nشناسه: ${p.id}\n${underlying} | ${option.ticker} | ${type.toUpperCase()} | ${side}\nورود: ${entry} تومان | تعداد: ${qty}\nاندازه قرارداد: ${option.contractSize}\nپایش دستی و خودکار فعال است. برای بررسی: /position check ${p.id}`);
      } catch(e) { return reply(chatId, `ثبت موقعیت انجام نشد: ${e.message}`); }
    }
    if (sub === 'list') {
      const rows = positionManager.list(chatId, true);
      return reply(chatId, rows.length ? ['موقعیت‌های باز:', ...rows.map(p=>`${p.id} | ${p.underlying} | ${p.optionTicker} | ${p.side} ${p.type} | ورود ${p.entryToman} تومان | تعداد ${p.quantity}`)].join('\n') : 'موقعیت بازی ثبت نشده است.');
    }
    if (sub === 'close') {
      const p = positionManager.close(chatId, parts[0]);
      return reply(chatId, p ? `پرونده ${p.id} بسته شد. این دستور هیچ سفارش بورسی ثبت نکرد.` : 'شناسه موقعیت باز پیدا نشد.');
    }
    if (sub === 'check') {
      const rows = positionManager.list(chatId, true).filter(p=>!parts[0]||p.id.toLowerCase()===parts[0].toLowerCase());
      if (!rows.length) return reply(chatId, 'موقعیت بازی پیدا نشد. ابتدا /position list را بزن.');
      try {
        const market=await getMarket(true); const reports=[];
        for(const p of rows){
          const o=market.options.find(x=>core.normalizeSymbol(x.ticker)===core.normalizeSymbol(p.optionTicker)||String(x.insCode)===p.optionTicker);
          if(!o){reports.push(`موقعیت ${p.id}: قرارداد در زنجیره فعلی پیدا نشد؛ قیمت معتبر برای ارزیابی موجود نیست.`);continue;}
          let analysis=null;
          try { analysis=await analyzeSymbol(p.underlying); } catch(e) { analysis={error:e.message}; }
          reports.push(buildPositionManagementText(p,o,analysis));
        }
        return reply(chatId,reports.join('\n\n----------------\n\n').slice(0,3900));
      } catch(e){return reply(chatId,`بررسی موقعیت ناموفق بود: ${e.message}\nهیچ پیشنهاد قیمتی صادر نشد.`);}
    }
    return reply(chatId, 'دستورات: /position add ... | /position list | /position check [شناسه] | /position close شناسه');
  }
  if (command === '/news') {
    if (!symbol) return reply(chatId, 'نام نماد را بنویس. مثال: /news فولاد');
    try {
      const market = await getMarket();
      const resolved = await resolveUnderlying(symbol, market);
      if (!resolved.base?.code) return reply(chatId, `نماد «${symbol}» پیدا نشد.`);
      const raw = await safeFetch(`/Msg/GetMsgByInsCode/${resolved.base.code}`);
      if (raw.__error) return reply(chatId, `دریافت پیام ناظر ناموفق بود: ${raw.__error}`);
      return reply(chatId, buildNewsText(symbol, core.extractMessages(raw)));
    } catch (e) { return reply(chatId, `دریافت پیام‌ها ناموفق بود: ${e.message}`); }
  }
  return reply(chatId, 'این دستور را نمی‌شناسم. برای دیدن راهنما /help را بزن.');
}

// Automatic position monitor: alerts only; never places or changes orders.
const MONITOR_MS = Math.max(60000, Number(process.env.POSITION_MONITOR_INTERVAL_MS || 300000));
let monitorBusy = false;
async function monitorOpenPositions() {
  if (monitorBusy || !TOKEN) return;
  const open = positionManager.load().filter(p => p.status === 'open');
  if (!open.length) return;
  monitorBusy = true;
  try {
    const market = await getMarket(true);
    const alerts = positionManager.evaluateAll(market.options);
    for (const a of alerts) {
      const p=a.position,m=a.mark;
      await reply(Number(p.chatId), `هشدار پایش خودکار | ${p.id}\n${p.underlying} ${p.type.toUpperCase()} ${p.side}\nتغییر نسبت به بهای ورود: ${m.pct.toFixed(2)}٪\nسود/زیان باز برآوردی: ${Math.round(m.pnlToman).toLocaleString('en-US')} تومان\nقیمت خروج قابل مشاهده: ${Math.round(m.markToman).toLocaleString('en-US')} تومان\nاین هشدار دستور معامله نیست. برای بررسی کامل: /position check ${p.id}`);
    }
  } catch(e) { console.warn('Automatic position monitor failed:',e.message); }
  finally { monitorBusy=false; }
}
const monitorTimer=setInterval(monitorOpenPositions,MONITOR_MS); if(monitorTimer.unref)monitorTimer.unref();

app.get('/', (_req, res) => res.type('text').send(`Iran Options Assistant ${VERSION} is running`));
app.get('/health', (_req, res) => res.json({ ok: true, version: VERSION, uptime_seconds: Math.floor(process.uptime()), last_market_at: lastMarketAt ? new Date(lastMarketAt).toISOString() : null, last_market_error: lastMarketError }));
app.post('/telegram', async (req, res) => {
  if (SECRET && req.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) return res.sendStatus(401);
  res.sendStatus(200);
  const message = req.body && (req.body.message || req.body.edited_message);
  if (!message || !message.chat || !message.text) return;
  const chatId = String(message.chat.id);
  if (ALLOWED_CHAT_IDS.length && !ALLOWED_CHAT_IDS.includes(chatId)) return;
  try { await handleCommand(message.chat.id, message.text); }
  catch (err) { console.error('Telegram command failed:', err.message); }
});
app.use((err, _req, res, _next) => { console.error('HTTP error:', err.message); res.status(500).json({ ok: false, error: 'خطای داخلی سرویس' }); });

if (require.main === module) {
  if (!TOKEN) console.warn('WARNING: TELEGRAM_BOT_TOKEN is missing');
  app.listen(PORT, () => console.log(`Iran Options Assistant v${VERSION} running on ${PORT}`));
}

module.exports = { app, analyzeSymbol, handleCommand, getMarket, buildAnalysisText, buildMarketText, buildSignalText, buildStrategyText, buildDecision, monitorOpenPositions };
