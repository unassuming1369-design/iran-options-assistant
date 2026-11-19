'use strict';

const API_BASE = (process.env.TSETMC_API_BASE || 'https://cdn.tsetmc.com/api').replace(/\/$/, '');
const USER_AGENT = process.env.TSETMC_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const cache = new Map();

function unwrapValue(value) {
  let current = value;
  for (let i = 0; i < 4 && current && typeof current === 'object' && !Array.isArray(current); i++) {
    if (Object.prototype.hasOwnProperty.call(current, 'value')) current = current.value;
    else if (Object.prototype.hasOwnProperty.call(current, 'Value')) current = current.Value;
    else break;
  }
  return current;
}

function toNumber(value) {
  value = unwrapValue(value);
  if (value === null || value === undefined || value === '' || value === '-' || value === '—') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim()
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[٬,]/g, '').replace(/[٫]/g, '.');
  if (!s || !/^[-+]?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function first(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== null && obj[key] !== undefined && obj[key] !== '') return unwrapValue(obj[key]);
  }
  return null;
}

function firstNumber(obj, keys) { return toNumber(first(obj, keys)); }

function normalizeSymbol(s) {
  return String(s || '').toLowerCase()
    .replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک')
    .replace(/[\u200c\s\-_]/g, '').trim();
}

function unwrapObject(payload, preferredKeys = []) {
  if (!payload || typeof payload !== 'object') return payload;
  for (const key of preferredKeys) {
    if (payload[key] !== undefined && payload[key] !== null) return payload[key];
  }
  return payload;
}

function collectArrays(node, out = [], path = '$', depth = 0) {
  if (depth > 9 || node == null) return out;
  if (Array.isArray(node)) {
    const objects = node.filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (objects.length) {
      const keys = [...new Set(objects.slice(0, 10).flatMap(x => Object.keys(x)))];
      out.push({ path, count: objects.length, keys, rows: objects });
    }
    for (let i = 0; i < Math.min(node.length, 4); i++) collectArrays(node[i], out, `${path}[${i}]`, depth + 1);
  } else if (typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) collectArrays(value, out, `${path}.${key}`, depth + 1);
  }
  return out;
}

function optionArrayScore(candidate) {
  const keys = new Set(candidate.keys);
  let score = 0;
  for (const k of ['strikePrice', 'strike_price', 'Strike', 'StrikePrice']) if (keys.has(k)) score += 5;
  for (const k of ['insCode_C', 'insCode_P', 'insCode', 'InsCode', 'uaInsCode', 'ualInsCode', 'UnderlyingInsCode', 'OptionType']) if (keys.has(k)) score += 3;
  for (const k of ['remainedDay', 'endDate', 'contractSize', 'pClosing_C', 'pDrCotVal_C', 'DaysToExpiry', 'EndDate', 'ContractSize']) if (keys.has(k)) score += 2;
  if (candidate.count > 0) score += Math.min(candidate.count, 1000) / 1000;
  return score;
}

function findOptionRows(payload) {
  const candidates = collectArrays(payload).sort((a, b) => optionArrayScore(b) - optionArrayScore(a));
  if (!candidates.length) return { rows: [], candidates };
  const best = candidates[0];
  const recognized = optionArrayScore(best) >= 5;
  return { rows: recognized ? best.rows : [], candidates, selected: best, recognized };
}

function fieldForSide(row, baseKeys, side) {
  const suffix = `_${side}`;
  return first(row, baseKeys.map(k => `${k}${suffix}`));
}

function numberForSide(row, baseKeys, side) {
  return toNumber(fieldForSide(row, baseKeys, side));
}

function parseSide(row, side, shared) {
  const insCode = fieldForSide(row, ['insCode', 'tseCode', 'instrumentCode', 'InsCode'], side);
  const ticker = fieldForSide(row, ['lVal18AFC', 'ticker', 'symbol', 'optionTicker', 'Symbol'], side);
  const name = fieldForSide(row, ['lVal30', 'name', 'optionName', 'Name'], side);
  if (!insCode && !ticker && !name) return null;
  return {
    ...shared,
    type: side === 'C' ? 'call' : 'put',
    typeFa: side === 'C' ? 'اختیار خرید' : 'اختیار فروش',
    insCode: insCode == null ? null : String(insCode),
    ticker: ticker == null ? (name == null ? 'نامشخص' : String(name)) : String(ticker),
    name: name == null ? null : String(name),
    last: numberForSide(row, ['pDrCotVal', 'lastPrice', 'last_price', 'pl', 'Last'], side),
    close: numberForSide(row, ['pClosing', 'closePrice', 'close_price', 'pc', 'Close'], side),
    yesterday: numberForSide(row, ['pYesterday', 'yesterdayPrice', 'yesterday_price', 'py', 'Yesterday'], side),
    volume: numberForSide(row, ['qTotTran5J', 'tradesVolume', 'trades_volume', 'qTotTran', 'Volume'], side),
    value: numberForSide(row, ['qTotCap', 'tradesValue', 'trades_value', 'Value'], side),
    tradeCount: numberForSide(row, ['zTotTran', 'tradesNum', 'trades_num', 'TradeCount'], side),
    openInterest: numberForSide(row, ['oP', 'openPosition', 'openPositions', 'openInterest', 'open_interest', 'qOpenPosition', 'OpenInterest'], side),
    previousOpenInterest: numberForSide(row, ['yesterdayOpenPositions', 'oPYesterday', 'previousOpenInterest', 'YesterdayOpenInterest'], side),
    bid: numberForSide(row, ['pMeDem', 'bidPrice', 'bid_price', 'pBid', 'pd', 'BidPrice'], side),
    bidVolume: numberForSide(row, ['qTitMeDem', 'bidVolume', 'bid_volume', 'qd', 'BidVolume'], side),
    ask: numberForSide(row, ['pMeOf', 'askPrice', 'ask_price', 'pAsk', 'po', 'AskPrice'], side),
    askVolume: numberForSide(row, ['qTitMeOf', 'askVolume', 'ask_volume', 'qo', 'AskVolume'], side),
  };
}

