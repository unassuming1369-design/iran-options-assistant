'use strict';

/**
 * Iran Options Assistant v3
 * Telegram signals-only assistant for Iranian listed equity options.
 * IMPORTANT: TSETMC public endpoints are unofficial and may change or be blocked.
 * This code fails closed when fields, prices, timestamps, or assumptions are insufficient.
 */

const express = require('express');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const CFG = Object.freeze({
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  flow: String(process.env.TSETMC_FLOW || '1'),
  capitalToman: positive(process.env.CAPITAL_TOMAN, 5000000),
  riskPct: clamp(positive(process.env.RISK_PCT, 0.005), 0.001, 0.01),
  hardRiskPct: clamp(positive(process.env.MAX_RISK_PCT, 0.01), 0.005, 0.02),
  riskFreeRate: clamp(positive(process.env.RISK_FREE_RATE, 0.30), 0, 1),
  dividendYield: clamp(positive(process.env.DIVIDEND_YIELD, 0), 0, 1),
  cacheMs: clamp(positive(process.env.MARKET_CACHE_MS, 12000), 3000, 60000),
  maxSpreadPct: clamp(positive(process.env.MAX_SPREAD_PCT, 0.30), 0.05, 0.80),
  minOptionVolume: positive(process.env.MIN_OPTION_VOLUME, 1),
  maxHistorySymbols: Math.floor(clamp(positive(process.env.MAX_HISTORY_SYMBOLS, 10), 3, 25)),
  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || '',
  allowedChatIds: String(process.env.ALLOWED_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean),
});

const TSETMC = 'https://cdn.tsetmc.com/api';
const HTTP_TIMEOUT_MS = 16000;
const RETRIES = 2;
const chainCache = { at: 0, records: null, flowUsed: null, fields: [] };
const historyCache = new Map();
const chatMemory = new Map();
const chatMarketContext = new Map();
const chatWatchlists = new Map();
const lastChatCommand = new Map();

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function log(event, details = {}) {
  const safe = { ...details };
  delete safe.token; delete safe.secret; delete safe.authorization;
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...safe }));
}
function faNum(n, digits = 2) {
  if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return 'نامشخص';
  return Number(n).toLocaleString('fa-IR', { maximumFractionDigits: digits });
}
function faInt(n) { return n === null || n === undefined || n === '' ? 'نامشخص' : faNum(Math.round(Number(n) || 0), 0); }
function rialToToman(n) { return Number(n) / 10; }
function normalText(v) {
  return String(v ?? '').trim()
    .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
    .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ').toLowerCase();
}
function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  let s = String(v).trim()
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٬,،\s]/g, '').replace(/[−–]/g, '-');
  if (!s || s === '-' || s.toLowerCase() === 'null') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function getField(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  const map = new Map(Object.keys(obj).map(k => [k.toLowerCase(), obj[k]]));
  for (const name of names) {
    const v = map.get(String(name).toLowerCase());
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}
function numField(obj, names) { return toNumber(getField(obj, names)); }

function timingSafeStringEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

async function fetchJson(url, { timeout = HTTP_TIMEOUT_MS, retries = RETRIES } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
          'Referer': 'https://www.tsetmc.com/'
        },
        signal: controller.signal
      });
      const body = await response.text();
      if (response.status === 429) throw new Error('TSETMC_RATE_LIMIT_429');
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      if (/General Error Detected|دسترسی شما|مسدود/i.test(body)) throw new Error('TSETMC_BLOCKED');
      let json;
      try { json = JSON.parse(body); } catch { throw new Error('TSETMC_NON_JSON_RESPONSE'); }
      return json;
    } catch (err) {
      lastError = err;
      if (attempt < retries && !String(err.message).includes('429') && !String(err.message).includes('BLOCKED')) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('TSETMC_FETCH_FAILED');
}

