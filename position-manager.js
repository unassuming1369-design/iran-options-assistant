'use strict';
const fs=require('node:fs');const path=require('node:path');
const FILE=path.join(process.env.POSITION_DATA_DIR||path.join(__dirname,'data'),'positions.json');
function load(){try{const x=JSON.parse(fs.readFileSync(FILE,'utf8'));return Array.isArray(x)?x:[]}catch{return[]}}
function save(rows){fs.mkdirSync(path.dirname(FILE),{recursive:true});fs.writeFileSync(FILE,JSON.stringify(rows,null,2));}
function clean(s){return String(s||'').trim();}
function add(input){const rows=load();const p={id:`P${Date.now().toString(36).toUpperCase()}`,chatId:String(input.chatId),underlying:clean(input.underlying),optionTicker:clean(input.optionTicker),type:input.type,side:input.side,strike:Number(input.strike),expiry:clean(input.expiry),entryToman:Number(input.entryToman),quantity:Number(input.quantity),contractSize:Number(input.contractSize),createdAt:new Date().toISOString(),status:'open',lastAlertAt:null,lastMarkToman:null};
 if(!p.underlying||!p.optionTicker||!['call','put'].includes(p.type)||!['long','short'].includes(p.side)||!(p.strike>0)||!p.expiry||!(p.entryToman>0)||!(p.quantity>0)||!(p.contractSize>0))throw new Error('اطلاعات موقعیت ناقص یا نامعتبر است.');
 rows.push(p);save(rows);return p;}
function list(chatId,openOnly=false){return load().filter(p=>p.chatId===String(chatId)&&(!openOnly||p.status==='open'));}
function close(chatId,id){const rows=load();const p=rows.find(x=>x.chatId===String(chatId)&&x.id.toLowerCase()===String(id).toLowerCase()&&x.status==='open');if(!p)return null;p.status='closed';p.closedAt=new Date().toISOString();save(rows);return p;}
function mark(p,option){const raw=p.side==='long'?option.bid:option.ask;const markToman=raw>0?raw/10:null;if(markToman==null)return {ok:false,reason:'قیمت قابل معامله در سمت لازم (تقاضا برای خروج خرید / عرضه برای بستن فروش) موجود نیست.'};
 const sign=p.side==='long'?1:-1;const pnl=(markToman-p.entryToman)*p.contractSize*p.quantity*sign;const cost=p.entryToman*p.contractSize*p.quantity;const pct=cost>0?pnl/cost*100:null;
 return {ok:true,markToman,pnlToman:pnl,pct,breakeven:p.entryToman,exitSide:p.side==='long'?'فروش در تقاضای موجود':'خرید برای بستن فروش در عرضه موجود',option};}
function evaluateAll(options){const rows=load();const alerts=[];for(const p of rows.filter(x=>x.status==='open')){const o=options.find(x=>String(x.ticker).toLowerCase()===p.optionTicker.toLowerCase()||String(x.insCode)===p.optionTicker);if(!o)continue;const m=mark(p,o);if(!m.ok)continue;p.lastMarkToman=m.markToman;p.lastPnlToman=m.pnlToman;p.lastPct=m.pct;
 const material=(m.pct||0)<=-20||(m.pct||0)>=10;const prior=p.lastAlertAt?Date.now()-new Date(p.lastAlertAt).getTime()>30*60*1000:true;
 if(material&&prior){p.lastAlertAt=new Date().toISOString();alerts.push({position:p,mark:m});}}
 save(rows);return alerts;}
function report(p,option){const m=mark(p,option);if(!m.ok)return `موقعیت ${p.id}\n${m.reason}\nتا دریافت قیمت معتبر، پیشنهاد عملیاتی صادر نمی‌شود.`;
 const fmt=x=>Math.round(x).toLocaleString('en-US');const lines=[`مدیریت موقعیت ${p.id}`,`${p.underlying} | ${p.type.toUpperCase()} | ${p.side==='long'?'خریداری‌شده':'فروخته‌شده'}`,`قرارداد: ${p.optionTicker} | اعمال: ${fmt(p.strike)} | سررسید: ${p.expiry}`,`قیمت ورود: ${fmt(p.entryToman)} تومان | قیمت خروج قابل مشاهده: ${fmt(m.markToman)} تومان`,`تعداد: ${p.quantity} | اندازه قرارداد: ${p.contractSize}`,`سود/زیان باز برآوردی: ${fmt(m.pnlToman)} تومان (${m.pct.toFixed(2)}٪)`,`حد زیان برنامه‌ریزی‌شده ۲۰٪: ${fmt(p.entryToman*p.contractSize*p.quantity*0.2)} تومان | هدف اولیه سود: بیش از ۱۰٪`,'',`سمت قیمت برای خروج: ${m.exitSide}`];
 if(m.pct<=-20)lines.push('هشدار: زیان باز به حد ۲۰٪ بهای تمام‌شده رسیده یا از آن عبور کرده است. خرید بیشتر برای جبران زیان توصیه خودکار نمی‌شود؛ ابتدا سناریوی سهم پایه، زمان تا سررسید، نقدشوندگی و ریسک کل را دوباره بررسی کن.');
 else if(m.pct>=10)lines.push('هشدار: سود باز از هدف اولیه ۱۰٪ عبور کرده است. بررسی ذخیره بخشی از سود یا تعیین حد خروج شناور منطقی است؛ این گزارش به‌تنهایی دستور فروش نیست.');
 else lines.push('وضعیت: پایش؛ برای پیشنهاد محدوده جدید ورود/خروج باید قیمت زنده دفتر سفارش، تحلیل سهم پایه و زنجیره به‌روز تأیید شود.');
 lines.push('قیمت‌های بالا از داده بازار دریافت‌شده استخراج شده‌اند؛ کارمزد، مالیات، لغزش، صف و امکان اجرای سفارش لحاظ نشده‌اند. ربات هیچ سفارشی ثبت یا تغییر نمی‌دهد.');return lines.join('\n');}
module.exports={add,list,close,mark,evaluateAll,report,load};