function normalizeOptionRows(rows) {
  const options = [];
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const shared = {
      underlyingCode: first(row, ['uaInsCode', 'ualInsCode', 'insCode_UA', 'underlyingInsCode', 'UnderlyingInsCode', 'UnderlyingCode', 'ua_tse_code']) == null ? null : String(first(row, ['uaInsCode', 'ualInsCode', 'insCode_UA', 'underlyingInsCode', 'UnderlyingInsCode', 'UnderlyingCode', 'ua_tse_code'])),
      underlyingTicker: first(row, ['lVal18AFC_UA', 'uaTicker', 'underlyingTicker', 'ua_ticker', 'underlyingSymbol', 'UnderlyingSymbol', 'UnderlyingTicker']) == null ? null : String(first(row, ['lVal18AFC_UA', 'uaTicker', 'underlyingTicker', 'ua_ticker', 'underlyingSymbol', 'UnderlyingSymbol', 'UnderlyingTicker'])),
      underlyingName: first(row, ['lVal30_UA', 'uaName', 'underlyingName', 'UnderlyingName']) == null ? null : String(first(row, ['lVal30_UA', 'uaName', 'underlyingName', 'UnderlyingName'])),
      spot: firstNumber(row, ['pDrCotVal_UA', 'pClosing_UA', 'uaClosePrice', 'ua_close_price', 'underlyingPrice', 'UnderlyingLast', 'UnderlyingClose']),
      strike: firstNumber(row, ['strikePrice', 'strike_price', 'exercisePrice', 'Strike', 'StrikePrice']),
      contractSize: firstNumber(row, ['contractSize', 'contract_size', 'lotSize', 'ContractSize']),
      daysRemaining: firstNumber(row, ['remainedDay', 'daysToMaturity', 'days_to_maturity', 'daysRemaining', 'DaysToExpiry', 'DaysToMaturity']),
      endDate: first(row, ['endDate', 'end_date', 'maturityDate', 'expirationDate', 'EndDate', 'ExpirationDate']) == null ? null : String(first(row, ['endDate', 'end_date', 'maturityDate', 'expirationDate', 'EndDate', 'ExpirationDate'])),
      beginDate: first(row, ['beginDate', 'begin_date', 'startDate', 'BeginDate']) == null ? null : String(first(row, ['beginDate', 'begin_date', 'startDate', 'BeginDate'])),
      sourceDate: first(row, ['dEven', 'deven', 'date', 'Date', 'AsOf']) == null ? null : String(first(row, ['dEven', 'deven', 'date', 'Date', 'AsOf'])),
      sourceTime: first(row, ['hEven', 'heven', 'time', 'Time']) == null ? null : String(first(row, ['hEven', 'heven', 'time', 'Time'])),
    };
    const call = parseSide(row, 'C', shared);
    const put = parseSide(row, 'P', shared);
    if (call) options.push(call);
    if (put) options.push(put);
    if (!call && !put) {
      const typeRaw = String(first(row, ['optionType', 'option_type', 'type', 'typeTitle', 'OptionType']) || '').toLowerCase();
      const ticker = String(first(row, ['lVal18AFC', 'ticker', 'symbol', 'Symbol']) || '');
      let type = /put|پت|فروش/.test(typeRaw) ? 'put' : /call|کال|خرید/.test(typeRaw) ? 'call' : null;
      if (!type && /^[ط]/.test(ticker)) type = 'put';
      if (!type && /^[ض]/.test(ticker)) type = 'call';
      const insCode = first(row, ['insCode', 'tseCode', 'instrumentCode', 'InsCode']);
      if (type && (insCode || ticker)) {
        const side = type === 'call' ? 'C' : 'P';
        const one = {
          ...shared, type, typeFa: type === 'call' ? 'اختیار خرید' : 'اختیار فروش',
          insCode: insCode == null ? null : String(insCode), ticker,
          name: first(row, ['lVal30', 'name', 'Name']),
          last: firstNumber(row, ['pDrCotVal', 'lastPrice', 'pl']),
          close: firstNumber(row, ['pClosing', 'closePrice', 'pc']),
          yesterday: firstNumber(row, ['pYesterday', 'yesterdayPrice', 'py']),
          volume: firstNumber(row, ['qTotTran5J', 'tradesVolume', 'qTotTran']),
          value: firstNumber(row, ['qTotCap', 'tradesValue']),
          tradeCount: firstNumber(row, ['zTotTran', 'tradesNum']),
          openInterest: firstNumber(row, ['oP', 'openPosition', 'openInterest']),
          previousOpenInterest: firstNumber(row, ['yesterdayOpenPositions', 'oPYesterday']),
          bid: firstNumber(row, ['pMeDem', 'bidPrice', 'pd']), bidVolume: firstNumber(row, ['qTitMeDem', 'bidVolume', 'qd']),
          ask: firstNumber(row, ['pMeOf', 'askPrice', 'po']), askVolume: firstNumber(row, ['qTitMeOf', 'askVolume', 'qo']),
        };
        options.push(one);
      }
    }
  }
  const seen = new Set();
  return options.filter(o => {
    const key = `${o.insCode || o.ticker}|${o.type}|${o.strike}|${o.endDate || o.daysRemaining}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function firstPrefixed(row, prefix, aliases) {
  const candidates = [];
  for (const alias of aliases) {
    const pascal = alias.charAt(0).toUpperCase() + alias.slice(1);
    candidates.push(`${prefix}${pascal}`, `${prefix}_${alias}`, `${prefix}${alias}`);
  }
  const direct = first(row, candidates);
  if (direct !== null) return direct;
  const wanted = new Set(candidates.map(x => x.toLowerCase()));
  for (const [key, value] of Object.entries(row || {})) {
    if (wanted.has(key.toLowerCase()) && value !== undefined && value !== null) return unwrapValue(value);
  }
  return null;
}

function firstNumberPrefixed(row, prefix, aliases) {
  return toNumber(firstPrefixed(row, prefix, aliases));
}

function webgwItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['Items', 'items', 'ItemsList', 'data', 'Data']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return findArrayByKey(payload, ['Items', 'items', 'data', 'Data']);
}

function parseWebgwTradeOptionRows(rows) {
  const options = [];
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const rootTicker = first(row, ['underlyingTicker', 'underlyingSymbol', 'uaTicker', 'underlyingInstrumentName', 'instrumentName', 'instrument_Name', 'underlyingName']);
    const rootCompany = first(row, ['underlyingCompanyName', 'companyNamePersian', 'companyName', 'underlyingNamePersian']);
    const sharedCode = first(row, ['uaInsCode', 'ualInsCode', 'underlyingInsCode', 'underlyingCode']);
    const sharedSpot = firstNumber(row, ['underlyingPrice', 'underlyingLastPrice', 'qeymateMabna', 'QeymateMabna', 'pClosing_UA']);
    for (const [prefix, type] of [['buy', 'call'], ['sell', 'put']]) {
      const ticker = firstPrefixed(row, prefix, ['instrumentName', 'instrument_Name', 'instrumentSymbol', 'shortName', 'ticker', 'symbol', 'optionName', 'name', 'nam', 'lVal18AFC']);
      const isin = firstPrefixed(row, prefix, ['instrumentId', 'isin', 'cIsin', 'instrumentIsin']);
      const numericCode = firstPrefixed(row, prefix, ['insCode', 'tseCode', 'instrumentCode']);
      const strike = firstNumberPrefixed(row, prefix, ['qeymateEmal', 'strikePrice', 'strike', 'exercisePrice']);
      const last = firstNumberPrefixed(row, prefix, ['lastPrice', 'lastprice', 'last', 'pDrCotVal']);
      const close = firstNumberPrefixed(row, prefix, ['closingPrice', 'closingprice', 'closePrice', 'pClosing']);
      const volume = firstNumberPrefixed(row, prefix, ['tradeVolume', 'tradevolume', 'volume', 'qTotTran5J']);
      const value = firstNumberPrefixed(row, prefix, ['tradeValue', 'tradevalue', 'value', 'qTotCap']);
      const tradeCount = firstNumberPrefixed(row, prefix, ['tradeCount', 'tradecount', 'tradesCount', 'zTotTran']);
      const bid = firstNumberPrefixed(row, prefix, ['buyPrice', 'buyprice', 'bestBuyPrice', 'bidPrice', 'bid']);
      const ask = firstNumberPrefixed(row, prefix, ['sellPrice', 'sellprice', 'bestSellPrice', 'askPrice', 'ask']);
      const days = firstNumberPrefixed(row, prefix, ['baqimandeTaSarresId', 'baghimandeTaSarresId', 'daysToExpiry', 'remainedDay', 'daysRemaining']);
      const expiry = firstPrefixed(row, prefix, ['tarixSarresid', 'tarikhSarresid', 'endDate', 'expirationDate', 'expiryDate']);
      const size = firstNumberPrefixed(row, prefix, ['andazeyeQarardad', 'contractSize', 'lotSize']);
      const oi = firstNumberPrefixed(row, prefix, ['openInterest', 'openPositions', 'openPosition', 'openPositionCount', 'openpositioncount', 'oP']);
      const bidVol = firstNumberPrefixed(row, prefix, ['buyVolume', 'buyvolume', 'bidVolume', 'qTitMeDem']);
      const askVol = firstNumberPrefixed(row, prefix, ['sellVolume', 'sellvolume', 'askVolume', 'qTitMeOf']);
      if (!ticker && !isin && !numericCode && strike == null && last == null && close == null) continue;
      options.push({
        type, typeFa: type === 'call' ? 'اختیار خرید' : 'اختیار فروش',
        insCode: numericCode == null ? null : String(numericCode),
        isin: isin == null ? null : String(isin),
        ticker: ticker == null ? `${rootTicker || 'قرارداد نامشخص'} (${type === 'call' ? 'خرید' : 'فروش'})` : String(ticker),
        name: ticker == null ? null : String(ticker),
        underlyingCode: sharedCode == null ? null : String(sharedCode),
        underlyingIsin: first(row, ['underlyingInstrumentId', 'underlyingIsin', 'uaInstrumentId', 'instrumentId']) == null ? null : String(first(row, ['underlyingInstrumentId', 'underlyingIsin', 'uaInstrumentId', 'instrumentId'])),
        underlyingTicker: rootTicker == null ? null : String(rootTicker),
        underlyingName: rootCompany == null ? null : String(rootCompany),
        spot: sharedSpot || firstNumberPrefixed(row, prefix, ['qeymateMabna', 'underlyingPrice', 'underlyingLastPrice']), strike, contractSize: size,
        daysRemaining: days, endDate: expiry == null ? null : String(expiry),
        last, close, yesterday: firstNumberPrefixed(row, prefix, ['yesterdayPrice', 'yesterdayprice', 'pYesterday']),
        volume, value, tradeCount, openInterest: oi, previousOpenInterest: null,
        bid, ask, bidVolume: bidVol, askVolume: askVol,
        sourceDate: first(row, ['lastUpdateDate', 'updateDate', 'date', 'Date']) == null ? null : String(first(row, ['lastUpdateDate', 'updateDate', 'date', 'Date'])),
        sourceTime: first(row, ['lastUpdateTime', 'updateTime', 'time', 'Time']) == null ? null : String(first(row, ['lastUpdateTime', 'updateTime', 'time', 'Time'])),
        source: 'webgw.tse.ir',
      });
    }
  }
  const seen = new Set();
  return options.filter(o => {
    const key = `${o.isin || o.insCode || o.ticker}|${o.type}|${o.strike}|${o.endDate || o.daysRemaining}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function parseWebgwSingleOptionRows(rows) {
  const out = [];
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const ticker = first(row, ['instrumentName', 'instrument_Name', 'ticker', 'symbol', 'lVal18AFC', 'name']);
    const typeRaw = String(first(row, ['optionType', 'optionTypeTitle', 'marketCategory', 'marketcategoryname', 'instrumentType', 'type', 'instrumentName', 'instrument_Name']) || '');
    const type = /put|پوت|فروش|^ط/.test(typeRaw.toLowerCase()) ? 'put' : /call|کال|خرید|^ض/.test(typeRaw.toLowerCase()) ? 'call' : null;
    if (!type || !ticker) continue;
    const getN = keys => firstNumber(row, keys);
    const isin = first(row, ['instrumentId', 'isin', 'cIsin']);
    out.push({
      type, typeFa: type === 'call' ? 'اختیار خرید' : 'اختیار فروش',
      insCode: first(row, ['insCode', 'InsCode']) == null ? null : String(first(row, ['insCode', 'InsCode'])),
      isin: isin == null ? null : String(isin), ticker: String(ticker), name: String(ticker),
      underlyingCode: first(row, ['uaInsCode', 'underlyingInsCode']) == null ? null : String(first(row, ['uaInsCode', 'underlyingInsCode'])),
      underlyingTicker: first(row, ['underlyingTicker', 'underlyingSymbol', 'uaTicker']) == null ? null : String(first(row, ['underlyingTicker', 'underlyingSymbol', 'uaTicker'])),
      underlyingName: first(row, ['underlyingName', 'underlyingCompanyName', 'companyNamePersian']) == null ? null : String(first(row, ['underlyingName', 'underlyingCompanyName', 'companyNamePersian'])),
      spot: getN(['qeymateMabna', 'underlyingPrice', 'underlyingLastPrice']),
      strike: getN(['qeymateEmal', 'strikePrice', 'StrikePrice']),
      contractSize: getN(['andazeyeQarardad', 'contractSize', 'ContractSize']),
      daysRemaining: getN(['baghimandetasarresid', 'daysToExpiry', 'remainedDay']),
      endDate: first(row, ['tarixSarresid', 'endDate', 'expirationDate']) == null ? null : String(first(row, ['tarixSarresid', 'endDate', 'expirationDate'])),
      last: getN(['lastPrice', 'lastprice', 'pDrCotVal']), close: getN(['closingPrice', 'closingprice', 'pClosing']),
      yesterday: getN(['yesterdayPrice', 'pYesterday']), volume: getN(['tradeVolume', 'tradevolume', 'qTotTran5J']),
      value: getN(['tradeValue', 'tradevalue', 'qTotCap']), tradeCount: getN(['tradeCount', 'tradecount', 'zTotTran']),
      openInterest: getN(['openInterest', 'openPositions', 'openPosition', 'oP']), previousOpenInterest: null,
      bid: getN(['buyPrice', 'bidPrice', 'pMeDem']), ask: getN(['sellPrice', 'askPrice', 'pMeOf']),
      bidVolume: getN(['buyVolume', 'bidVolume', 'qTitMeDem']), askVolume: getN(['sellVolume', 'askVolume', 'qTitMeOf']),
      source: 'webgw.tse.ir',
    });
  }
  return out;
}

async function fetchJson(path, options = {}) {
  const url = path.startsWith('http') ? path : `${API_BASE}/${path.replace(/^\//, '')}`;
  const cacheKey = url;
  const ttl = options.cacheMs || 0;
  const cached = cache.get(cacheKey);
  if (!options.force && ttl > 0 && cached && Date.now() - cached.at < ttl) return cached.data;
  let lastError;
  for (let attempt = 0; attempt < (Number.isInteger(options.retries) ? Math.max(1, options.retries) : 2); attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': USER_AGENT,
          'Origin': options.origin || 'https://tsetmc.ir',
          'Referer': options.referer || 'https://tsetmc.ir/',
          ...(options.headers || {}),
        },
        signal: AbortSignal.timeout(options.timeoutMs || 18000),
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`TSETMC پاسخ HTTP ${response.status}`);
      if (/<!doctype html|<html|General Error Detected|دسترسی شما مسدود/i.test(body.slice(0, 1500))) {
        throw new Error('منبع TSETMC به‌جای داده، صفحه خطا یا محدودیت دسترسی برگرداند.');
      }
      let data;
      try { data = JSON.parse(body); }
      catch { throw new Error('پاسخ منبع JSON معتبر نبود؛ احتمال تغییر API یا محدودیت دسترسی وجود دارد.'); }
      if (ttl > 0) cache.set(cacheKey, { at: Date.now(), data });
      return data;
    } catch (err) {
      lastError = err;
      if (attempt === 0 && /HTTP 5\d\d|fetch failed|network|timeout|timed out/i.test(err.message)) await new Promise(r => setTimeout(r, 700));
      else break;
    }
  }
  throw lastError || new Error('خطای نامشخص در دریافت اطلاعات');
}