function findObjectArray(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length && value.some(x => x && typeof x === 'object' && !Array.isArray(x))) {
      const sample = value.find(x => x && typeof x === 'object');
      const keys = Object.keys(sample || {}).map(k => k.toLowerCase());
      if (keys.some(k => k.includes('inscode_p') || k.includes('strikeprice') || k.includes('inscode_c'))) return value;
    }
    for (const item of value) {
      const found = findObjectArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const preferred = [
      'instrumentoptionmarketwatch', 'instrumentoptionmarketwatchdto',
      'optionmarketwatch', 'data', 'result'
    ];
    for (const key of preferred) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const found = findObjectArray(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const child of Object.values(value)) {
      const found = findObjectArray(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchOptionChain(force = false) {
  if (!force && chainCache.records && Date.now() - chainCache.at < CFG.cacheMs) {
    return { ...chainCache, cached: true };
  }
  const flows = CFG.flow === '0' ? ['0', '1', '2'] : [CFG.flow, '0'];
  const merged = new Map();
  let fields = [];
  let flowUsed = [];
  let errors = [];

  for (const flow of [...new Set(flows)]) {
    try {
      const raw = await fetchJson(`${TSETMC}/Instrument/GetInstrumentOptionMarketWatch/${encodeURIComponent(flow)}`);
      const rows = findObjectArray(raw);
      if (!rows) {
        errors.push(`flow ${flow}: schema not recognized`);
        continue;
      }
      if (rows.length) {
        fields = Object.keys(rows[0]);
        for (const row of rows) {
          const p = getField(row, ['insCode_P']);
          const c = getField(row, ['insCode_C']);
          const key = `${p || ''}:${c || ''}:${getField(row, ['strikePrice']) || ''}:${getField(row, ['endDate']) || ''}`;
          if (key !== ':::') merged.set(key, row);
        }
        flowUsed.push(flow);
      }
      if (flow === CFG.flow && rows.length > 0) break;
    } catch (err) {
      errors.push(`flow ${flow}: ${err.message}`);
      if (String(err.message).includes('429') || String(err.message).includes('BLOCKED')) break;
    }
  }

  const records = [...merged.values()];
  if (!records.length) {
    throw new Error(`هیچ رکورد معتبری از TSETMC دریافت نشد. ${errors.join(' | ') || 'پاسخ خالی بود'}`);
  }
  chainCache.at = Date.now();
  chainCache.records = records;
  chainCache.flowUsed = flowUsed.join(',');
  chainCache.fields = fields;
  log('option_chain_loaded', { count: records.length, flows: chainCache.flowUsed, errors: errors.length });
  return { ...chainCache, cached: false, errors };
}

function sideFromRow(row, side) {
  const suffix = `_${side}`;
  const code = getField(row, [`insCode${suffix}`]);
  if (!code) return null;
  const price = numField(row, [`pDrCotVal${suffix}`, `pClosing${suffix}`]);
  const close = numField(row, [`pClosing${suffix}`]);
  const bid = numField(row, [`pMeDem${suffix}`]);
  const ask = numField(row, [`pMeOf${suffix}`]);
  const volume = numField(row, [`qTotTran5J${suffix}`]) ?? 0;
  const trades = numField(row, [`zTotTran${suffix}`]) ?? 0;
  const value = numField(row, [`qTotCap${suffix}`, `notionalValue${suffix}`]) ?? 0;
  const oi = numField(row, [`oP${suffix}`, `marketSameRiskOP${suffix}`, `yesterdayOP${suffix}`]);
  const bidQty = numField(row, [`qTitMeDem${suffix}`]);
  const askQty = numField(row, [`qTitMeOf${suffix}`]);
  const symbol = getField(row, [`lVal18AFC${suffix}`]) || getField(row, [`lVal30${suffix}`]) || String(code);
  const fullName = getField(row, [`lVal30${suffix}`]) || symbol;
  const validBidAsk = bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid;
  const mid = validBidAsk ? (bid + ask) / 2 : (price && price > 0 ? price : close);
  const spreadPct = validBidAsk && mid > 0 ? (ask - bid) / mid : null;
  return {
    side, code: String(code), symbol: String(symbol), fullName: String(fullName),
    price, close, bid, ask, bidQty, askQty, mid,
    volume, trades, value, openInterest: oi,
    validBidAsk, spreadPct,
    yesterday: numField(row, [`priceYesterday${suffix}`])
  };
}

function normalizeOptionRows(records) {
  const out = [];
  for (const row of records) {
    const underlyingCode = getField(row, ['ualInsCode', 'underlyingInsCode', 'insCode_UA']);
    const underlyingName = getField(row, ['lVal30_UA', 'lVal18AFC_UA', 'underlyingName']) || 'نامشخص';
    const spot = numField(row, ['pDrCotVal_UA', 'pClosing_UA']);
    const spotClose = numField(row, ['pClosing_UA']);
    const prevSpot = numField(row, ['priceYesterday_UA']);
    const strike = numField(row, ['strikePrice']);
    const days = numField(row, ['remainedDay']);
    const size = numField(row, ['contractSize']);
    const expiry = getField(row, ['endDate']);
    const begin = getField(row, ['beginDate']);
    if (!underlyingCode || !(spot > 0) || !(strike > 0) || !(size > 0) || !(days >= 0)) continue;
    const changePct = prevSpot > 0 ? ((spot - prevSpot) / prevSpot) * 100 : null;
    for (const side of ['C', 'P']) {
      const option = sideFromRow(row, side);
      if (!option) continue;
      const premium = option.mid ?? option.close ?? option.price;
      if (!(premium > 0)) continue;
      const intrinsic = side === 'C' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
      const timeValue = Math.max(0, premium - intrinsic);
      const t = Math.max(0, days) / 365;
      const iv = t > 0 ? impliedVolatility(premium, spot, strike, t, CFG.riskFreeRate, CFG.dividendYield, side) : null;
      const greeks = iv !== null ? blackScholesGreeks(spot, strike, t, CFG.riskFreeRate, CFG.dividendYield, iv, side) : null;
      const breakeven = side === 'C' ? strike + premium : strike - premium;
      out.push({
        ...option,
        side,
        underlyingCode: String(underlyingCode),
        underlyingName: String(underlyingName),
        spot, spotClose, prevSpot, changePct,
        strike, days, size, expiry: expiry ? String(expiry) : 'نامشخص', begin: begin ? String(begin) : 'نامشخص',
        intrinsic, timeValue, iv, greeks, breakeven,
        breakEvenPct: side === 'C' ? ((breakeven / spot) - 1) * 100 : ((breakeven / spot) - 1) * 100,
        sourceFetchedAt: new Date().toISOString()
      });
    }
  }
  return out;
}

function normalPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}
function bsPrice(S, K, T, r, q, sigma, side) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const volT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / volT;
  const d2 = d1 - volT;
  if (side === 'C') return S * Math.exp(-q * T) * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2);
  return K * Math.exp(-r * T) * normalCdf(-d2) - S * Math.exp(-q * T) * normalCdf(-d1);
}
function impliedVolatility(price, S, K, T, r, q, side) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  const intrinsic = side === 'C' ? Math.max(0, S - K * Math.exp(-r * T)) : Math.max(0, K * Math.exp(-r * T) - S);
  if (price < intrinsic * 0.90) return null;
  let lo = 0.001, hi = 5;
  const pLo = bsPrice(S, K, T, r, q, lo, side);
  const pHi = bsPrice(S, K, T, r, q, hi, side);
  if (price < pLo - 1e-8 || price > pHi + 1e-8) return null;
  for (let i = 0; i < 70; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(S, K, T, r, q, mid, side);
    if (p > price) hi = mid; else lo = mid;
  }
  const iv = (lo + hi) / 2;
  return iv >= 0.01 && iv <= 4 ? iv : null;
}
function blackScholesGreeks(S, K, T, r, q, sigma, side) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const deltaCall = Math.exp(-q * T) * normalCdf(d1);
  const delta = side === 'C' ? deltaCall : deltaCall - Math.exp(-q * T);
  const gamma = Math.exp(-q * T) * normalPdf(d1) / (S * sigma * sqrtT);
  const vega = S * Math.exp(-q * T) * normalPdf(d1) * sqrtT / 100;
  const common = -(S * Math.exp(-q * T) * normalPdf(d1) * sigma) / (2 * sqrtT);
  const thetaCall = (common - r * K * Math.exp(-r * T) * normalCdf(d2) + q * S * Math.exp(-q * T) * normalCdf(d1)) / 365;
  const thetaPut = (common + r * K * Math.exp(-r * T) * normalCdf(-d2) - q * S * Math.exp(-q * T) * normalCdf(-d1)) / 365;
  const rhoCall = K * T * Math.exp(-r * T) * normalCdf(d2) / 100;
  const rhoPut = -K * T * Math.exp(-r * T) * normalCdf(-d2) / 100;
  return { delta, gamma, thetaPerDay: side === 'C' ? thetaCall : thetaPut, vegaPer1Pct: vega, rhoPer1Pct: side === 'C' ? rhoCall : rhoPut };
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) result = values[i] * k + result * (1 - k);
  return result;
}
function emaSeries(values, period) {
  if (values.length < period) return [];
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let current = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = current;
  for (let i = period; i < values.length; i++) {
    current = values[i] * k + current * (1 - k);
    out[i] = current;
  }
  return out;
}
function calcRsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function normalizeHistory(raw) {
  const arr = findDailyArray(raw);
  if (!arr) return [];
  const out = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const close = numField(row, ['pClosing', 'pc', 'close', 'closingPrice', 'pDrCotVal']);
    if (!(close > 0)) continue;
    const high = numField(row, ['priceMax', 'pMax', 'high']) || close;
    const low = numField(row, ['priceMin', 'pMin', 'low']) || close;
    const volume = numField(row, ['qTotTran5J', 'tvol', 'volume', 'qTotTran']) || 0;
    const date = numField(row, ['dEven', 'date', 'deven', 'dateInt']) || 0;
    out.push({ date, close, high, low, volume });
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}
function findDailyArray(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    if (value.length && value.some(x => x && typeof x === 'object')) {
      const sample = value.find(x => x && typeof x === 'object');
      const keys = Object.keys(sample || {}).map(k => k.toLowerCase());
      if (keys.some(k => ['pclosing', 'pc', 'closingprice', 'pdr cotval', 'pdrcotval'].includes(k)) || keys.some(k => k.includes('deven'))) return value;
    }
    for (const x of value) { const found = findDailyArray(x, depth + 1); if (found) return found; }
  } else if (typeof value === 'object') {
    for (const x of Object.values(value)) { const found = findDailyArray(x, depth + 1); if (found) return found; }
  }
  return null;
}
async function getUnderlyingHistory(insCode, force = false) {
  const key = String(insCode);
  const cached = historyCache.get(key);
  if (!force && cached && Date.now() - cached.at < 20 * 60 * 1000) return cached;
  const raw = await fetchJson(`${TSETMC}/ClosingPrice/GetClosingPriceDailyList/${encodeURIComponent(key)}/60`);
  const rows = normalizeHistory(raw);
  if (rows.length < 25) throw new Error(`تاریخچه کافی نیست (${rows.length} رکورد)`);
  const result = { at: Date.now(), rows, indicators: technicalIndicators(rows) };
  historyCache.set(key, result);
  return result;
}
function technicalIndicators(rows) {
  const c = rows.map(x => x.close);
  const last = c[c.length - 1];
  const e9 = ema(c, 9), e21 = ema(c, 21), e50 = ema(c, 50);
  const fastSeries = emaSeries(c, 12);
  const slowSeries = emaSeries(c, 26);
  const macdSeries = c.map((_, i) => fastSeries[i] !== null && slowSeries[i] !== null ? fastSeries[i] - slowSeries[i] : null).filter(x => x !== null);
  const macd = macdSeries.length ? macdSeries.at(-1) : null;
  const signal = macdSeries.length >= 9 ? ema(macdSeries, 9) : null;
  const hist = macd !== null && signal !== null ? macd - signal : null;
  const rsi = calcRsi(c, 14);
  const prev = c.length > 1 ? c[c.length - 2] : null;
  const dailyChangePct = prev > 0 ? ((last / prev) - 1) * 100 : null;
  const mean20 = c.length >= 20 ? c.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const sd20 = mean20 !== null ? Math.sqrt(c.slice(-20).reduce((s, x) => s + Math.pow(x - mean20, 2), 0) / 20) : null;
  const atr = rows.length >= 15 ? rows.slice(-14).reduce((s, x, j) => { const prev = rows[rows.length - 15 + j]?.close ?? x.close; return s + Math.max(x.high - x.low, Math.abs(x.high - prev), Math.abs(x.low - prev)); }, 0) / 14 : null;
  const volNow = rows.at(-1)?.volume || 0;
  const volAvg20 = rows.length >= 20 ? rows.slice(-20).reduce((s, x) => s + x.volume, 0) / 20 : null;
  const bullish = e9 !== null && e21 !== null && e9 > e21 && last > e21 && hist !== null && hist > 0;
  const bearish = e9 !== null && e21 !== null && e9 < e21 && last < e21 && hist !== null && hist < 0;
  return { last, e9, e21, e50, macd, signal, hist, rsi, dailyChangePct, bbUpper: mean20 !== null ? mean20 + 2 * sd20 : null, bbLower: mean20 !== null ? mean20 - 2 * sd20 : null, atr, volNow, volAvg20, bullish, bearish, observations: rows.length };
}

