// Tier 2 순수 로직 단위 테스트 (수학 정확성). 실행: node worker/tier2.test.mjs
import { _internals as F } from './buchangi-worker.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ❌ ' + msg); } };
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── 합성 일봉 생성기 ──
// 라이브 컨벤션: candles[0]=최신, 각 {open,high,low,close,volume}
function trendUp(n, start = 100, step = 2) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const base = start + i * step;          // i 커질수록 상승(과거→현재 순으로 만든 뒤 reverse)
    arr.push({ open: base, high: base + 1, low: base - 1, close: base + 0.5, volume: 1000 + i });
  }
  return arr.reverse(); // 최신이 [0]
}
function choppy(n, mid = 100) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    const up = i % 2 === 0;
    const c = mid + (up ? 1 : -1);
    arr.push({ open: mid, high: mid + 1.2, low: mid - 1.2, close: c, volume: 1000 });
  }
  return arr.reverse();
}

console.log('1) clampFrac');
ok(F.clampFrac(0.5) === 0.5 && F.clampFrac(-1) === 0 && F.clampFrac(2) === 1 && F.clampFrac('x') === 1, 'clampFrac [0,1] + NaN→1');

console.log('2) regimeFactorFor');
const cfgR = { regimeMinFraction: 0.4, regimeFullMarginPct: 3 };
ok(approx(F.regimeFactorFor(103, 100, cfgR), 1), '+3% 마진 → 풀(1)');
ok(approx(F.regimeFactorFor(101.5, 100, cfgR), 0.5), '+1.5% → 0.5');
ok(approx(F.regimeFactorFor(100.1, 100, cfgR), 0.4), '얇은 마진 → 하한 0.4 clamp');
ok(F.regimeFactorFor(100, 100, { ...cfgR, regimeFullMarginPct: 0 }) === 1, 'fullPct=0 → 중립(1, 0나눗셈 가드)');
ok(F.regimeFactorFor(NaN, 100, cfgR) === 1, 'kospi NaN → 1');

console.log('3) ADX: 추세장 > 횡보장, [0,100]');
const adxTrend = F.adx(trendUp(60), 14);
const adxChop = F.adx(choppy(60), 14);
ok(adxTrend != null && adxTrend >= 0 && adxTrend <= 100, `추세 ADX 범위 (${adxTrend?.toFixed(1)})`);
ok(adxChop != null && adxChop >= 0 && adxChop <= 100, `횡보 ADX 범위 (${adxChop?.toFixed(1)})`);
ok(adxTrend > adxChop, `추세 ADX(${adxTrend?.toFixed(1)}) > 횡보 ADX(${adxChop?.toFixed(1)})`);
ok(F.adx(trendUp(10), 14) === null, '봉 부족 → null');
// adxAt(시간순)도 동일 시리즈에서 합리적 값
const chrono = trendUp(60).slice().reverse(); // 과거→최신
ok(F.adxAt(chrono, chrono.length, 14) != null, 'adxAt 산출');

console.log('4) backtestSymbol: 분할익절이 수량을 쪼개고 풀익절로 잔량 청산');
// 명확한 상승 시나리오: 진입 후 가격이 계속 올라 부분익절(+3%) 후 풀익절(+7%) 도달
function risingForBacktest() {
  // 과거→현재로 만들고(최신=[0] 위해 reverse), warmup 위해 충분히 길게
  const arr = [];
  let p = 100;
  for (let i = 0; i < 40; i++) {
    // 완만 상승, 변동폭 작게 → 돌파 발생하도록 마지막 구간에서 점프
    const drift = i < 30 ? 0.1 : 1.5;
    p += drift;
    arr.push({ date: '202604' + String(i + 1).padStart(2, '0'), open: p, high: p + 2, low: p - 0.5, close: p + 1, volume: 2000 });
  }
  return arr.reverse();
}
const cfgBt = {
  breakoutK: 0.3, maPeriod: 5, takeProfitPct: 7, stopLossPct: 3, atrPeriod: 14,
  useAtrStop: false, useTrailingStop: false, trailAtrMult: 2.5, trailArmPct: 1, atrStopMult: 2,
  requireVolumeConfirm: false, volMultiplier: 1.5, requireRangeExpansion: false,
  closeOnEod: false, orderKrw: 1000000,
  partialTpPct: 3, partialTpFraction: 0.5, requireAdx: false, adxPeriod: 14, adxMin: 20,
};
const bt = F.backtestSymbol(cfgBt, risingForBacktest());
const partials = bt.filter(t => t.partial);
ok(bt.length > 0, `거래 발생 (${bt.length}건)`);
ok(partials.length >= 1, `부분익절 발생 (${partials.length}건)`);
// 부분익절 수량 < 동일 진입의 잔량 청산 수량의 합 관계: 부분익절 qty는 floor(entryQty*0.5)
if (partials.length) {
  const p = partials[0];
  ok(p.pct > 0 && p.pct < cfgBt.takeProfitPct, `부분익절 수익률 0<${p.pct}<${cfgBt.takeProfitPct}`);
}
// closeOnEod OFF에서는 partial 외 청산 reason이 익절/손절/트레일링 중 하나
ok(bt.every(t => ['부분익절', '익절', '손절', 'ATR손절', '트레일링', '종가청산'].includes(t.reason)), '청산 사유 유효');