async function getOptionMarket(force = false) {
  const diagnostics = [];
  // Main source: the option-market endpoint used by the user's tsetmc.ir page.
  try {
    const raw = await fetchJson('/Instrument/GetInstrumentOptionMarketWatch/1', {
      cacheMs: 10000, force, timeoutMs: 20000,
    });
    const found = findOptionRows(raw);
    const options = normalizeOptionRows(found.rows);
    if (options.length) {
      return {
        raw, options, selected: found.selected || null, candidates: found.candidates || [],
        fetchedAt: new Date(), source: 'نمای بازار اختیار سایت tsetmc.ir (منبع اصلی)',
        sourceUrl: `${API_BASE}/Instrument/GetInstrumentOptionMarketWatch/1`, diagnostics,
      };
    }
    diagnostics.push('API اصلی tsetmc.ir پاسخ داد، اما ساختار قراردادها قابل تبدیل نبود.');
  } catch (e) { diagnostics.push(`API اصلی tsetmc.ir: ${e.message}`); }

  // Secondary source: official TSE gateway. Access may be restricted by server IP.
  const gatewayBase = 'https://webgw.tse.ir/InstrumentProvider/api/v1/MarketWatch';
  try {
    const rawTrade = await fetchJson(`${gatewayBase}/MarketWatchTradeOption/fa`, {
      cacheMs: 10000, force, timeoutMs: Number(process.env.TSE_GATEWAY_TIMEOUT_MS || 4500), retries: 1,
      origin: 'https://www.tse.ir', referer: 'https://www.tse.ir/',
    });
    const rows = webgwItems(rawTrade);
    const options = parseWebgwTradeOptionRows(rows);
    if (options.length && options.some(o => o.underlyingTicker || o.underlyingCode)) {
      return {
        raw: rawTrade, options,
        selected: { path: 'webgw.tse.ir MarketWatchTradeOption', count: rows.length, keys: rows[0] ? Object.keys(rows[0]) : [], rows: rows.slice(0, 1) },
        candidates: [], fetchedAt: new Date(), source: 'نمای جفت‌شده اختیار در درگاه جایگزین رسمی TSE',
        sourceUrl: `${gatewayBase}/MarketWatchTradeOption/fa`, diagnostics,
      };
    }
    diagnostics.push('درگاه جایگزین جفت‌شده پاسخ داد، اما اطلاعات کافی برای اتصال به نماد پایه نداشت.');
  } catch (e) { diagnostics.push(`درگاه جایگزین جفت‌شده: ${e.message}`); }

  try {
    const rawSingle = await fetchJson(`${gatewayBase}/MarketWatchOption/fa`, {
      cacheMs: 10000, force, timeoutMs: Number(process.env.TSE_GATEWAY_TIMEOUT_MS || 4500), retries: 1,
      origin: 'https://www.tse.ir', referer: 'https://www.tse.ir/',
    });
    const rows = webgwItems(rawSingle);
    const options = parseWebgwSingleOptionRows(rows);
    if (options.length && options.some(o => o.underlyingTicker || o.underlyingCode)) {
      return {
        raw: rawSingle, options,
        selected: { path: 'webgw.tse.ir MarketWatchOption', count: rows.length, keys: rows[0] ? Object.keys(rows[0]) : [], rows: rows.slice(0, 1) },
        candidates: [], fetchedAt: new Date(), source: 'نمای جداگانه اختیار در درگاه جایگزین رسمی TSE',
        sourceUrl: `${gatewayBase}/MarketWatchOption/fa`, diagnostics,
      };
    }
    diagnostics.push('درگاه جایگزین تک‌قراردادی پاسخ داد، اما نماد پایه یا نوع قراردادها قابل تشخیص نبود.');
  } catch (e) { diagnostics.push(`درگاه جایگزین تک‌قراردادی: ${e.message}`); }
  throw new Error(`هیچ قرارداد قابل استفاده‌ای از منابع بازار اختیار تشخیص داده نشد. ${diagnostics.join(' | ')}`);
}

