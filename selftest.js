'use strict';
const assert = require('node:assert/strict');
const dc = require('../decision-center');

assert.equal(dc.marketClock(new Date('2026-11-19T06:30:00Z')).open, true); // Thu 10:00 Tehran
assert.equal(dc.marketClock(new Date('2026-11-20T06:30:00Z')).open, false); // Fri
assert.equal(dc.parseTsetmcStamp('20261119', '100000').toISOString(), '2026-11-19T06:30:00.000Z');
const closed = dc.evaluate({symbol:'TEST', technical:{available:false}, options:[]}, {
  now:new Date('2026-11-20T06:30:00Z'), marketFetchedAt:new Date('2026-11-20T06:29:30Z'),
  quote:{}, capitalToman:5000000, riskPct:0.005, maxRiskPct:0.01, minRR:2
});
assert.equal(closed.decision, 'عدم معامله');
assert.ok(closed.blockers.length >= 3);
const liquid = dc.liquidityStats([{strike:100,daysRemaining:20,contractSize:1000,bid:10,ask:11,volume:1,value:100,spreadPct:9}]);
assert.equal(liquid.count, 1);
const illiquid = dc.liquidityStats([{strike:100,daysRemaining:20,contractSize:1000,bid:0,ask:0,volume:0,value:0}]);
assert.equal(illiquid.count, 0);
const noFakeSignal = dc.evaluate({
  symbol:'TEST', spot:100, technical:{available:true,direction:'صعودی',rsi14:55,macd:2,macdSignal:1,volumeRatio:1.2},
  fundamentals:{available:true}, flow:{available:true,individualNet:100,buyerPower:1.2},
  news:[{title:'افزایش فروش'}], codal:[], sentiment:{label:'مثبت'},
  options:[{insCode:'X',strike:100,daysRemaining:20,contractSize:1000,bid:0,ask:0,volume:0,value:0}],
  longCandidates:[{option:{insCode:'X',ticker:'X'},strategy:'Call',quantity:1,maxLoss:100,targetProfit:300,rr:3}],
  spreads:[],straddles:[],quote:{date:'20261119',time:'100000'}
}, {
  now:new Date('2026-11-19T06:30:30Z'), marketFetchedAt:new Date('2026-11-19T06:30:00Z'),
  capitalToman:5000000,riskPct:0.005,maxRiskPct:0.01,minRR:2
});
assert.equal(noFakeSignal.decision, 'عدم معامله');
console.log('Self-tests passed.');
