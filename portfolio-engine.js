'use strict';

// Expiry-only portfolio payoff engine. It never combines different expiries.
function norm(s) {
  return String(s || '').toLowerCase().replace(/[ي]/g,'ی').replace(/[ك]/g,'ک')
    .replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[\u200c\s\-_]/g,'').trim();
}
function validLeg(x) {
  return x && ['call','put'].includes(x.type) && ['long','short'].includes(x.side) &&
    Number(x.strike)>0 && Number(x.premium)>=0 && Number(x.quantity)>0 && Number(x.contractSize)>0;
}
function candidateLegs(c) {
  if (!c) return [];
  if (c.option) return [{
    ticker:c.option.ticker, type:c.option.type, side:'long',
    strike:Number(c.option.strike)/10, premium:Number(c.option.ask)/10,
    quantity:Number(c.quantity), contractSize:Number(c.option.contractSize),
    expiry:String(c.option.endDate || '')
  }];
  if (c.buy && c.sell) return [
    {ticker:c.buy.ticker,type:c.buy.type,side:'long',strike:Number(c.buy.strike)/10,
     premium:Number(c.buy.ask)/10,quantity:Number(c.quantity),contractSize:Number(c.buy.contractSize),expiry:String(c.buy.endDate||'')},
    {ticker:c.sell.ticker,type:c.sell.type,side:'short',strike:Number(c.sell.strike)/10,
     premium:Number(c.sell.bid)/10,quantity:Number(c.quantity),contractSize:Number(c.sell.contractSize),expiry:String(c.sell.endDate||'')}
  ];
  if (c.call && c.put) return [
    {ticker:c.call.ticker,type:'call',side:'long',strike:Number(c.call.strike)/10,premium:Number(c.call.ask)/10,
     quantity:Number(c.quantity),contractSize:Number(c.call.contractSize),expiry:String(c.call.endDate||'')},
    {ticker:c.put.ticker,type:'put',side:'long',strike:Number(c.put.strike)/10,premium:Number(c.put.ask)/10,
     quantity:Number(c.quantity),contractSize:Number(c.put.contractSize),expiry:String(c.put.endDate||'')}
  ];
  return [];
}
function positionLeg(p) {
  return {ticker:p.optionTicker,type:p.type,side:p.side,strike:Number(p.strike),
    premium:Number(p.entryToman),quantity:Number(p.quantity),contractSize:Number(p.contractSize),expiry:String(p.expiry||'')};
}
function payoff(legs, spot) {
  let total=0;
  for (const l of legs) {
    const intrinsic=l.type==='call'?Math.max(0,spot-l.strike):Math.max(0,l.strike-spot);
    const sign=l.side==='long'?1:-1;
    total += sign*(intrinsic-l.premium)*l.quantity*l.contractSize;
  }
  return total;
}
function metrics(legs) {
  if (!legs.length || legs.some(l=>!validLeg(l) || !l.expiry))
    return {ok:false,reason:'اطلاعات کامل و سررسید یکسان برای تمام پایه‌های محاسبه موجود نیست.'};
  const strikes=[...new Set(legs.map(l=>l.strike))].sort((a,b)=>a-b);
  const maxK=strikes[strikes.length-1];
  const xs=[0,...strikes,Math.max(maxK*2+1,1)];
  const ys=xs.map(x=>payoff(legs,x));
  const slopeHigh=legs.reduce((s,l)=>s+(l.type==='call'?(l.side==='long'?1:-1)*l.quantity*l.contractSize:0),0);
  const unboundedLoss=slopeHigh<0;
  const minPnl=Math.min(...ys);
  const unboundedProfit=slopeHigh>0;
  const maxPnl=unboundedProfit?null:Math.max(...ys);
  const breakevens=[];
  for(let i=0;i<xs.length-1;i++){
    const y1=ys[i],y2=ys[i+1];
    if(y1===0) breakevens.push(xs[i]);
    if(y1*y2<0) breakevens.push(xs[i]+(xs[i+1]-xs[i])*(-y1)/(y2-y1));
  }
  if(ys[ys.length-1]===0) breakevens.push(xs[xs.length-1]);
  const uniqueBE=[...new Set(breakevens.map(x=>Math.round(x*100)/100))];
  return {ok:true,maxLoss:unboundedLoss?null:Math.max(0,-minPnl),maxProfit:maxPnl==null?null:Math.max(0,maxPnl),
    unboundedLoss,unboundedProfit,breakevens:uniqueBE,points:xs.map((spot,i)=>({spot,pnl:ys[i]})),
    netHighCallSlope:slopeHigh};
}
function evaluate(positions,candidate,underlying) {
  const all=(positions||[]).filter(p=>p.status==='open'&&norm(p.underlying)===norm(underlying)).map(positionLeg);
  const added=candidateLegs(candidate);
  if(!added.length) return {ok:false,reason:'ساختار پایه‌های استراتژی پیشنهادی قابل شناسایی نیست.'};
  const expiry=added[0].expiry;
  if(!expiry || added.some(l=>l.expiry!==expiry)) return {ok:false,reason:'سررسید پایه‌های استراتژی پیشنهادی یکسان یا معتبر نیست.'};
  const matched=all.filter(l=>l.expiry===expiry);
  const other=all.filter(l=>l.expiry!==expiry);
  const before=metrics(matched);
  const after=metrics(matched.concat(added));
  if(!after.ok) return {ok:false,reason:after.reason};
  const riskChange=before.ok?after.maxLoss-before.maxLoss:null;
  let classification=matched.length?'ریسک پرتفوی را تغییر می‌دهد':'پرتفوی هم‌سررسید قبلی وجود ندارد؛ این ریسک جدید است';
  if(before.ok && before.unboundedLoss && !after.unboundedLoss) classification='کاهنده ریسک نامحدود قبلی؛ همچنان باید سقف زیان بررسی شود';
  else if(before.ok && after.ok && riskChange < -0.5) classification='کاهنده زیان حداکثری در سناریوهای سررسید';
  else if(before.ok && after.ok && riskChange > 0.5) classification='افزاینده زیان حداکثری در سناریوهای سررسید';
  else if(before.ok && after.ok) classification='تقریباً خنثی از نظر زیان حداکثری';
  if(after.unboundedLoss) classification='دارای زیان نامحدود بالقوه؛ پیشنهاد رد شود';
  return {ok:true,expiry,existingCount:matched.length,otherExpiryCount:other.length,
    before,after,riskChange,classification,
    otherExpiryNote:other.length?'موقعیت‌هایی با سررسید متفاوت جدا نگه داشته شدند و در این محاسبه ادغام نشدند.':null};
}
module.exports={evaluate,candidateLegs,metrics,payoff};