function findArrayByKey(payload, keys) {
  for (const k of keys) if (payload && Array.isArray(payload[k])) return payload[k];
  const candidates = collectArrays(payload);
  return candidates.sort((a, b) => b.count - a.count)[0]?.rows || [];
}

function findObjectByKey(payload, keys) {
  for (const k of keys) {
    if (payload && payload[k] && typeof payload[k] === 'object') {
      return Array.isArray(payload[k]) ? (payload[k].find(x => x && typeof x === 'object') || {}) : payload[k];
    }
  }
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const vals = Object.values(payload).filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (vals.length === 1) return vals[0];
  }
  if (Array.isArray(payload)) return payload.find(x => x && typeof x === 'object') || {};
  return payload;
}

function mean(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null; }
function stddev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1));
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function analyzeTechnical(history) {
  const rows = (history || []).map(x => ({
    date: Number(first(x, ['dEven', 'deven', 'devenrlc', 'date', 'Date', 'AsOf'])) || null,
    close: firstNumber(x, ['pClosing', 'closingprice', 'close', 'pc', 'iClose', 'Close']),
    high: firstNumber(x, ['priceMax', 'pMax', 'highvalue', 'high', 'pmax', 'High']),
    low: firstNumber(x, ['priceMin', 'pMin', 'lowvalue', 'low', 'pmin', 'Low']),
    volume: firstNumber(x, ['qTotTran5J', 'tradevolume', 'volume', 'tvol', 'qTotTran', 'Volume']),
  })).filter(x => x.close > 0).sort((a, b) => (a.date || 0) - (b.date || 0));
  if (rows.length < 35) return { available: false, count: rows.length, reason: 'برای اندیکاتورها حداقل ۳۵ روز داده معتبر لازم است.' };
  const closes = rows.map(x => x.close);
  const volumes = rows.map(x => x.volume).filter(x => x != null && x >= 0);
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e26 = ema(closes, 26);
  const macdSeries = [];
  for (let i = 25; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    macdSeries.push(ema(slice, 12) - ema(slice, 26));
  }
  const macdLine = macdSeries[macdSeries.length - 1];
  const signalLine = ema(macdSeries, 9);
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const recent = rows.slice(-20);
  const recent60 = rows.slice(-60);
  const support = Math.min(...recent.map(x => x.low || x.close));
  const resistance = Math.max(...recent.map(x => x.high || x.close));
  const support60 = Math.min(...recent60.map(x => x.low || x.close));
  const resistance60 = Math.max(...recent60.map(x => x.high || x.close));
  const lastVol = rows[rows.length - 1].volume;
  const avgVol = mean(rows.slice(-21, -1).map(x => x.volume).filter(x => x != null));
  const logReturns = [];
  for (let i = Math.max(1, closes.length - 21); i < closes.length; i++) logReturns.push(Math.log(closes[i] / closes[i - 1]));
  const histVol = stddev(logReturns);
  const rsi14 = rsi(closes, 14);
  const bullish = e9 > e21 && macdLine > signalLine && rsi14 >= 50 && rsi14 < 75;
  const bearish = e9 < e21 && macdLine < signalLine && rsi14 <= 50 && rsi14 > 25;
  const direction = bullish ? 'صعودی' : bearish ? 'نزولی' : 'خنثی یا نامشخص';
  return {
    available: true, count: rows.length, lastClose, prevClose,
    changePct: prevClose ? (lastClose / prevClose - 1) * 100 : null,
    ema9: e9, ema21: e21, rsi14, macd: macdLine, macdSignal: signalLine,
    volumeLast: lastVol, volumeAverage20: avgVol, volumeRatio: lastVol != null && avgVol > 0 ? lastVol / avgVol : null,
    support20: support, resistance20: resistance, support60, resistance60,
    historicalVol20: histVol == null ? null : histVol * Math.sqrt(252), direction,
    upsideTarget: resistance60 > lastClose * 1.01 ? resistance60 : null,
    downsideTarget: support60 < lastClose * 0.99 ? support60 : null,
  };
}

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}
function normalPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }
function bsPrice(S, K, T, r, sigma, type) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return type === 'call'
    ? S * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2)
    : K * Math.exp(-r * T) * normalCdf(-d2) - S * normalCdf(-d1);
}
function impliedVol(price, S, K, T, r, type) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  let lo = 0.001, hi = 5;
  const lowP = bsPrice(S, K, T, r, lo, type), highP = bsPrice(S, K, T, r, hi, type);
  if (price < lowP - 1e-6 || price > highP + 1e-6) return null;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const model = bsPrice(S, K, T, r, mid, type);
    if (Math.abs(model - price) < 1e-6) return mid;
    if (model > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
function bsGreeks(S, K, T, r, sigma, type) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const gamma = normalPdf(d1) / (S * sigma * Math.sqrt(T));
  const vega = S * normalPdf(d1) * Math.sqrt(T) / 100;
  if (type === 'call') return { delta: normalCdf(d1), gamma, theta: (-S * normalPdf(d1) * sigma / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normalCdf(d2)) / 365, vega };
  return { delta: normalCdf(d1) - 1, gamma, theta: (-S * normalPdf(d1) * sigma / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normalCdf(-d2)) / 365, vega };
}