function contractQuality(o) {
  const reasons = [];
  if (!(o.days >= 4 && o.days <= 120)) reasons.push('سررسید خارج از بازه ۴ تا ۱۲۰ روز');
  if (!(o.size > 0)) reasons.push('اندازه قرارداد نامعتبر');
  if (!(o.spot > 0 && o.strike > 0)) reasons.push('قیمت دارایی پایه یا اعمال نامعتبر');
  if (!o.validBidAsk) reasons.push('بهترین سفارش خرید/فروش معتبر نیست');
  if (o.spreadPct === null || o.spreadPct > CFG.maxSpreadPct) reasons.push('فاصله خرید و فروش زیاد یا نامشخص');
  if (o.volume < CFG.minOptionVolume && o.trades <= 0) reasons.push('حجم/تعداد معامله کافی نیست');
  if (!(o.ask > 0)) reasons.push('قیمت عرضه برای ورود خرید موجود نیست');
  return { ok: reasons.length === 0, reasons };
}
function debitRisk(o, entryPrice = o.ask) {
  if (!(entryPrice > 0 && o.size > 0)) return null;
  const perContractToman = rialToToman(entryPrice * o.size);
  const riskBudget = CFG.capitalToman * CFG.riskPct;
  const hardBudget = CFG.capitalToman * CFG.hardRiskPct;
  const riskQty = Math.floor(riskBudget / perContractToman);
  const capQty = Math.floor(CFG.capitalToman / perContractToman);
  const qty = Math.max(0, Math.min(riskQty, capQty));
  return {
    perContractToman,
    riskBudgetToman: riskBudget,
    hardBudgetToman: hardBudget,
    contracts: qty,
    totalDebitToman: qty * perContractToman,
    maxLossToman: qty * perContractToman,
    fitsRisk: qty >= 1 && perContractToman <= hardBudget
  };
}
function scoreOption(o, indicators) {
  const quality = contractQuality(o);
  let score = 0;
  const reasons = [];
  if (quality.ok) { score += 30; reasons.push('نقدشوندگی/قیمت قابل‌قبول'); }
  else reasons.push(...quality.reasons);
  if (o.days >= 15 && o.days <= 60) { score += 15; reasons.push('زمان تا سررسید متعادل'); }
  else if (o.days >= 8 && o.days <= 90) score += 8;
  if (o.iv !== null) {
    if (o.iv <= 0.45) { score += 10; reasons.push('IV مدل‌شده پایین‌تر'); }
    else if (o.iv <= 0.80) score += 5;
    else reasons.push('IV مدل‌شده بالا');
  } else reasons.push('IV قابل محاسبه نیست');
  const d = o.greeks?.delta;
  if (d !== undefined && d !== null) {
    const absD = Math.abs(d);
    if (absD >= 0.35 && absD <= 0.70) { score += 10; reasons.push('دلتا در محدوده میانه'); }
    else if (absD >= 0.20 && absD <= 0.80) score += 5;
  }
  if (indicators) {
    if (o.side === 'C' && indicators.bullish) { score += 25; reasons.push('روند تکنیکال صعودی'); }
    else if (o.side === 'P' && indicators.bearish) { score += 25; reasons.push('روند تکنیکال نزولی'); }
    else if (o.side === 'C' && indicators.e9 > indicators.e21) score += 8;
    else if (o.side === 'P' && indicators.e9 < indicators.e21) score += 8;
    if (indicators.rsi !== null && indicators.rsi >= 35 && indicators.rsi <= 70) score += 5;
    if (indicators.rsi !== null && ((o.side === 'C' && indicators.rsi > 78) || (o.side === 'P' && indicators.rsi < 22))) {
      score -= 12; reasons.push('RSI در ناحیه افراطی');
    }
  } else {
    reasons.push('تاریخچه سهم پایه دریافت نشده؛ امتیاز تکنیکال ناقص است');
  }
  const risk = debitRisk(o);
  if (risk?.fitsRisk) { score += 5; reasons.push('با بودجه ریسک قابل خرید است'); }
  else { score -= 10; reasons.push('حتی یک قرارداد در بودجه ریسک جا نمی‌شود'); }
  return { score: clamp(score, 0, 100), quality, risk, reasons };
}
function optionName(o) { return `${o.symbol} (${o.side === 'C' ? 'Call' : 'Put'})`; }
function formatContract(o, scored = null) {
  const risk = scored?.risk || debitRisk(o);
  const g = o.greeks;
  const lines = [
    `نماد: ${o.symbol}`,
    `دارایی پایه: ${o.underlyingName}`,
    `نوع: ${o.side === 'C' ? 'اختیار خرید (Call)' : 'اختیار فروش (Put)'}`,
    `قیمت اعمال: ${faInt(o.strike)} ریال | سررسید: ${o.expiry} | روز باقی‌مانده: ${faInt(o.days)}`,
    `قیمت پایه: ${faInt(o.spot)} ریال | پریمیوم عرضه: ${faInt(o.ask)} ریال | تقاضا: ${faInt(o.bid)} ریال`,
    `اندازه قرارداد: ${faInt(o.size)} | حجم: ${faInt(o.volume)} | معاملات: ${faInt(o.trades)} | موقعیت باز: ${o.openInterest === null ? 'نامشخص' : faInt(o.openInterest)}`,
    `ارزش ذاتی: ${faInt(o.intrinsic)} ریال | ارزش زمانی تقریبی: ${faInt(o.timeValue)} ریال`,
    `سربه‌سر در سررسید: ${faInt(o.breakeven)} ریال به ازای هر سهم`,
    `IV ضمنی مدل‌شده: ${o.iv === null ? 'قابل محاسبه نیست' : faNum(o.iv * 100, 1) + '%'}`,
    g ? `یونانی‌های تقریبی: دلتا ${faNum(g.delta, 3)} | گاما ${faNum(g.gamma, 5)} | تتای روزانه ${faNum(g.thetaPerDay, 3)} | وگا/۱٪ ${faNum(g.vegaPer1Pct, 3)}` : 'یونانی‌ها: قابل محاسبه نیست',
    `اسپرد سفارش: ${o.spreadPct === null ? 'نامشخص' : faNum(o.spreadPct * 100, 1) + '%'}`,
    `هزینه یک قرارداد: ${risk ? faInt(risk.perContractToman) + ' تومان' : 'نامشخص'}`,
    `تعداد قابل خرید با ریسک هدف: ${risk ? faInt(risk.contracts) : 'نامشخص'}`,
    `امتیاز الگوریتم: ${scored ? faInt(scored.score) + '/100' : 'ارزیابی نشده'}`
  ];
  return lines.join('\n');
}

