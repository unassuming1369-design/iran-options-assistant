'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const dc=require('../decision-center');
const rs=require('../research-sources');
assert.equal(dc.marketClock(new Date('2026-11-19T06:30:00Z')).open,true);
assert.equal(dc.marketClock(new Date('2026-11-20T06:30:00Z')).open,false);
assert.equal(dc.parseTsetmcStamp('20261119','100000').toISOString(),'2026-11-19T06:30:00.000Z');
const closed=dc.evaluate({symbol:'TEST',technical:{available:false},options:[]},{now:new Date('2026-11-20T06:30:00Z'),marketFetchedAt:new Date('2026-11-20T06:29:30Z'),quote:{},capitalToman:5000000,riskPct:0.005,maxRiskPct:0.01,minRR:2});
assert.equal(closed.decision,'عدم معامله');assert.ok(closed.blockers.length>=3);
assert.equal(dc.liquidityStats([{strike:100,daysRemaining:20,contractSize:1000,bid:10,ask:11,volume:1,value:100,spreadPct:9}]).count,1);
assert.equal(dc.liquidityStats([{strike:100,daysRemaining:20,contractSize:1000,bid:0,ask:0,volume:0,value:0}]).count,0);
assert.equal(rs.parseRss('<rss><channel><item><title>خبر آزمایشی</title><link>https://example.com/a</link><pubDate>Wed, 19 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>','تست')[0].title,'خبر آزمایشی');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opt-position-'));process.env.POSITION_DATA_DIR=dir;
const pm=require('../position-manager');
const p=pm.add({chatId:'1',underlying:'فولاد',optionTicker:'TEST-C',type:'call',side:'long',strike:10000,expiry:'1405/12/20',entryToman:850,quantity:2,contractSize:1000});
assert.equal(pm.list('1',true).length,1);
const m=pm.mark(p,{bid:7000,ask:7200});assert.equal(m.markToman,700);assert.equal(m.pnlToman,-300000);
assert.ok(pm.report(p,{bid:7000,ask:7200}).includes('سود/زیان'));
assert.ok(pm.close('1',p.id));assert.equal(pm.list('1',true).length,0);
fs.rmSync(dir,{recursive:true,force:true});

assert.equal(require('../core').normalizeSymbol('ضهرم۹۰۲۸'), require('../core').normalizeSymbol('ضهرم9028'));
const parsed = require('../core').normalizeOptionRows([{
  uaInsCode:'12345', lVal18AFC_UA:'اهرم', lVal30_UA:'صندوق اهرمی',
  strikePrice:100000, contractSize:1000, remainedDay:25, endDate:'2027/01/20',
  insCode_C:'9001', lVal18AFC_C:'ضهرم۹۰۲۸', pMeDem_C:900, pMeOf_C:1000,
  qTotTran5J_C:1200, qTotCap_C:1200000,
  insCode_P:'9002', lVal18AFC_P:'طهرم۹۰۲۸', pMeDem_P:800, pMeOf_P:900,
  qTotTran5J_P:500, qTotCap_P:450000
}]);
assert.equal(parsed.length,2);
assert.equal(require('../core').findUnderlyingGroup(parsed,'اهرم').options.length,2);
const candidate = require('../core').calcLongOptionCandidate(
  {type:'call',entry:1000,ask:1000,bid:900,strike:100000,daysRemaining:25,spreadPct:10,contractSize:1000},
  'صعودی',{upsideTarget:120000},110000,600000,1000,2,3000000,0.20
);
assert.equal(candidate.quantity,30);
assert.equal(candidate.totalCost,3000000);
assert.equal(candidate.maxLoss,600000);

console.log('Self-tests passed.');