function optionSpreadPct(option) {
  if (!(option.bid > 0 && option.ask > 0 && option.ask >= option.bid)) return null;
  const mid = (option.bid + option.ask) / 2;
  return mid > 0 ? (option.ask - option.bid) / mid * 100 : null;
}
function optionQuality(option) {
  const spread = optionSpreadPct(option);
  const vol = option.volume || 0;
  const oi = option.openInterest || 0;
  let score = 0;
  if (spread != null) score += Math.max(0, 40 - spread * 2);
  else score -= 10;
  score += Math.min(25, Math.log10(vol + 1) * 8);
  score += Math.min(25, Math.log10(oi + 1) * 8);
  if (option.daysRemaining != null && option.daysRemaining >= 7 && option.daysRemaining <= 90) score += 10;
  return { score, spread };
}

function enrichOptions(options, spot, riskFreeRate) {
  return options.map(o => {
    const quality = optionQuality(o);
    const entry = o.ask > 0 ? o.ask : (o.last > 0 ? o.last : o.close);
    const riskFree = riskFreeRate;
    let iv = null, greeks = null;
    const T = o.daysRemaining > 0 ? o.daysRemaining / 365 : null;
    if (riskFree != null && spot > 0 && o.strike > 0 && T && entry > 0) {
      iv = impliedVol(entry, spot, o.strike, T, riskFree, o.type);
      if (iv != null) greeks = bsGreeks(spot, o.strike, T, riskFree, iv, o.type);
    }
    return { ...o, entry, quality: quality.score, spreadPct: quality.spread, iv, greeks };
  });
}

function groupOptionsByUnderlying(options) {
  const map = new Map();
  for (const o of options) {
    const key = o.underlyingCode || normalizeSymbol(o.underlyingTicker) || 'نامشخص';
    if (!map.has(key)) map.set(key, { code: o.underlyingCode, ticker: o.underlyingTicker, name: o.underlyingName, options: [], totalValue: 0, totalVolume: 0 });
    const g = map.get(key); g.options.push(o); g.totalValue += o.value || 0; g.totalVolume += o.volume || 0;
  }
  return [...map.values()];
}

function getOptionFreshness(options) {
  const stamps = (options || []).map(o => ({ date: o.sourceDate == null ? '' : String(o.sourceDate), time: o.sourceTime == null ? '' : String(o.sourceTime) })).filter(x => x.date || x.time);
  if (!stamps.length) return 'زمان آخرین به‌روزرسانی داخل رکوردها مشخص نیست؛ فقط زمان دریافت ربات ثبت شده است.';
  stamps.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  const latest = stamps[stamps.length - 1];
  return `تاریخ/ساعت اعلام‌شده در داده منبع: ${latest.date || 'نامشخص'} ${latest.time || ''}`.trim();
}