function groupUnderlyings(options) {
  const map = new Map();
  for (const o of options) {
    if (!map.has(o.underlyingCode)) map.set(o.underlyingCode, { code: o.underlyingCode, name: o.underlyingName, options: [], turnover: 0 });
    const g = map.get(o.underlyingCode);
    g.options.push(o);
    g.turnover += Math.max(0, o.value || 0);
  }
  return [...map.values()];
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (error) { results[i] = { error: error.message, item: items[i] }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function scanMarket({ force = false, query = '' } = {}) {
  const fetched = await fetchOptionChain(force);
  const options = normalizeOptionRows(fetched.records);
  if (!options.length) throw new Error('داده دریافت شد، اما هیچ قرارداد با ساختار قابل تشخیص پیدا نشد.');
  const groups = groupUnderlyings(options);
  const q = normalText(query);
  const filteredGroups = q ? groups.filter(g => normalText(g.name).includes(q) || g.options.some(o => normalText(o.symbol).includes(q) || normalText(o.fullName).includes(q))) : groups;
  if (!filteredGroups.length) return { fetched, options, groups, candidates: [], analyses: [], noMatch: true };

  // Fetch daily history for the most actively traded underlyings only; do not overload TSETMC.
  const historyTargets = [...filteredGroups].sort((a, b) => b.turnover - a.turnover).slice(0, q ? 1 : CFG.maxHistorySymbols);
  const historyResults = await mapLimit(historyTargets, 2, async g => ({
    code: g.code,
    name: g.name,
    ...(await getUnderlyingHistory(g.code, false))
  }));
  const indicatorMap = new Map();
  for (const item of historyResults) if (!item.error) indicatorMap.set(item.code, item.indicators);

  const candidates = [];
  for (const g of filteredGroups) {
    const inds = indicatorMap.get(g.code) || null;
    for (const o of g.options) {
      const scored = scoreOption(o, inds);
      const quality = scored.quality;
      const hasTrend = inds && (o.side === 'C' ? inds.bullish : inds.bearish);
      const signal = quality.ok && hasTrend && scored.score >= 70 && scored.risk?.fitsRisk && o.iv !== null && Boolean(o.greeks && Number.isFinite(o.greeks.delta));
      candidates.push({ option: o, indicators: inds, ...scored, signal });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const spreadStrategies = buildSpreadStrategies(filteredGroups.flatMap(g => g.options), indicatorMap);
  return { fetched, options, groups: filteredGroups, candidates, spreadStrategies, analyses: historyResults, historyChecked: indicatorMap.size, noMatch: false };
}

function buildSpreadStrategies(options, indicatorMap) {
  const groups = new Map();
  for (const o of options) {
    const key = `${o.underlyingCode}|${o.expiry}|${o.days}|${o.size}`;
    if (!groups.has(key)) groups.set(key, { underlying: o.underlyingName, code: o.underlyingCode, expiry: o.expiry, days: o.days, size: o.size, calls: [], puts: [] });
    groups.get(key)[o.side === 'C' ? 'calls' : 'puts'].push(o);
  }
  const output = [];
  for (const g of groups.values()) {
    const inds = indicatorMap.get(g.code) || null;
    // Bull call debit spread: buy lower strike, sell higher strike.
    const calls = g.calls.filter(x => x.validBidAsk && x.ask > 0 && x.bid > 0 && x.spreadPct <= CFG.maxSpreadPct);
    for (const long of calls) {
      for (const short of calls) {
        if (short.strike <= long.strike || short.code === long.code) continue;
        const debit = long.ask - short.bid;
        const width = short.strike - long.strike;
        if (!(debit > 0 && debit < width)) continue;
        const perContract = rialToToman(debit * g.size);
        const riskBudget = CFG.capitalToman * CFG.riskPct;
        const qty = Math.max(0, Math.min(Math.floor(riskBudget / perContract), Math.floor(CFG.capitalToman / perContract)));
        const directional = Boolean(inds?.bullish);
        const score = (directional ? 40 : 0) + (g.days >= 15 && g.days <= 75 ? 15 : 5) + (long.iv !== null && long.iv < 0.8 ? 10 : 0) + (long.volume > 0 && short.volume > 0 ? 10 : 0) + (qty > 0 ? 10 : 0);
        output.push({ type: 'Bull Call Spread', underlying: g.underlying, expiry: g.expiry, days: g.days, long, short, debit, width, maxLossPerContractToman: perContract, maxProfitPerContractToman: rialToToman((width - debit) * g.size), maxLossToman: perContract * qty, maxProfitToman: rialToToman((width - debit) * g.size) * qty, breakEven: long.strike + debit, quantity: qty, score, trendOk: directional });
      }
    }
    // Bear put debit spread: buy higher strike, sell lower strike.
    const puts = g.puts.filter(x => x.validBidAsk && x.ask > 0 && x.bid > 0 && x.spreadPct <= CFG.maxSpreadPct);
    for (const long of puts) {
      for (const short of puts) {
        if (short.strike >= long.strike || short.code === long.code) continue;
        const debit = long.ask - short.bid;
        const width = long.strike - short.strike;
        if (!(debit > 0 && debit < width)) continue;
        const perContract = rialToToman(debit * g.size);
        const riskBudget = CFG.capitalToman * CFG.riskPct;
        const qty = Math.max(0, Math.min(Math.floor(riskBudget / perContract), Math.floor(CFG.capitalToman / perContract)));
        const directional = Boolean(inds?.bearish);
        const score = (directional ? 40 : 0) + (g.days >= 15 && g.days <= 75 ? 15 : 5) + (long.iv !== null && long.iv < 0.8 ? 10 : 0) + (long.volume > 0 && short.volume > 0 ? 10 : 0) + (qty > 0 ? 10 : 0);
        output.push({ type: 'Bear Put Spread', underlying: g.underlying, expiry: g.expiry, days: g.days, long, short, debit, width, maxLossPerContractToman: perContract, maxProfitPerContractToman: rialToToman((width - debit) * g.size), maxLossToman: perContract * qty, maxProfitToman: rialToToman((width - debit) * g.size) * qty, breakEven: long.strike - debit, quantity: qty, score, trendOk: directional });
      }
    }
    // Long straddle: same strike, expiry, and contract size.
    for (const c of g.calls) {
      const p = g.puts.find(x => x.strike === c.strike && x.validBidAsk && c.validBidAsk && x.ask > 0 && c.ask > 0);
      if (!p) continue;
      const debit = c.ask + p.ask;
      const perContract = rialToToman(debit * g.size);
      const qty = Math.max(0, Math.min(Math.floor((CFG.capitalToman * CFG.riskPct) / perContract), Math.floor(CFG.capitalToman / perContract)));
      const score = (c.days >= 15 && c.days <= 75 ? 15 : 5) + (c.volume > 0 && p.volume > 0 ? 10 : 0) + (qty > 0 ? 10 : 0) + (c.iv !== null && p.iv !== null && (c.iv + p.iv) / 2 < 0.8 ? 10 : 0);
      output.push({ type: 'Long Straddle', underlying: g.underlying, expiry: g.expiry, days: g.days, call: c, put: p, debit, maxLossPerContractToman: perContract, maxLossToman: perContract * qty, upperBreakEven: c.strike + debit, lowerBreakEven: c.strike - debit, quantity: qty, score, trendOk: false });
    }
  }
  return output.sort((a, b) => b.score - a.score).slice(0, 10);
}

async function fetchClientFlow(insCode) {
  const raw = await fetchJson(`${TSETMC}/ClientType/GetClientType/${encodeURIComponent(insCode)}/1/0`);
  const row = findFirstObject(raw);
  if (!row) throw new Error('ساختار حقیقی/حقوقی قابل تشخیص نیست');
  const buyI = numField(row, ['buy_I_Volume', 'buyIVolume', 'buy_VolumeI', 'buyVolI']);
  const sellI = numField(row, ['sell_I_Volume', 'sellIVolume', 'sell_VolumeI', 'sellVolI']);
  const buyN = numField(row, ['buy_N_Volume', 'buyNVolume', 'buy_VolumeN', 'buyVolN']);
  const sellN = numField(row, ['sell_N_Volume', 'sellNVolume', 'sell_VolumeN', 'sellVolN']);
  return {
    buyI, sellI, buyN, sellN,
    netI: buyI !== null && sellI !== null ? buyI - sellI : null,
    netN: buyN !== null && sellN !== null ? buyN - sellN : null,
    rawKeys: Object.keys(row)
  };
}
function findFirstObject(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    for (const x of value) { if (x && typeof x === 'object') return x; }
    return null;
  }
  if (typeof value === 'object') {
    const vals = Object.values(value);
    if (Object.keys(value).length && !vals.some(x => Array.isArray(x) || (x && typeof x === 'object'))) return value;
    for (const x of vals) { const found = findFirstObject(x, depth + 1); if (found) return found; }
  }
  return null;
}
async function fetchBestLimits(insCode) {
  const raw = await fetchJson(`${TSETMC}/BestLimits/${encodeURIComponent(insCode)}`);
  const rows = findAnyArray(raw) || (Array.isArray(raw) ? raw : []);
  const clean = [];
  for (const row of rows.slice(0, 5)) {
    const bid = numField(row, ['pd', 'pMeDem', 'bidPrice']);
    const ask = numField(row, ['po', 'pMeOf', 'askPrice']);
    const bidQty = numField(row, ['qd', 'qTitMeDem', 'bidVolume']);
    const askQty = numField(row, ['qo', 'qTitMeOf', 'askVolume']);
    if (bid !== null || ask !== null) clean.push({ bid, ask, bidQty, askQty });
  }
  return clean;
}
async function fetchSupervisorMessages(insCode) {
  const raw = await fetchJson(`${TSETMC}/Msg/GetMsgByInsCode/${encodeURIComponent(insCode)}`, { timeout: 12000, retries: 1 });
  const rows = findAnyArray(raw) || [];
  return rows.slice(0, 6).map(x => ({
    title: getField(x, ['msgTitle', 'title', 'messageTitle', 'msg', 'message', 'lTitle']) || '',
    date: getField(x, ['dEven', 'date', 'publishDateTime']) || '',
    time: getField(x, ['hEven', 'time']) || ''
  })).filter(x => x.title);
}

async function fetchCodalFilings(symbol) {
  const url = new URL('https://search.codal.ir/api/search/v2/q');
  url.searchParams.set('Symbol', symbol);
  url.searchParams.set('PageNumber', '1');
  url.searchParams.set('PageSize', '10');
  const raw = await fetchJson(url.toString(), { timeout: 12000, retries: 1 });
  const arrays = findArrayWithKeys(raw, ['title', 'tracingno', 'publishdatetime']) || [];
  if (!arrays.length) return [];
  return arrays.slice(0, 8).map(x => ({
    title: getField(x, ['Title', 'title']) || 'عنوان نامشخص',
    publish: getField(x, ['PublishDateTime', 'publishDateTime', 'PublishDate', 'DateTime']) || '',
    trace: getField(x, ['TracingNo', 'tracingNo']) || '',
    url: getField(x, ['Url', 'url', 'LetterUrl', 'letterUrl']) || ''
  }));
}
function findAnyArray(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') {
    for (const x of Object.values(value)) { const found = findAnyArray(x, depth + 1); if (found) return found; }
  }
  return null;
}
function findArrayWithKeys(value, required, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (Array.isArray(value)) {
    const sample = value.find(x => x && typeof x === 'object');
    if (sample) {
      const keys = Object.keys(sample).map(k => k.toLowerCase());
      if (required.some(k => keys.includes(k))) return value;
    }
    for (const x of value) { const found = findArrayWithKeys(x, required, depth + 1); if (found) return found; }
  } else if (typeof value === 'object') {
    for (const x of Object.values(value)) { const found = findArrayWithKeys(x, required, depth + 1); if (found) return found; }
  }
  return null;
}

function strategyGuide() {
  return [
    'راهبردهای قابل پشتیبانی در موتور محاسباتی:',
    '۱) خرید Call: زیان حداکثر = پریمیوم پرداختی؛ سربه‌سر = قیمت اعمال + پریمیوم.',
    '۲) خرید Put: زیان حداکثر = پریمیوم پرداختی؛ سربه‌سر = قیمت اعمال - پریمیوم.',
    '۳) Bull Call Spread: خرید Call با اعمال پایین‌تر + فروش Call با اعمال بالاتر؛ زیان خالص محدود به بدهی خالص.',
    '۴) Bear Put Spread: خرید Put با اعمال بالاتر + فروش Put با اعمال پایین‌تر؛ زیان خالص محدود به بدهی خالص.',
    '۵) Long Straddle: خرید Call و Put هم‌اعمال و هم‌سررسید؛ محاسبه هزینه و دو نقطه سربه‌سر در موتور فعال است. Strangle هنوز در رتبه‌بندی خودکار فعال نیست.',
    '۶) Protective Put / Collar / Covered Call: فقط پس از دریافت تعداد سهام تحت مالکیت؛ فعلاً راهنمای طراحی هستند و به‌صورت خودکار سیگنال نمی‌شوند.',
    '',
    'موقعیت فروش بدون پوشش (Naked Short) توسط این ربات پیشنهاد نمی‌شود. اسپردهای اعتباری و وجه تضمین نیز تا زمان دریافت مقررات و مشخصات رسمی هر قرارداد غیرفعال‌اند.'
  ].join('\n');
}

function renderMarketReport(result, query = '') {
  const { fetched, options, groups, candidates } = result;
  if (result.noMatch) return `نمادی مطابق «${query}» در زنجیره دریافت‌شده پیدا نشد. املای نماد یا نام دارایی پایه را بررسی کن.`;
  const signals = candidates.filter(x => x.signal);
  const usable = candidates.filter(x => x.quality.ok);
  const top = candidates.slice(0, 8);
  const spreads = result.spreadStrategies || [];
  const lines = [
    `گزارش ${query ? 'تحلیل ' + query : 'پویش بازار اختیار معامله'}`,
    `زمان دریافت از منبع: ${new Date(fetched.at).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })} (زمان دریافت سرور؛ نه زمان قطعی آخرین معامله)`,
    `جریان‌های خوانده‌شده: ${fetched.flowUsed || 'نامشخص'} | رکورد خام: ${faInt(fetched.records.length)}`,
    `دارایی‌های پایه: ${faInt(groups.length)} | قراردادهای خوانده‌شده: ${faInt(options.length)} | تاریخچه تکنیکال دریافت‌شده: ${faInt(result.historyChecked || 0)}`,
    `قراردادهای دارای مظنه قابل‌استفاده: ${faInt(usable.length)} | سیگنال‌های واجد همه شروط: ${faInt(signals.length)}`,
    '',
    'خلاصه تکنیکال دارایی‌های پایه بررسی‌شده:'
  ];
  for (const a of (result.analyses || []).filter(x => x && !x.error).slice(0, 8)) {
    const t = a.indicators;
    lines.push(`${a.name}: RSI ${t.rsi === null ? 'نامشخص' : faNum(t.rsi, 1)} | EMA9 ${t.e9 === null ? 'نامشخص' : faInt(t.e9)} | EMA21 ${t.e21 === null ? 'نامشخص' : faInt(t.e21)} | MACD hist ${t.hist === null ? 'نامشخص' : faInt(t.hist)} | روند ${t.bullish ? 'صعودی' : t.bearish ? 'نزولی' : 'خنثی/ناقص'}`);
  }
  lines.push('', 'برترین نامزدها (رتبه الگوریتمی، نه تضمین سود):');
  for (const c of top) {
    lines.push(`${faInt(c.score)}/100 | ${c.signal ? 'واجد شرایط بررسی معامله' : 'صرفاً تحت نظر'} | ${c.option.symbol} | ${c.option.side === 'C' ? 'Call' : 'Put'} | ${c.option.underlyingName}`);
    lines.push(`اعمال ${faInt(c.option.strike)} | پرمیوم عرضه ${faInt(c.option.ask)} ریال | ${faInt(c.option.days)} روز | ${c.risk ? 'هزینه/قرارداد ' + faInt(c.risk.perContractToman) + ' تومان' : 'هزینه نامشخص'}`);
  }
  if (!top.length) lines.push('نامزد قابل‌نمایشی پیدا نشد.');
  lines.push('', 'راهبردهای ترکیبی محاسبه‌شده:');
  for (const st of spreads.slice(0, 4)) {
    if (st.type === 'Long Straddle') {
      lines.push(`${st.type} | ${st.underlying} | اعمال ${faInt(st.call.strike)} | هزینه/قرارداد ${faInt(rialToToman(st.debit * st.call.size))} تومان | سربه‌سر پایین/بالا ${faInt(st.lowerBreakEven)}/${faInt(st.upperBreakEven)} ریال | تعداد بر اساس ریسک ${faInt(st.quantity)}`);
    } else {
      lines.push(`${st.type} | ${st.underlying} | خرید ${st.long.symbol} / فروش پوششی ${st.short.symbol} | بدهی خالص ${faInt(st.debit)} ریال | زیان هر بسته ${faInt(st.maxLossPerContractToman)} تومان | سود هر بسته ${faInt(st.maxProfitPerContractToman)} تومان | تعداد مجاز ${faInt(st.quantity)}`);
    }
  }
  if (!spreads.length) lines.push('اسپرد/استرادل معتبر با مظنه کافی ساخته نشد.');
  lines.push('', `سرمایه مبنا: ${faInt(CFG.capitalToman)} تومان | ریسک هدف: ${faNum(CFG.riskPct * 100, 2)}٪ = ${faInt(CFG.capitalToman * CFG.riskPct)} تومان | سقف ریسک سخت: ${faNum(CFG.hardRiskPct * 100, 2)}٪`);
  lines.push('تذکر داده: TSETMC عمومی است؛ timestamp رسمی هر رکورد در این پاسخ تأیید نشده. داده و مظنه را پیش از سفارش در سامانه کارگزاری دوباره کنترل کن.');
  lines.push('تذکر مدل: IV و یونانی‌ها با بلک–شولز و نرخ بدون ریسک/بازده سود نقدی تنظیمی تخمین زده می‌شوند؛ خروجی رسمی بورس نیستند.');
  lines.push('این گزارش دستور خرید یا فروش نیست و هیچ سفارشی ثبت نمی‌کند.');
  return lines.join('\n');
}

function findDailyChange(o) { return o.changePct === null ? 0 : o.changePct; }

async function explainWithAI(chatId, question, context = '') {
  if (!CFG.openaiKey || !CFG.openaiModel) {
    return 'گفت‌وگوی هوش مصنوعی پیشرفته هنوز فعال نیست. برای فعال‌سازی باید کلید API معتبر OpenAI و نام مدل مجاز را در Environment Variables رندر تنظیم کنی. موتور داده و محاسبات مستقل ربات بدون آن هم کار می‌کند.';
  }
  const history = chatMemory.get(String(chatId)) || [];
  const input = [
    ...history.slice(-10),
    { role: 'user', content: `${question}\n\nداده ساختاریافته قابل اتکا (ممکن است خالی باشد):\n${context}` }
  ];
  const instructions = [
    'تو دستیار تحلیل اختیار معامله بورس ایران هستی. فارسی پاسخ بده.',
    'هرگز قیمت، خبر، داده، IV، یونانی، نقدشوندگی یا زمان زنده را جعل نکن.',
    'اعداد محاسباتی داده شده را تغییر نده؛ اگر داده ناقص/کهن/نامعتبر است صریح بگو و NO TRADE اعلام کن.',
    'موقعیت فروش بدون پوشش را توصیه نکن. معامله خودکار یا ثبت سفارش انجام نمی‌دهی.',
    'بین داده منبع، محاسبه مدل و فرض تحلیل تفاوت روشن بگذار.',
    'ریسک پایه ۰٫۵٪ سرمایه و سقف ۱٪ است؛ اگر زیان بالقوه از سقف فراتر رود، پیشنهاد نده.',
    'به کاربر یادآوری کن قیمت و مشخصات قرارداد را در کارگزاری بازبینی کند.',
    'اگر سؤال به داده زنده مربوط است و خلاصه داده‌ای در context نیست، از کاربر بخواه /scan یا /analyze اجرا کند؛ از حافظه یا حدس قیمت نساز.'
  ].join(' ');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CFG.openaiKey}` },
    body: JSON.stringify({ model: CFG.openaiModel, instructions, input, max_output_tokens: 1200 })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OpenAI API ${response.status}: ${body.error?.message || 'request failed'}`);
  const text = (body.output || []).flatMap(x => x.content || []).filter(x => x.type === 'output_text').map(x => x.text).join('\n').trim();
  if (!text) throw new Error('پاسخ متنی از مدل دریافت نشد.');
  const next = [...history, { role: 'user', content: question }, { role: 'assistant', content: text }].slice(-12);
  chatMemory.set(String(chatId), next);
  return text;
}

