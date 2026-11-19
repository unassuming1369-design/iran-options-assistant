'use strict';

const FEEDS = [
  { name: 'ایرنا', url: 'https://www.irna.ir/rss' },
  { name: 'ایسنا', url: 'https://www.isna.ir/rss' },
  { name: 'تسنیم', url: 'https://www.tasnimnews.com/fa/rss/feed/0/7/0' },
  { name: 'مهر', url: 'https://www.mehrnews.com/rss' },
  { name: 'دنیای اقتصاد', url: 'https://donya-e-eqtesad.com/rss' },
];
const CODAL_URL = 'https://search.codal.ir/api/search/v2/q';
const timeout = 12000;
function decode(s='') { return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/\s+/g,' ').trim(); }
async function get(url, headers={}) {
  const r = await fetch(url,{headers:{'user-agent':'Mozilla/5.0 IranOptionsAssistant/5.0','accept':'application/json,application/rss+xml,application/xml,text/xml,*/*',...headers},signal:AbortSignal.timeout(timeout)});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}
function parseRss(xml, source) {
  const items=[]; const blocks=String(xml).match(/<(item|entry)\b[\s\S]*?<\/(item|entry)>/gi)||[];
  for(const b of blocks.slice(0,30)) {
    const pick=(re)=>{const m=b.match(re);return m?decode(m[1]):'';};
    const title=pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const link=pick(/<link[^>]*>([\s\S]*?)<\/link>/i)||((b.match(/<link[^>]+href=["']([^"']+)/i)||[])[1]||'');
    const date=pick(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\/(?:pubDate|published|updated|dc:date)>/i);
    const desc=pick(/<(?:description|summary|content:encoded)[^>]*>([\s\S]*?)<\/(?:description|summary|content:encoded)>/i);
    if(title) items.push({title,description:desc,link,date,source,kind:'news'});
  }
  return items;
}
async function fetchNews(symbol='', limit=20) {
  const results=await Promise.allSettled(FEEDS.map(async f=>{const r=await get(f.url);return parseRss(await r.text(),f.name);}));
  const all=[]; const errors=[];
  results.forEach((r,i)=>{if(r.status==='fulfilled')all.push(...r.value);else errors.push(`${FEEDS[i].name}: ${r.reason.message}`);});
  const q=String(symbol||'').replace(/[\u200c\s]/g,'').toLowerCase();
  const relevant=q?all.filter(x=>(x.title+' '+x.description).replace(/[\u200c\s]/g,'').toLowerCase().includes(q)):all;
  const seen=new Set();
  const items=relevant.filter(x=>{const k=x.title+'|'+x.link;if(seen.has(k))return false;seen.add(k);return true;}).sort((a,b)=>new Date(b.date||0)-new Date(a.date||0)).slice(0,limit);
  return {items,errors,checkedAt:new Date().toISOString(),sources:FEEDS.map(x=>x.name)};
}
async function fetchCodal(symbol='', limit=20) {
  const p=new URLSearchParams({Audited:'true',AuditorRef:'-1',Category:'-1',Childs:'true',CompanyState:'-1',CompanyType:'-1',Consolidatable:'true',IsNotAudited:'false',Isic:'-1',Length:'-1',LetterType:'-1',Mains:'true',NotAudited:'true',NotConsolidatable:'true',PageNumber:'1',Publisher:'false',Symbol:String(symbol||''),TracingNo:'-1',search:'true'});
  const url=`${CODAL_URL}?${p.toString()}`;
  const r=await get(url,{'accept':'application/json'}); const body=await r.text(); let data;
  try { data=JSON.parse(body); } catch { throw new Error('پاسخ کدال JSON قابل‌خواندن نبود؛ ممکن است API ساختار XML یا صفحه محدودیت برگردانده باشد.'); }
  const rows=Array.isArray(data?.Letters)?data.Letters:Array.isArray(data?.letters)?data.letters:Array.isArray(data?.items)?data.items:[];
  const items=rows.slice(0,limit).map(x=>({title:x.Title||x.title||x.LetterTypeTitle||'اطلاعیه کدال',symbol:x.Symbol||x.symbol||'',company:x.CompanyName||x.companyName||'',date:x.PublishDateTime||x.PublishDate||x.publishDate||'',link:x.Url?`https://www.codal.ir${String(x.Url).startsWith('/')?x.Url:`/${x.Url}`}`:(x.url||x.LetterUrl||''),source:'کدال',kind:'codal',importance:x.IsImportant||x.isImportant||false,trackingNo:x.TrackingNo||x.tracingNo||null}));
  return {items,checkedAt:new Date().toISOString(),source:'سامانه کدال',total:data?.Total||data?.total||items.length};
}
module.exports={FEEDS,CODAL_URL,fetchNews,fetchCodal,parseRss};