function findUnderlyingGroup(options, symbol) {
  const q = normalizeSymbol(symbol);
  const groups = groupOptionsByUnderlying(options);
  return groups.find(g => normalizeSymbol(g.ticker) === q)
    || groups.find(g => normalizeSymbol(g.name) === q)
    || groups.find(g => normalizeSymbol(g.ticker).includes(q) || q.includes(normalizeSymbol(g.ticker)))
    || groups.find(g => normalizeSymbol(g.name).includes(q) || q.includes(normalizeSymbol(g.name)));
}

function putCallRatios(options) {
  const totals = { callVolume: 0, putVolume: 0, callValue: 0, putValue: 0, callOI: 0, putOI: 0, callVolumeN: 0, putVolumeN: 0, callValueN: 0, putValueN: 0, callOIN: 0, putOIN: 0 };
  for (const o of options || []) {
    const side = o.type === 'call' ? 'call' : 'put';
    if (o.volume != null) { totals[`${side}Volume`] += o.volume; totals[`${side}VolumeN`] += 1; }
    if (o.value != null) { totals[`${side}Value`] += o.value; totals[`${side}ValueN`] += 1; }
    if (o.openInterest != null) { totals[`${side}OI`] += o.openInterest; totals[`${side}OIN`] += 1; }
  }
  const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
  return {
    volume: ratio(totals.putVolume, totals.callVolume),
    value: ratio(totals.putValue, totals.callValue),
    openInterest: totals.callOIN && totals.putOIN ? ratio(totals.putOI, totals.callOI) : null,
    coverage: {
      volume: `${totals.callVolumeN + totals.putVolumeN} قرارداد دارای حجم از ${options.length}`,
      value: `${totals.callValueN + totals.putValueN} قرارداد دارای ارزش از ${options.length}`,
      openInterest: `${totals.callOIN + totals.putOIN} قرارداد دارای موقعیت باز از ${options.length}`,
    },
  };
}

function extractPriceInfo(payload) {
  const obj = findObjectByKey(payload, ['closingPriceInfo']);
  return {
    last: firstNumber(obj, ['pDrCotVal', 'lastPrice', 'lastprice', 'pl', 'last']),
    close: firstNumber(obj, ['pClosing', 'closingPrice', 'closingprice', 'pc', 'close']),
    yesterday: firstNumber(obj, ['priceYesterday', 'yesterdayPrice', 'yesterdayprice', 'py', 'pYesterday']),
    open: firstNumber(obj, ['priceFirst', 'firstPrice', 'pf', 'open']),
    high: firstNumber(obj, ['priceMax', 'maxValue', 'maxvalue', 'pmax', 'high']),
    low: firstNumber(obj, ['priceMin', 'minValue', 'minvalue', 'pmin', 'low']),
    volume: firstNumber(obj, ['qTotTran5J', 'tradeVolume', 'tradevolume', 'tvol', 'volume']),
    value: firstNumber(obj, ['qTotCap', 'tradeValue', 'tradevalue', 'tval', 'value']),
    tradeCount: firstNumber(obj, ['zTotTran', 'tradeCount', 'tradecount', 'tno', 'count']),
    date: first(obj, ['dEven', 'deven', 'date', 'Date']),
    time: first(obj, ['hEven', 'heven', 'time', 'Time']),
    raw: obj,
  };
}

function extractBestLimits(payload) {
  const levels = findArrayByKey(payload, ['bestLimits', 'bestLimitsHistory', 'limits']) || [];
  if (!levels.length) return { available: false };
  const normalized = levels.map((x, i) => ({
    level: firstNumber(x, ['number', 'no']) || i + 1,
    bid: firstNumber(x, ['pd', 'pMeDem', 'bidPrice']),
    bidVolume: firstNumber(x, ['qd', 'qTitMeDem', 'bidVolume']),
    bidOrders: firstNumber(x, ['zd', 'zOrdMeDem', 'bidOrders']),
    ask: firstNumber(x, ['po', 'pMeOf', 'askPrice']),
    askVolume: firstNumber(x, ['qo', 'qTitMeOf', 'askVolume']),
    askOrders: firstNumber(x, ['zo', 'zOrdMeOf', 'askOrders']),
  }));
  const valid = normalized.filter(x => x.bid != null || x.ask != null);
  if (!valid.length) return { available: false };
  const bidVolume = valid.reduce((s, x) => s + (x.bidVolume || 0), 0);
  const askVolume = valid.reduce((s, x) => s + (x.askVolume || 0), 0);
  const top = valid.sort((a, b) => a.level - b.level)[0];
  const mid = top.bid > 0 && top.ask > 0 ? (top.bid + top.ask) / 2 : null;
  const spreadPct = mid ? (top.ask - top.bid) / mid * 100 : null;
  const imbalance = bidVolume + askVolume > 0 ? (bidVolume - askVolume) / (bidVolume + askVolume) : null;
  return { available: true, levels: valid, bestBid: top.bid, bestBidVolume: top.bidVolume, bestAsk: top.ask, bestAskVolume: top.askVolume, bidVolume, askVolume, spreadPct, imbalance };
}

function scoreNewsSentiment(items) {
  const positive = ['افزایش سرمایه', 'افزایش سود', 'سودآوری', 'رشد فروش', 'افزایش فروش', 'افزایش تولید', 'قرارداد جدید', 'صادرات', 'بهره برداری', 'تعدیل مثبت', 'تقسیم سود'];
  const negative = ['زیان', 'کاهش سود', 'کاهش فروش', 'کاهش تولید', 'تعدیل منفی', 'تعلیق', 'توقف نماد', 'عدم تایید', 'جریمه', 'شکایت', 'افزایش بدهی', 'کاهش سرمایه'];
  let p = 0, n = 0;
  const details = [];
  for (const item of items || []) {
    const text = `${item.title || ''} ${item.text || ''}`.replace(/\s+/g, ' ');
    const pHits = positive.filter(k => text.includes(k));
    const nHits = negative.filter(k => text.includes(k));
    p += pHits.length; n += nHits.length;
    if (pHits.length || nHits.length) details.push({ title: item.title, positive: pHits, negative: nHits });
  }
  let label = 'خنثی یا بدون نشانه کافی';
  if (p > n) label = 'تمایل مثبت در واژه‌های اطلاعیه';
  if (n > p) label = 'تمایل منفی در واژه‌های اطلاعیه';
  if (p === n && p > 0) label = 'نشانه‌های مثبت و منفی هم‌زمان';
  return { label, positiveHits: p, negativeHits: n, details, method: 'کلیدواژه‌ای و کم‌اطمینان' };
}