function getUserContext(chatId) {
  const watched = chatWatchlists.get(String(chatId)) || [];
  return `سرمایه مبنا ${CFG.capitalToman} تومان؛ ریسک هدف ${CFG.riskPct * 100} درصد؛ فهرست تحت نظر: ${watched.join(', ') || 'خالی'}؛ آخرین خلاصه داده: ${chatMarketContext.get(String(chatId)) || 'داده بازار در این گفتگو دریافت نشده است'}`;
}
async function sendTelegram(chatId, text) {
  if (!CFG.token) throw new Error('TELEGRAM_BOT_TOKEN تنظیم نشده است.');
  const chunks = splitMessage(String(text || ''));
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${CFG.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.ok) throw new Error(`Telegram send failed: ${body.description || response.status}`);
  }
}
function splitMessage(text, max = 3800) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.55) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
function helpText() {
  return [
    'دستیار هوشمند اختیار معامله ایران — نسخه ۳',
    '',
    '/start — شروع',
    '/help — راهنما',
    '/status — وضعیت اتصال و تنظیمات',
    '/market — آمار زنجیره اختیار و کیفیت داده',
    '/scan — پویش نامزدها و امتیازدهی',
    '/analyze نماد — تحلیل دارایی پایه/قراردادها (مثلاً /analyze خودرو)',
    '/contract نماد — جزئیات یک قرارداد اختیار',
    '/strategies — راهبردهای پشتیبانی‌شده و محدودیت‌ها',
    '/risk — سرمایه و بودجه ریسک',
    '/codal نماد — آخرین اطلاعیه‌های کدال',
    '/news نماد — پیام‌های ناظر TSETMC',
    '/watch نماد — افزودن نماد به فهرست همین نشست',
    '/watchlist — نمایش فهرست تحت نظر',
    '/unwatch نماد — حذف از فهرست',
    '/refresh — دریافت اجباری داده تازه',
    '/reset — پاک‌کردن تاریخچه گفت‌وگوی هوش مصنوعی',
    '',
    'می‌توانی سؤال معمولی هم بپرسی؛ برای گفت‌وگوی مدل زبانی باید OPENAI_API_KEY و OPENAI_MODEL در Render تنظیم شوند.'
  ].join('\n');
}
function statusText() {
  return [
    'وضعیت سامانه: فعال',
    'نسخه: 3.0',
    `TSETMC flow: ${CFG.flow}`,
    `آخرین دریافت زنجیره: ${chainCache.at ? new Date(chainCache.at).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' }) : 'هنوز انجام نشده'}`,
    `تعداد رکورد کش‌شده: ${chainCache.records?.length || 0}`,
    `مدل زبانی: ${CFG.openaiKey && CFG.openaiModel ? 'تنظیم شده' : 'فعال نیست (اختیاری)'}`,
    `سرمایه: ${faInt(CFG.capitalToman)} تومان | ریسک هدف: ${faNum(CFG.riskPct * 100, 2)}٪`,
    `فرض مدل یونانی‌ها: نرخ ${faNum(CFG.riskFreeRate * 100, 1)}٪، سود نقدی ${faNum(CFG.dividendYield * 100, 1)}٪ (قابل تنظیم؛ داده رسمی نیست)`,
    'حالت فعالیت: فقط تحلیل و سیگنال؛ بدون ثبت سفارش'
  ].join('\n');
}

