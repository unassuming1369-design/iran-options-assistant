'use strict';

// Central decision layer. It never fabricates missing inputs and fails closed.
const TEHRAN_TZ = 'Asia/Tehran';
const MAX_MARKET_DATA_AGE_MS = 90 * 1000;
const MAX_QUOTE_AGE_MINUTES = 20;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function fmtDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TEHRAN_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(p => [p.type, p.value]));
}
function marketClock(now) {
  const p = fmtDateParts(now);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TEHRAN_TZ, weekday: 'short' }).format(now);
  const minuteOfDay = Number(p.hour) * 60 + Number(p.minute);
  const tradingDay = !['Fri', 'Sat'].includes(weekday);
  const open = tradingDay && minuteOfDay >= 9 * 60 && minuteOfDay <= 12 * 60 + 30;
  return { open, weekday, time: `${p.hour}:${p.minute}:${p.second}` };
}
function parseTsetmcStamp(dateValue, timeValue) {
  if (dateValue == null || timeValue == null) return null;
  const ds = String(dateValue).replace(/\D/g, '');
  const ts = String(timeValue).replace(/\D/g, '');
  if (ds.length !== 8 || ts.length < 1 || ts.length > 6) return null;
  const year = Number(ds.slice(0, 4)), month = Number(ds.slice(4, 6)), day = Number(ds.slice(6, 8));
  const t = ts.padStart(6, '0');
  const hour = Number(t.slice(0, 2)), minute = Number(t.slice(2, 4)), second = Number(t.slice(4, 6));
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  // TSETMC timestamps are interpreted as Tehran wall-clock time (UTC+03:30).
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute - 30, second));
}
function freshness(analysis, cfg) {
  const now = cfg.now instanceof Date ? cfg.now : new Date();
  const fetchedAt = cfg.marketFetchedAt ? new Date(cfg.marketFetchedAt) : null;
  const fetchAge = fetchedAt && Number.isFinite(fetchedAt.getTime()) ? now - fetchedAt : null;
  const quote = analysis.quote || {};
  const stamp = parseTsetmcStamp(quote.date, quote.time);
  const quoteAge = stamp ? now - stamp : null;
  const problems = [];
  if (fetchAge == null || fetchAge < -30000 || fetchAge > MAX_MARKET_DATA_AGE_MS)
    problems.push('زمان دریافت داده زنجیره نامعتبر یا قدیمی‌تر از ۹۰ ثانیه است.');
  if (!stamp) problems.push('تاریخ و ساعت آخرین قیمت سهم پایه از منبع قابل تأیید نیست.');
  else if (quoteAge < -5 * 60 * 1000 || quoteAge > MAX_QUOTE_AGE_MINUTES * 60 * 1000)
    problems.push('زمان آخرین قیمت سهم پایه بیش از حد قدیمی یا نامعتبر است.');
  return { ok: problems.length === 0, problems, fetchAgeMs: fetchAge, quoteAgeMs: quoteAge };
}
function liquidityStats(options) {
  const tradable = (options || []).filter(o =>
    o && o.strike > 0 && o.daysRemaining > 0 && o.contractSize > 0 &&
    o.bid > 0 && o.ask > 0 && o.ask >= o.bid &&
    (o.volume || 0) > 0 && (o.value || 0) > 0 &&
    (o.spreadPct == null || o.spreadPct <= 15) &&
    !(o.last != null && o.last <= 1 && !(o.volume > 0))
  );
  return { count: tradable.length, options: tradable };
}
function normalizeCandidate(c, kind) {
  if (kind === 'single') return {
    strategy: c.strategy, contract: c.option?.ticker,
    entryBasis: `قیمت عرضه ${c.option?.ask ?? 'نامشخص'} (واحد خام منبع؛ تبدیل ریال/تومان در موتور بر مبنای ریال)`,
    quantity: c.quantity, maxLoss: c.maxLoss, maxLossAtExpiry: c.maxLossAtExpiry ?? null, targetProfit: c.targetProfit, rr: c.rr,
    invalidation: c.option?.type === 'call' ? 'بسته‌شدن سهم پایه زیر حمایت سناریو یا از بین رفتن روند صعودی' : 'بسته‌شدن سهم پایه بالای مقاومت سناریو یا از بین رفتن روند نزولی'
  };
  if (kind === 'spread') return {
    strategy: c.strategy, contract: `${c.buy?.ticker} + ${c.sell?.ticker}`,
    entryBasis: `خرید روی عرضه و فروش روی تقاضا؛ خالص بدهی ${c.debit}`,
    quantity: c.quantity, maxLoss: c.maxLoss, targetProfit: c.maxProfit, rr: c.rr,
    invalidation: 'نقض جهت روند یا بسته‌شدن اسپرد از حد ریسک محاسبه‌شده'
  };
  return {
    strategy: c.strategy, contract: `${c.call?.ticker} + ${c.put?.ticker}`,
    entryBasis: `مجموع قیمت عرضه دو قرارداد: ${c.premium}`,
    quantity: c.quantity, maxLoss: c.maxLoss, maxLossAtExpiry: c.maxLossAtExpiry ?? null, targetProfit: c.targetProfit, rr: c.rr,
    invalidation: 'کاهش نوسان/گذشت زمان یا حرکت ناکافی سهم پایه؛ ریسک حداکثر برابر کل پرمیوم پرداختی است'
  };
}
function evaluate(a, cfg = {}) {
  const now = cfg.now instanceof Date ? cfg.now : new Date();
  const clock = marketClock(now);
  const fresh = freshness(a, cfg);
  const blockers = [...fresh.problems];
  if (!clock.open) blockers.push(`بازار در ساعت ${clock.time} تهران در بازه معاملاتی معمول نیست؛ ورود جدید صادر نمی‌شود.`);
  if (!a || a.error) blockers.push(a?.error || 'داده تحلیل نماد موجود نیست.');
  if (!(a?.spot > 0)) blockers.push('قیمت معتبر سهم پایه موجود نیست.');
  if (!a?.technical?.available || !['صعودی', 'نزولی'].includes(a?.technical?.direction))
    blockers.push('روند تکنیکال معتبر و جهت‌دار از تاریخچه کافی به دست نیامده است.');
  if (!a?.fundamentals?.available) blockers.push('اطلاعات بنیادی قابل اتکا از منبع متصل موجود نیست.');
  const liq = liquidityStats(a?.options || []);
  if (liq.count === 0) blockers.push('هیچ قرارداد دارای معامله، ارزش، عرضه و تقاضای معتبر و فاصله قیمت قابل قبول پیدا نشد.');
  const riskBudget = Math.max(0, (n(cfg.capitalToman) || 0) * (n(cfg.riskPct) || 0));
  const hardMax = Math.max(0, (n(cfg.capitalToman) || 0) * (n(cfg.maxRiskPct) || 0));
  const minRR = Math.max(2, n(cfg.minRR) || 2);
  const eligibleIds = new Set(liq.options.map(o => String(o.insCode || o.isin || o.ticker)));
  const eligible = o => !!o && eligibleIds.has(String(o.insCode || o.isin || o.ticker));
  const candidates = [];
  for (const c of a?.longCandidates || []) if (eligible(c.option) && c.rr >= minRR && c.maxLoss <= riskBudget && c.maxLoss <= hardMax)
    candidates.push(normalizeCandidate(c, 'single'));
  for (const c of a?.spreads || []) if (eligible(c.buy) && eligible(c.sell) && c.rr >= minRR && c.maxLoss <= riskBudget && c.maxLoss <= hardMax)
    candidates.push(normalizeCandidate(c, 'spread'));
  for (const c of a?.straddles || []) if (eligible(c.call) && eligible(c.put) && c.rr >= minRR && c.maxLoss <= riskBudget && c.maxLoss <= hardMax)
    candidates.push(normalizeCandidate(c, 'straddle'));
  const strategies = candidates.filter(c => c.quantity > 0 && c.maxLoss > 0 && c.targetProfit > 0)
    .sort((x, y) => y.rr - x.rr);
  if (!strategies.length) blockers.push('هیچ استراتژی با نسبت سود به زیان حداقل ۱:۲ و بودجه ریسک مجاز تأیید نشد.');
  const tech = a?.technical || {};
  const flow = a?.flow || {};
  const sentiment = a?.sentiment || {};
  const oiChanges = liq.options.filter(o => Number.isFinite(o.openInterestChange));
  const bookCount = liq.options.filter(o => o.book?.available || (o.bid > 0 && o.ask > 0)).length;
  const engines = {
    technical: tech.available ? `${tech.direction}؛ RSI=${tech.rsi14 ?? 'نامشخص'}؛ MACD=${tech.macd != null && tech.macdSignal != null ? (tech.macd > tech.macdSignal ? 'بالای سیگنال' : 'پایین سیگنال') : 'نامشخص'}؛ حجم نسبی=${tech.volumeRatio ?? 'نامشخص'}` : 'داده کافی نیست',
    fundamental: a?.fundamentals?.available ? 'فیلدهای پایه نماد برگشته؛ صورت‌های مالی کامل/ارزش‌گذاری مستقل در دسترس نیست' : 'داده دریافت نشد',
    flow: flow.available ? `خالص حقیقی ${flow.individualNet ?? 'نامشخص'} سهم؛ قدرت خریدار ${flow.buyerPower ?? 'نامشخص'}` : 'داده دریافت نشد',
    sentiment: (a?.news?.length || a?.codal?.length) ? `${sentiment.label || 'بدون برچسب'}؛ فقط کلیدواژه‌ای` : 'خبر معتبر در منابع متصل دریافت نشد',
    liquidity: `${liq.count} قرارداد واجد شرایط؛ دفتر سفارش در ${bookCount} قرارداد`,
    openInterest: oiChanges.length ? `${oiChanges.length} قرارداد دارای تغییر نسبت به snapshot قبلی؛ نشانه قطعی ورود پول نیست` : 'تاریخچه چند snapshot کافی نیست؛ جریان OI قابل تأیید نیست',
    putCall: a?.ratios?.volume == null ? 'نسبت حجم قابل محاسبه نیست' : `PCR حجمی ${a.ratios.volume.toFixed(2)}؛ به‌تنهایی جهت‌نما نیست`
  };
  let score = 0;
  if (tech.available && ['صعودی', 'نزولی'].includes(tech.direction)) score += 25;
  if (tech.volumeRatio != null && tech.volumeRatio >= 1) score += 5;
  if (a?.fundamentals?.available) score += 10;
  if (flow.available && flow.individualNet != null) score += 10;
  if (a?.news?.length || a?.codal?.length) score += 10;
  if (liq.count >= 3) score += 25; else if (liq.count > 0) score += 15;
  if (oiChanges.length >= 3) score += 5;
  if (bookCount > 0) score += 5;
  if (fresh.ok) score += 5;
  const direction = tech.direction || 'نامشخص';
  const candidate = strategies[0] || null;
  // A high component score must never conceal critical data blockers.
  if (!fresh.ok) score = Math.min(score, 45);
  if (!clock.open) score = Math.min(score, 55);
  if (!a?.fundamentals?.available) score = Math.min(score, 55);
  const scoreGate = score >= 60;
  if (!scoreGate) blockers.push('امتیاز شواهد به حداقل ۶۰ از ۱۰۰ نرسیده است.');
  const canSignal = blockers.length === 0 && candidate && scoreGate;
  return {
    symbol: a?.symbol || 'نامشخص', score: Math.min(100, score),
    decision: canSignal ? `سناریوی مشروط ${direction}` : 'عدم معامله',
    direction, strength: score >= 80 ? 'قوی' : score >= 60 ? 'متوسط' : 'ضعیف/ناکافی',
    dataStatus: fresh.ok ? 'داده تازه از نظر زمان دریافت و زمان قیمت پایه' : 'ناقص یا غیرقابل‌تأیید',
    marketStatus: clock.open ? 'در بازه معاملاتی معمول' : 'خارج از بازه معاملاتی معمول',
    reasons: canSignal ? ['هم‌جهتی روند، نقدشوندگی، داده تازه، نسبت سود به زیان و سقف ریسک بررسی شد؛ ورود فقط پس از کنترل قیمت لحظه‌ای کارگزاری.'] : ['برای جلوگیری از سیگنال ساختگی، یکی یا چند شرط ضروری برقرار نیست.', ...blockers.slice(0, 5)],
    blockers, engines, candidate: canSignal ? candidate : null, strategies: strategies.slice(0, 6)
  };
}
module.exports = { evaluate, marketClock, parseTsetmcStamp, freshness, liquidityStats };