function extractClientFlow(payload) {
  const obj = findObjectByKey(payload, ['clientType', 'clientTypeAllDto']);
  const aliases = {
    buyI: ['buy_I_Volume', 'buyIVolume', 'buyIndividualVolume', 'buyI'],
    sellI: ['sell_I_Volume', 'sellIVolume', 'sellIndividualVolume', 'sellI'],
    buyN: ['buy_N_Volume', 'buyNVolume', 'buyLegalVolume', 'buyN'],
    sellN: ['sell_N_Volume', 'sellNVolume', 'sellLegalVolume', 'sellN'],
    buyICount: ['buy_CountI', 'buyICount', 'buyIndividualCount'],
    sellICount: ['sell_CountI', 'sellICount', 'sellIndividualCount'],
    buyNCount: ['buy_CountN', 'buyNCount', 'buyLegalCount'],
    sellNCount: ['sell_CountN', 'sellNCount', 'sellLegalCount'],
  };
  const vals = {};
  for (const [k, keys] of Object.entries(aliases)) vals[k] = firstNumber(obj, keys);
  const available = Object.values(vals).some(v => v != null);
  if (!available) return { available: false };
  const individualNet = vals.buyI != null && vals.sellI != null ? vals.buyI - vals.sellI : null;
  const legalNet = vals.buyN != null && vals.sellN != null ? vals.buyN - vals.sellN : null;
  const avgBuyI = vals.buyI != null && vals.buyICount > 0 ? vals.buyI / vals.buyICount : null;
  const avgSellI = vals.sellI != null && vals.sellICount > 0 ? vals.sellI / vals.sellICount : null;
  const buyerPower = avgBuyI != null && avgSellI > 0 ? avgBuyI / avgSellI : null;
  const totalAbs = [vals.buyI, vals.sellI, vals.buyN, vals.sellN].filter(v => v != null).reduce((a, b) => a + b, 0);
  return { available: true, ...vals, individualNet, legalNet, avgBuyI, avgSellI, buyerPower, totalAbs };
}

function extractMessages(payload) {
  const arr = findArrayByKey(payload, ['msg', 'messages', 'preparedData']);
  return arr.slice(0, 12).map(m => ({
    title: first(m, ['tseTitle', 'title', 'subject', 'reportName', 'lVal30', 'letterCodeTitle', 'letterTitle', 'letterCode']) || 'اطلاعیه بدون عنوان',
    text: first(m, ['tseDesc', 'description', 'desc', 'summary', 'letterDesc', 'sentDescription']) || '',
    date: first(m, ['dEven', 'date', 'publishDate', 'publishDateTime', 'publishDateJalali']) || null,
    time: first(m, ['hEven', 'time']) || null,
  }));
}

function extractFundamentals(payload) {
  const obj = findObjectByKey(payload, ['instrumentInfo']);
  const eps = firstNumber(obj, ['eps', 'estimatedEPS', 'EPS']);
  const pe = firstNumber(obj, ['pe', 'pE', 'PE', 'peRatio']);
  const sectorPe = firstNumber(obj, ['sectorPE', 'sectorPe', 'industryPE']);
  const shares = firstNumber(obj, ['zTitad', 'totalShares', 'shares']);
  const sector = first(obj, ['lSecVal', 'sectorName', 'sectorTitle']);
  return { available: [eps, pe, sectorPe, shares, sector].some(v => v != null), eps, pe, sectorPe, shares, sector };
}

function calcLongOptionCandidate(o, direction, tech, spot, riskBudgetToman, contractSize, minRR = 2) {
  if (!(o.entry > 0 && o.strike > 0 && spot > 0 && contractSize > 0 && o.daysRemaining > 0)) return null;
  if (!(o.ask > 0 && o.bid > 0 && o.ask >= o.bid)) return null;
  if (o.spreadPct != null && o.spreadPct > 18) return null;
  const target = o.type === 'call' ? tech.upsideTarget : tech.downsideTarget;
  if (!(target > 0)) return null;
  if ((o.type === 'call' && direction !== 'صعودی') || (o.type === 'put' && direction !== 'نزولی')) return null;
  const intrinsicAtTarget = o.type === 'call' ? Math.max(0, target - o.strike) : Math.max(0, o.strike - target);
  const risk = o.ask * contractSize / 10;
  const profit = (intrinsicAtTarget - o.ask) * contractSize / 10;
  const rr = risk > 0 ? profit / risk : null;
  const qty = risk > 0 ? Math.floor(riskBudgetToman / risk) : 0;
  if (!(profit > 0 && rr >= minRR && qty >= 1)) return null;
  return { strategy: o.type === 'call' ? 'خرید اختیار خرید' : 'خرید اختیار فروش', option: o, target, riskPerContract: risk, profitPerContract: profit, rr, quantity: qty, maxLoss: risk * qty, targetProfit: profit * qty };
}

function calcLongStraddles(options, technical, riskBudgetToman, minRR = 2) {
  if (!technical || !technical.available || !(riskBudgetToman > 0)) return [];
  const calls = options.filter(o => o.type === 'call' && o.strike > 0 && o.ask > 0 && o.bid > 0 && o.daysRemaining > 0 && o.contractSize > 0);
  const puts = options.filter(o => o.type === 'put' && o.strike > 0 && o.ask > 0 && o.bid > 0 && o.daysRemaining > 0 && o.contractSize > 0);
  const results = [];
  for (const call of calls) {
    const put = puts.find(p => {
      const sameBase = (call.underlyingCode && p.underlyingCode === call.underlyingCode)
        || (call.underlyingTicker && normalizeSymbol(p.underlyingTicker) === normalizeSymbol(call.underlyingTicker));
      return sameBase && p.strike === call.strike && p.endDate && p.endDate === call.endDate
        && p.contractSize === call.contractSize && (p.spreadPct == null || p.spreadPct <= 18);
    });
    if (!put || (call.spreadPct != null && call.spreadPct > 18)) continue;
    const premium = call.ask + put.ask;
    const riskPerContract = premium * call.contractSize / 10;
    if (!(riskPerContract > 0)) continue;
    const targets = [
      { label: 'افزایش قیمت سهم پایه', spot: technical.upsideTarget },
      { label: 'کاهش قیمت سهم پایه', spot: technical.downsideTarget },
    ].filter(x => x.spot > 0);
    for (const scenario of targets) {
      const payoff = Math.max(0, scenario.spot - call.strike) + Math.max(0, put.strike - scenario.spot);
      const profitPerContract = (payoff - premium) * call.contractSize / 10;
      const rr = profitPerContract / riskPerContract;
      const quantity = Math.floor(riskBudgetToman / riskPerContract);
      if (profitPerContract > 0 && rr >= minRR && quantity >= 1) {
        results.push({
          strategy: 'استرادل خرید (خرید هم‌زمان Call و Put)', call, put,
          scenario: scenario.label, target: scenario.spot, premium,
          riskPerContract, profitPerContract, rr, quantity,
          maxLoss: riskPerContract * quantity, targetProfit: profitPerContract * quantity,
        });
      }
    }
  }
  return results.sort((a, b) => b.rr - a.rr).slice(0, 2);
}