async function handleText(chatId, text) {
  const raw = String(text || '').trim();
  const [cmdToken, ...rest] = raw.split(/\s+/);
  const command = (cmdToken || '').split('@')[0].toLowerCase();
  const argument = rest.join(' ').trim();
  const now = Date.now();
  const last = lastChatCommand.get(String(chatId)) || 0;
  if (now - last < 800) return;
  lastChatCommand.set(String(chatId), now);

  if (command === '/start') return sendTelegram(chatId, 'سلام! دستیار اختیار معامله ایران آماده است.\n\n' + helpText());
  if (command === '/help') return sendTelegram(chatId, helpText());
  if (command === '/status') return sendTelegram(chatId, statusText());
  if (command === '/strategies') return sendTelegram(chatId, strategyGuide());
  if (command === '/risk') {
    const risk = CFG.capitalToman * CFG.riskPct;
    return sendTelegram(chatId, `سرمایه مبنا: ${faInt(CFG.capitalToman)} تومان\nریسک هدف هر معامله: ${faInt(risk)} تومان (${faNum(CFG.riskPct * 100, 2)}٪)\nسقف ریسک سخت: ${faInt(CFG.capitalToman * CFG.hardRiskPct)} تومان (${faNum(CFG.hardRiskPct * 100, 2)}٪)\n\nبرای خریدار اختیار، زیان حداکثر معمولاً پریمیوم پرداختی به‌علاوه هزینه‌هاست؛ هزینه‌ها و ریسک اعمال/تسویه باید جداگانه بررسی شوند.`);
  }
  if (command === '/watch') {
    if (!argument) return sendTelegram(chatId, 'نماد را بعد از دستور وارد کن. نمونه: /watch خودرو');
    const key = String(chatId); const list = chatWatchlists.get(key) || [];
    if (!list.some(x => normalText(x) === normalText(argument))) list.push(argument);
    chatWatchlists.set(key, list.slice(-30));
    return sendTelegram(chatId, `«${argument}» به فهرست تحت نظر همین نشست اضافه شد.`);
  }
  if (command === '/watchlist') {
    const list = chatWatchlists.get(String(chatId)) || [];
    return sendTelegram(chatId, list.length ? 'فهرست تحت نظر:\n' + list.map((x, i) => `${i + 1}. ${x}`).join('\n') : 'فهرست تحت نظر خالی است.');
  }
  if (command === '/unwatch') {
    if (!argument) return sendTelegram(chatId, 'نمادی را که می‌خواهی حذف شود بنویس.');
    const key = String(chatId); const list = (chatWatchlists.get(key) || []).filter(x => normalText(x) !== normalText(argument));
    chatWatchlists.set(key, list);
    return sendTelegram(chatId, `«${argument}» از فهرست همین نشست حذف شد.`);
  }
  if (command === '/reset') {
    chatMemory.delete(String(chatId));
    return sendTelegram(chatId, 'حافظه گفت‌وگوی مدل زبانی در این نشست پاک شد.');
  }
  if (command === '/market' || command === '/refresh') {
    await sendTelegram(chatId, 'در حال دریافت زنجیره اختیار از TSETMC...');
    try {
      const result = await scanMarket({ force: command === '/refresh' });
      chatMarketContext.set(String(chatId), `options=${result.options.length}; underlyings=${result.groups.length}; fetched=${new Date(result.fetched.at).toISOString()}`);
      const lines = [
        'گزارش داده بازار اختیار',
        `رکورد خام: ${faInt(result.fetched.records.length)}`,
        `دارایی پایه: ${faInt(result.groups.length)}`,
        `قراردادهای قابل خواندن: ${faInt(result.options.length)}`,
        `زمان دریافت سرور: ${new Date(result.fetched.at).toLocaleString('fa-IR', { timeZone: 'Asia/Tehran' })}`,
        `Flow: ${result.fetched.flowUsed}`,
        `نام فیلدهای نمونه: ${(result.fetched.fields || []).join(', ')}`,
        '',
        'زمان ثبت‌شده، زمان دریافت سرور است و لزوماً زمان آخرین معامله نیست. این گزارش سیگنال نیست.'
      ];
      return sendTelegram(chatId, lines.join('\n'));
    } catch (error) { log('market_command_error', { error: error.message }); return sendTelegram(chatId, `خطای دریافت داده: ${error.message}\nهیچ سیگنالی صادر نشد.`); }
  }
  if (command === '/scan' || command === '/analyze') {
    const q = command === '/analyze' ? argument : '';
    if (command === '/analyze' && !q) return sendTelegram(chatId, 'نماد دارایی پایه را وارد کن. مثال: /analyze خودرو');
    await sendTelegram(chatId, q ? `در حال تحلیل ${q} و دریافت تاریخچه دارایی پایه...` : 'در حال پویش قراردادها و بررسی تاریخچه دارایی‌های پایه...');
    try {
      const result = await scanMarket({ force: true, query: q });
      chatMarketContext.set(String(chatId), renderMarketReport(result, q).slice(0, 6500));
      let extra = '';
      const g = result.groups[0];
      if (g) {
        const extras = await Promise.allSettled([fetchClientFlow(g.code), fetchBestLimits(g.code), fetchSupervisorMessages(g.code)]);
        const flow = extras[0].status === 'fulfilled' ? extras[0].value : null;
        const book = extras[1].status === 'fulfilled' ? extras[1].value : null;
        const messages = extras[2].status === 'fulfilled' ? extras[2].value : null;
        const parts = ['\nداده تکمیلی دارایی پایه:'];
        if (flow?.netI !== null && flow?.netI !== undefined) parts.push(`خالص حجم خرید حقیقی: ${faInt(flow.netI)} واحد`);
        if (flow?.netN !== null && flow?.netN !== undefined) parts.push(`خالص حجم خرید حقوقی: ${faInt(flow.netN)} واحد`);
        if (book?.length) parts.push(`بهترین سفارش پایه: تقاضا ${faInt(book[0].bid)} × ${faInt(book[0].bidQty)} | عرضه ${faInt(book[0].ask)} × ${faInt(book[0].askQty)}`);
        if (messages?.length) parts.push('پیام‌های ناظر اخیر:\n' + messages.slice(0, 3).map(x => `- ${x.title} (${x.date || 'تاریخ نامشخص'})`).join('\n'));
        if (!flow && !book && !messages) parts.push('جریان حقیقی/حقوقی، دفتر سفارش و پیام ناظر دریافت نشد.');
        extra = parts.join('\n');
      }
      chatMarketContext.set(String(chatId), (renderMarketReport(result, q) + extra).slice(0, 9000));
      return sendTelegram(chatId, renderMarketReport(result, q) + extra);
    } catch (error) { log('scan_command_error', { error: error.message }); return sendTelegram(chatId, `تحلیل کامل نشد: ${error.message}\nبه‌علت کمبود/خطای داده، سیگنالی صادر نمی‌شود.`); }
  }
  if (command === '/news') {
    if (!argument) return sendTelegram(chatId, 'نماد پایه را وارد کن. نمونه: /news فولاد');
    await sendTelegram(chatId, `در حال دریافت پیام‌های ناظر برای ${argument}...`);
    try {
      const fetched = await fetchOptionChain(false);
      const opts = normalizeOptionRows(fetched.records);
      const g = groupUnderlyings(opts).find(x => normalText(x.name).includes(normalText(argument)) || x.options.some(o => normalText(o.symbol).includes(normalText(argument))));
      if (!g) return sendTelegram(chatId, 'نماد در زنجیره اختیار فعلی پیدا نشد. از /analyze نماد استفاده کن.');
      const messages = await fetchSupervisorMessages(g.code);
      const report = messages.length ? 'پیام‌های ناظر اخیر:\n' + messages.map((x, i) => `${i + 1}. ${x.title}\n${x.date || ''} ${x.time || ''}`).join('\n\n') : 'پیام ناظر قابل‌نمایشی پیدا نشد یا ساختار پاسخ متفاوت است.';
      chatMarketContext.set(String(chatId), report);
      return sendTelegram(chatId, report);
    } catch (error) { return sendTelegram(chatId, `دریافت پیام‌های ناظر ناموفق بود: ${error.message}`); }
  }
  if (command === '/codal') {
    if (!argument) return sendTelegram(chatId, 'نماد بورسی را وارد کن. مثال: /codal فولاد');
    await sendTelegram(chatId, `در حال جست‌وجوی اطلاعیه‌های کدال برای ${argument}...`);
    try {
      const filings = await fetchCodalFilings(argument);
      if (!filings.length) return sendTelegram(chatId, 'اطلاعیه‌ای با این نماد از جست‌وجوی عمومی کدال دریافت نشد یا ساختار پاسخ تغییر کرده است.');
      const text = ['آخرین اطلاعیه‌های پیدا شده در کدال:', ...filings.map((f, i) => `${i + 1}. ${f.title}\nتاریخ: ${f.publish || 'نامشخص'} | شناسه: ${f.trace || 'نامشخص'}${f.url ? '\n' + f.url : ''}`), '', 'این فهرست صرفاً نتایج جست‌وجوی کدال است؛ متن/پیوست گزارش‌ها هنوز تحلیل نشده است.'].join('\n');
      chatMarketContext.set(String(chatId), text);
      return sendTelegram(chatId, text);
    } catch (error) { return sendTelegram(chatId, `جست‌وجوی کدال ناموفق بود: ${error.message}`); }
  }
  if (command === '/contract') {
    if (!argument) return sendTelegram(chatId, 'نماد قرارداد را وارد کن. مثال: /contract ضفولاد');
    await sendTelegram(chatId, 'در حال جست‌وجوی قرارداد...');
    try {
      const fetched = await fetchOptionChain(true);
      const options = normalizeOptionRows(fetched.records);
      const o = options.find(x => normalText(x.symbol) === normalText(argument) || normalText(x.fullName) === normalText(argument));
      if (!o) return sendTelegram(chatId, `قرارداد «${argument}» در داده دریافتی پیدا نشد. از /market برای دیدن نمادها استفاده کن.`);
      const q = contractQuality(o); const risk = debitRisk(o);
      const report = formatContract(o, { score: 0, quality: q, risk }) + '\n\nنکته: IV و یونانی‌ها تقریبی و وابسته به فرض نرخ/سود نقدی هستند.';
      chatMarketContext.set(String(chatId), report);
      return sendTelegram(chatId, report);
    } catch (error) { return sendTelegram(chatId, `خطا در دریافت جزئیات: ${error.message}`); }
  }

  // Natural-language mode is optional and must never invent missing market data.
  if (CFG.openaiKey && CFG.openaiModel) {
    try { return sendTelegram(chatId, await explainWithAI(chatId, raw, getUserContext(chatId))); }
    catch (error) { log('ai_error', { error: error.message }); return sendTelegram(chatId, `اتصال مدل زبانی ناموفق بود: ${error.message}`); }
  }
  return sendTelegram(chatId, 'متوجه شدم. برای تحلیل داده بازار از /scan یا /analyze نماد استفاده کن.\nبرای گفت‌وگوی آزاد شبیه دستیار هوشمند، باید کلید API و مدل زبانی در Render تنظیم شود.');
}