console.log('5) backtestSymbol: 분할익절 OFF(partialTpPct=0)면 partial 거래 없음(현재동작 보존)');
const bt0 = F.backtestSymbol({ ...cfgBt, partialTpPct: 0 }, risingForBacktest());
ok(bt0.every(t => !t.partial), 'partialTpPct=0 → 부분익절 없음');

console.log('6) tradeStats: 승률/MDD');
const st = F.tradeStats([{ pnl: 100, pct: 5 }, { pnl: -50, pct: -2 }, { pnl: 30, pct: 1 }]);
ok(st.count === 3 && st.wins === 2 && st.winRate === 66.7, `승률 ${st.winRate}% (2/3)`);
ok(st.totalPnl === 80, `누적손익 ${st.totalPnl}`);
ok(st.maxDrawdown <= 0, `MDD ≤ 0 (${st.maxDrawdown})`);
const stDry = F.tradeStats([{ pnl: 1, dry: true }, { pnl: 2, dry: false }], { dryOnly: true });
ok(stDry.count === 1, 'dryOnly 필터');

console.log('7) ADX gate가 requireAdx=false면 백테스트 무영향(거래 동일)');
const btNoAdx = F.backtestSymbol({ ...cfgBt, partialTpPct: 0, requireAdx: false }, risingForBacktest());
const btAdxOffSame = F.backtestSymbol({ ...cfgBt, partialTpPct: 0, requireAdx: false, adxMin: 99 }, risingForBacktest());
ok(btNoAdx.length === btAdxOffSame.length, 'requireAdx=false면 adxMin 무관(동일 거래수)');

console.log('8) backtestSymbol: 같은 봉에서 부분익절가+손절가 동시 도달 시 전량 손절 우선(보수적)');
// chronological(과거→최신) 구성 후 newest-first로 뒤집어 전달
function dualTouchScenario() {
  const chrono = [];
  // 평탄 워밍업(range=0 → 조기진입 차단)
  for (let i = 0; i < 18; i++) chrono.push({ date: 'w' + i, open: 100, high: 100, low: 100, close: 100, volume: 1000 });
  // W: 변동폭만 만드는 봉(직전 range=0이라 W에선 진입 안 함)
  chrono.push({ date: 'W', open: 100, high: 102, low: 98, close: 100, volume: 1000 });
  // X: 돌파 진입(prev=W range=4, target=100+0.3*4=101.2, high105 → entry≈101.2). 진입봉은 청산검사 스킵.
  chrono.push({ date: 'X', open: 100, high: 105, low: 100, close: 104, volume: 1000 });
  // Y: 같은 봉에서 부분익절가(+3%≈104.2)도 닿고 손절가(-3%≈98.16) 아래도 닿음 → 손절 우선이어야 함
  chrono.push({ date: 'Y', open: 104, high: 105, low: 95, close: 96, volume: 1000 });
  for (let i = 0; i < 5; i++) chrono.push({ date: 'z' + i, open: 96, high: 97, low: 95, close: 96, volume: 1000 });
  return chrono.reverse(); // newest-first
}
const cfgDual = { ...cfgBt, partialTpPct: 3, partialTpFraction: 0.5, takeProfitPct: 7, stopLossPct: 3, useAtrStop: false, useTrailingStop: false, closeOnEod: false };
const btDual = F.backtestSymbol(cfgDual, dualTouchScenario());
ok(btDual.length >= 1, `거래 발생 (${btDual.length})`);
ok(!btDual.some(t => t.partial), '동시 도달 봉에서 부분익절 미발생(손절 우선) ✅');
ok(btDual.some(t => t.reason === '손절'), '손절로 청산됨');

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