function calcDebitSpreads(options, direction, riskBudgetToman, minRR = 2) {
  const results = [];
  const byExpirySize = new Map();
  for (const o of options) {
    if (!(o.insCode || o.isin || o.ticker) || !(o.ask > 0 || o.bid > 0) || !(o.strike > 0) || !(o.contractSize > 0) || !o.endDate) continue;
    const key = `${o.type}|${o.endDate}|${o.contractSize}`;
    if (!byExpirySize.has(key)) byExpirySize.set(key, []);
    byExpirySize.get(key).push(o);
  }
  for (const [key, arr] of byExpirySize) {
    const [type] = key.split('|');
    if (type === 'call' && direction === 'صعودی') {
      const sorted = arr.filter(x => x.ask > 0 && x.bid > 0).sort((a, b) => a.strike - b.strike);
      for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
        const buy = sorted[i], sell = sorted[j];
        const debit = buy.ask - sell.bid, width = sell.strike - buy.strike;
        if (!(debit > 0 && width > debit)) continue;
        const risk = debit * buy.contractSize / 10, reward = (width - debit) * buy.contractSize / 10;
        const rr = reward / risk, quantity = Math.floor(riskBudgetToman / risk);
        if (rr >= minRR && quantity >= 1 && (buy.spreadPct == null || buy.spreadPct <= 18) && (sell.spreadPct == null || sell.spreadPct <= 18)) {
          results.push({ strategy: 'اسپرد صعودی با اختیار خرید', buy, sell, debit, width, riskPerContract: risk, rewardPerContract: reward, rr, quantity, maxLoss: risk * quantity, maxProfit: reward * quantity });
        }
      }
    }
    if (type === 'put' && direction === 'نزولی') {
      const sorted = arr.filter(x => x.ask > 0 && x.bid > 0).sort((a, b) => b.strike - a.strike);
      for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
        const buy = sorted[i], sell = sorted[j];
        const debit = buy.ask - sell.bid, width = buy.strike - sell.strike;
        if (!(debit > 0 && width > debit)) continue;
        const risk = debit * buy.contractSize / 10, reward = (width - debit) * buy.contractSize / 10;
        const rr = reward / risk, quantity = Math.floor(riskBudgetToman / risk);
        if (rr >= minRR && quantity >= 1 && (buy.spreadPct == null || buy.spreadPct <= 18) && (sell.spreadPct == null || sell.spreadPct <= 18)) {
          results.push({ strategy: 'اسپرد نزولی با اختیار فروش', buy, sell, debit, width, riskPerContract: risk, rewardPerContract: reward, rr, quantity, maxLoss: risk * quantity, maxProfit: reward * quantity });
        }
      }
    }
  }
  return results.sort((a, b) => b.rr - a.rr).slice(0, 3);
}

function formatNumber(value, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return 'نامشخص';
  return new Intl.NumberFormat('fa-IR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}
function toman(valueRial, digits = 0) { return valueRial == null ? 'نامشخص' : `${formatNumber(valueRial / 10, digits)} تومان`; }
function priceChangeText(pct) { return pct == null ? 'نامشخص' : `${pct > 0 ? '+' : ''}${formatNumber(pct, 2)}٪`; }
function sideName(type) { return type === 'call' ? 'خرید' : 'فروش'; }

function summarizeOption(o) {
  const lines = [
    `${o.typeFa} «${o.ticker}»`,
    `قیمت اعمال: ${toman(o.strike)} | سررسید: ${o.endDate || 'نامشخص'} | روز مانده: ${formatNumber(o.daysRemaining)}`,
    `آخرین معامله: ${toman(o.last)} | پایانی: ${toman(o.close)}`,
    `تقاضا: ${toman(o.bid)} (${formatNumber(o.bidVolume)} قرارداد) | عرضه: ${toman(o.ask)} (${formatNumber(o.askVolume)} قرارداد)`,
    `حجم روز: ${formatNumber(o.volume)} | ارزش معاملات: ${toman(o.value)} | موقعیت باز: ${formatNumber(o.openInterest)}`,
  ];
  if (o.spreadPct != null) lines.push(`فاصله خرید و فروش: ${formatNumber(o.spreadPct, 1)}٪`);
  return lines.join('\n');
}

function summarizeFlow(flow) {
  if (!flow.available) return 'اطلاعات خرید و فروش حقیقی/حقوقی از منبع دریافت نشد.';
  const zero = [flow.buyI, flow.sellI, flow.buyN, flow.sellN].every(v => v == null || v === 0);
  if (zero) return 'منبع در این زمان حجم حقیقی/حقوقی معناداری گزارش نکرد؛ ورود یا خروج پول قابل تأیید نیست.';
  const netText = (n) => n == null ? 'نامشخص' : `${n > 0 ? 'خالص خرید ' : n < 0 ? 'خالص فروش ' : 'بدون برتری '}${formatNumber(Math.abs(n))} سهم`;
  const extra = flow.buyerPower == null ? 'قدرت خریدار حقیقی: قابل محاسبه نیست' : `قدرت خریدار حقیقی: ${formatNumber(flow.buyerPower, 2)} برابر (سرانه خرید نسبت به فروش)`;
  return [
    `حقیقی: ${netText(flow.individualNet)}`,
    `حقوقی: ${netText(flow.legalNet)}`,
    extra,
    'این آمار فقط اختلاف حجم خرید و فروش را نشان می‌دهد و به‌تنهایی اثبات ورود پول هوشمند یا شناسایی هویت معامله‌گر نیست.'
  ].join('\n');
}

function directionExplanation(tech) {
  if (!tech.available) return tech.reason;
  return `روند کلی: ${tech.direction}\nRSI چهارده‌روزه: ${formatNumber(tech.rsi14, 1)} | میانگین ۹ روزه: ${toman(tech.ema9)} | میانگین ۲۱ روزه: ${toman(tech.ema21)}\nMACD: ${formatNumber(tech.macd, 2)} در برابر خط سیگنال ${formatNumber(tech.macdSignal, 2)}\nحمایت تقریبی ۲۰ روزه: ${toman(tech.support20)} | مقاومت تقریبی ۲۰ روزه: ${toman(tech.resistance20)}\nنسبت حجم روز آخر به میانگین ۲۰ روزه: ${tech.volumeRatio == null ? 'نامشخص' : `${formatNumber(tech.volumeRatio, 2)} برابر`}\nنوسان تاریخی ۲۰ روزه‌شده: ${tech.historicalVol20 == null ? 'نامشخص' : `${formatNumber(tech.historicalVol20 * 100, 1)}٪`}`;
}

module.exports = {
  API_BASE, toNumber, first, firstNumber, normalizeSymbol, collectArrays, findOptionRows,
  normalizeOptionRows, parseWebgwTradeOptionRows, parseWebgwSingleOptionRows, webgwItems, fetchJson, getOptionMarket, findArrayByKey, findObjectByKey,
  analyzeTechnical, impliedVol, bsGreeks, optionQuality, enrichOptions, groupOptionsByUnderlying,
  getOptionFreshness, findUnderlyingGroup, extractPriceInfo, extractClientFlow, extractMessages,
  extractFundamentals, extractBestLimits, scoreNewsSentiment, calcLongOptionCandidate, calcLongStraddles, calcDebitSpreads, putCallRatios, formatNumber, toman,
  priceChangeText, summarizeOption, summarizeFlow, directionExplanation,
};