app.get('/', (_req, res) => res.status(200).send('Iran Options Assistant v3 is running'));
app.get('/health', (_req, res) => res.json({
  status: 'ok', version: '3.0.0', uptimeSeconds: Math.floor(process.uptime()),
  lastOptionsFetch: chainCache.at ? new Date(chainCache.at).toISOString() : null,
  optionsRecordsCached: chainCache.records?.length || 0,
  aiEnabled: Boolean(CFG.openaiKey && CFG.openaiModel),
  mode: 'signals_only'
}));
app.post('/telegram', async (req, res) => {
  const secret = req.get('x-telegram-bot-api-secret-token');
  if (!CFG.webhookSecret || !timingSafeStringEqual(secret, CFG.webhookSecret)) return res.sendStatus(403);
  const message = req.body?.message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  res.sendStatus(200);
  if (!chatId || typeof text !== 'string') return;
  if (CFG.allowedChatIds.length && !CFG.allowedChatIds.includes(String(chatId))) {
    log('blocked_chat', { chatId: String(chatId) });
    return;
  }
  try { await handleText(chatId, text); }
  catch (error) { log('telegram_handler_error', { error: error.message }); try { await sendTelegram(chatId, 'خطای داخلی رخ داد. لطفاً دوباره تلاش کن؛ تا روشن شدن وضعیت داده، سیگنالی صادر نمی‌شود.'); } catch {} }
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => log('server_started', { version: '3.0.0', port, aiEnabled: Boolean(CFG.openaiKey && CFG.openaiModel) }));
}

module.exports = {
  app, CFG, toNumber, findObjectArray, normalizeOptionRows,
  impliedVolatility, blackScholesGreeks, technicalIndicators,
  contractQuality, debitRisk, scoreOption, renderMarketReport, buildSpreadStrategies
};
