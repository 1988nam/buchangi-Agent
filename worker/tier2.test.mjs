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

console.log('9) marketGateMap: 날짜별 코스피≥MA 판정(최신→과거, 표본부족 날짜는 맵 제외)');
const kbars = [
  { date: 'D5', close: 90 },   // MA3(90,100,110)=100 → false
  { date: 'D4', close: 100 },  // MA3(100,110,100)≈103.3 → false
  { date: 'D3', close: 110 },  // MA3(110,100,100)≈103.3 → true
  { date: 'D2', close: 100 },  // 표본 부족 → 맵에 없음
  { date: 'D1', close: 100 },
];
const gm = F.marketGateMap(kbars, 3);
ok(gm && gm.D5 === false && gm.D4 === false && gm.D3 === true, 'MA 비교 판정 정확');
ok(!('D2' in gm) && !('D1' in gm), '표본 부족 날짜는 맵에서 제외');
ok(F.marketGateMap(kbars.slice(0, 2), 3) === null, '봉 부족 → null');
ok(F.marketGateMap(null, 3) === null, 'null 입력 → null');

console.log('10) backtestSymbol: 시장 게이트는 진입만 차단(청산 무영향), 맵에 없는 날짜는 통과');
const candlesG = risingForBacktest();
const allDates = candlesG.map(c => c.date);
const cfgG = { ...cfgBt, partialTpPct: 0 };
const btBase = F.backtestSymbol(cfgG, candlesG);
const gateAllTrue = Object.fromEntries(allDates.map(d => [d, true]));
const gateAllFalse = Object.fromEntries(allDates.map(d => [d, false]));
ok(btBase.length > 0, `기준 거래 발생 (${btBase.length}건)`);
ok(F.backtestSymbol(cfgG, candlesG, gateAllTrue).length === btBase.length, '전일 통과 게이트 → 거래 동일');
ok(F.backtestSymbol(cfgG, candlesG, gateAllFalse).length === 0, '전일 관망 게이트 → 진입 0건');
ok(F.backtestSymbol(cfgG, candlesG, {}).length === btBase.length, '맵에 없는 날짜는 통과(라이브 폴백과 동일)');
ok(F.backtestSymbol(cfgG, candlesG, null).length === btBase.length, '게이트 미지정(null) → 기존 동작 보존');
// 진입일만 통과시키고 나머지 전부 관망 → 진입은 동일하게 발생하고, 관망일에도 청산은 막히지 않아야 함
const entryDates = new Set(btBase.map(t => t.entryDate));
const gateEntryOnly = Object.fromEntries(allDates.map(d => [d, entryDates.has(d)]));
const btEntryOnly = F.backtestSymbol(cfgG, candlesG, gateEntryOnly);
ok(btBase.some(t => !entryDates.has(t.exitDate)), '기준 시나리오에 관망일 청산 케이스 존재(테스트 유효성)');
ok(btEntryOnly.length === btBase.length, '관망일에도 청산 정상 수행(게이트는 진입 전용)');

console.log('11) rate-limit 판정: 조회(느슨) vs 주문(보수적)');
ok(F.isKisRateLimited(500, '초당 거래건수를 초과하였습니다.') === true, '조회: 500+초당거래건수 → limited');
ok(F.isKisRateLimited(200, '초당 거래건수를 초과하였습니다.') === false, '조회: 200이면 limited 아님(파싱 가능 응답)');
ok(F.isOrderRateLimited('초당 거래건수를 초과하였습니다.') === true, '주문: "초당 거래건수" → 재시도 대상');
ok(F.isOrderRateLimited('{"rt_cd":"1","msg_cd":"EGW00201","msg1":"..."}') === true, '주문: EGW00201 → 재시도 대상');
ok(F.isOrderRateLimited('주문가능금액을 초과하였습니다.') === false, '주문: 잔고 부족 "초과"는 재시도 금지(중복주문 방지)');
ok(F.isOrderRateLimited('모의투자 장종료') === false, '주문: 일반 오류는 재시도 금지');
ok(F.isOrderRateLimited('') === false && F.isOrderRateLimited(null) === false, '빈/널 입력 → false');

console.log('12) subrequest 예산: 리셋/차감/주문 몫 보호');
F.subreqReset(50); // 무료 플랜: 50 - KV몫(12) = 38
ok(F.subreqLeft() === 38, `리셋 후 잔여 38 (실제 ${F.subreqLeft()})`);
for (let i = 0; i < 30; i++) F.subreqTake();
ok(F.subreqLeft() === 8, `30건 사용 후 잔여 8 (실제 ${F.subreqLeft()})`);
ok(F.subreqLeft() > F.SUBREQ_ORDER_RESERVE, '주문 몫(6)보다 위 → 조회 계속 가능');
F.subreqTake(); F.subreqTake();
ok(F.subreqLeft() === F.SUBREQ_ORDER_RESERVE, '잔여=주문 몫 → 조회는 차단, 주문은 가능 경계');
F.subreqReset(1000); // 유료 플랜 상향
ok(F.subreqLeft() === 988, `cfSubreqLimit=1000 → 잔여 988 (실제 ${F.subreqLeft()})`);
F.subreqReset('x'); // 비정상 입력 → 무료 플랜 기본값 폴백
ok(F.subreqLeft() === 38, '비정상 limit 입력 → 기본 50 기준 폴백');

console.log('13) parseHolding: 모의투자 평가손익 0 보완 계산');
// 정상 응답(실전): KIS 값 그대로 통과
const hReal = F.parseHolding({ prdt_name: 'A', pdno: '000001', hldg_qty: '10', pchs_avg_pric: '1000', prpr: '1100', evlu_amt: '11000', evlu_pl_amt: '985', evlu_erng_rt: '9.85' });
ok(hReal.pnl === 985 && hReal.yield === 9.85 && hReal.value === 11000, 'KIS 값 있으면 그대로(수수료 반영값 보존)');
// 모의: 손익/수익률 0으로 옴 → 평단·현재가로 계산 (사용자 사례: SK네트웍스 74주 13,430→13,610)
const hMock = F.parseHolding({ prdt_name: 'SK네트웍스', pdno: '001740', hldg_qty: '74', pchs_avg_pric: '13430', prpr: '13610', evlu_amt: '1007140', evlu_pl_amt: '0', evlu_erng_rt: '0' });
ok(hMock.pnl === Math.round((13610 - 13430) * 74), `손익 0 → 보완 ${hMock.pnl}원(=180×74)`);
ok(approx(hMock.yield, +(((13610 - 13430) / 13430) * 100).toFixed(2)), `수익률 0 → 보완 ${hMock.yield}%`);
// 손실 케이스(화신정공 190주 5,250→5,130)
const hLoss = F.parseHolding({ prdt_name: '화신정공', pdno: '126640', hldg_qty: '190', pchs_avg_pric: '5250', prpr: '5130', evlu_amt: '974700', evlu_pl_amt: '0', evlu_erng_rt: '0' });
ok(hLoss.pnl === Math.round((5130 - 5250) * 190) && hLoss.pnl < 0, `손실도 보완 (${hLoss.pnl}원)`);
ok(hLoss.yield < 0, `손실 수익률 음수 (${hLoss.yield}%)`);
// 평가금 0/누락 → qty×현재가로 보완
const hNoVal = F.parseHolding({ prdt_name: 'B', pdno: '000002', hldg_qty: '5', pchs_avg_pric: '100', prpr: '110' });
ok(hNoVal.value === 550, '평가금 누락 → qty×현재가');
// 평단==현재가 → 0 유지, 필드 전부 누락 → NaN 없이 0
const hFlat = F.parseHolding({ hldg_qty: '3', pchs_avg_pric: '100', prpr: '100' });
ok(hFlat.pnl === 0 && hFlat.yield === 0, '평단=현재가 → 손익/수익률 0');
const hEmpty = F.parseHolding({});
ok(hEmpty.qty === 0 && hEmpty.pnl === 0 && hEmpty.yield === 0 && hEmpty.value === 0 && !Number.isNaN(hEmpty.value), '빈 입력 → 전부 0(NaN 없음)');

console.log('14) kstStrToMs: 워치독 staleness 판정용 KST 문자열 파싱');
ok(F.kstStrToMs('20260612 10:19 KST') === Date.UTC(2026, 5, 12, 1, 19), 'KST 10:19 → UTC 01:19');
ok(F.kstStrToMs('20260612 00:30 KST') === Date.UTC(2026, 5, 11, 15, 30), '자정 직후 KST → 전날 UTC(경계 처리)');
ok(F.kstStrToMs(null) === 0 && F.kstStrToMs('') === 0 && F.kstStrToMs('garbage') === 0, '비정상 입력 → 0(즉시 보충 실행 허용)');

console.log('15) settledCash: D+2 예수금/금일매매 보정(매수 당일 현금 미반영 버그 수정)');
// 사용자 사례 A: D+2가 정산을 반영(실전) — D+2를 골라야 함
ok(F.settledCash({ dnca_tot_amt: '10000000', nxdy_excc_amt: '10000000', prvs_rcvb_amt: '5398136' }) === 5398136, 'D+2 ≠ D+0 → D+2 신뢰');
ok(F.settledCash({ dnca_tot_amt: '10000000', prvs_rcvb_amt: '0' }) === 0, 'D+2가 정당한 0원(전액투자)이면 0 유지 — D+0 폴백 금지');
ok(F.settledCash({ dnca_tot_amt: '10000000', nxdy_excc_amt: '7000000' }) === 7000000, 'D+2 누락 → D+1 폴백');
// 사용자 사례 B: 모의투자 — D+2조차 D+0과 동일(당일 체결 미반영) → 금일매수금액으로 직접 차감
ok(F.settledCash({ dnca_tot_amt: '10000000', prvs_rcvb_amt: '10000000', thdt_buy_amt: '4601864', thdt_sll_amt: '0' }) === 5398136, 'D+2 = D+0 → 금일매수 차감');
ok(F.settledCash({ dnca_tot_amt: '10000000', prvs_rcvb_amt: '10000000', thdt_buy_amt: '5000000', thdt_sll_amt: '2000000' }) === 7000000, '금일매도는 다시 더함');
ok(F.settledCash({ dnca_tot_amt: '1000', thdt_buy_amt: '5000' }) === 0, '음수 방지 clamp(0)');
ok(F.settledCash({ dnca_tot_amt: '10000000', prvs_rcvb_amt: '' }) === 10000000, 'D+2 빈문자열·금일매매 없음 → D+0 그대로');
ok(F.settledCash({ prvs_rcvb_amt: 'abc', dnca_tot_amt: '10000000' }) === 10000000, '파싱 불가 값 건너뜀');
ok(F.settledCash({}) === 0 && F.settledCash(null) === 0, '빈/널 입력 → 0');

console.log('16) dayPnlFrom: 매매 기반 일일손익(입출금·계좌리셋 오염 없음)');
const TODAY = '20260616';
const h = (pnl) => ({ pnl }); // 보유 종목(평가손익만 필요)
// 첫 사이클: dayStartUnrealized=null → 평가손익 변동분 0, 오늘 실현만 반영
ok(F.dayPnlFrom([], [h(50000)], null, TODAY) === 0, '첫 사이클(기준점 null) → 평가손익 변동 0');
ok(F.dayPnlFrom([{ t: TODAY + ' 10:00 KST', dry: false, pnl: 3000 }], [], null, TODAY) === 3000, '첫 사이클이라도 오늘 실현은 반영');
// 평가손익이 기준점 대비 오른 만큼만 일일손익에 잡힘(평가손익 절대값 아님)
ok(F.dayPnlFrom([], [h(120000)], 100000, TODAY) === 20000, '평가손익 100k→120k → +20k(절대값 120k 아님)');
ok(F.dayPnlFrom([], [h(80000)], 100000, TODAY) === -20000, '평가손익 100k→80k → -20k');
// 오늘 실현 + 평가손익 변동 합산
ok(F.dayPnlFrom([{ t: TODAY + ' 11:00 KST', dry: false, pnl: 5000 }], [h(110000)], 100000, TODAY) === 15000, '실현 5k + 평가Δ 10k = 15k');
// 핵심: 입금/계좌리셋으로 현금·총자산이 폭증해도 평가손익·실현이 그대로면 일일손익 불변
ok(F.dayPnlFrom([{ t: TODAY + ' 12:00 KST', dry: false, pnl: -77209 }], [h(5000)], 5000, TODAY) === -77209,
  '현금 590만 입금돼도(holdings/실현 불변) 일일손익 = 실현 -77,209 그대로(버그 재발 방지)');
// dry 청산은 제외(실계좌 보유분 평가손익과 이중계상 방지)
ok(F.dayPnlFrom([{ t: TODAY + ' 10:00 KST', dry: true, pnl: 9999 }], [], 0, TODAY) === 0, 'dry 청산은 일일손익에서 제외');
ok(F.dayPnlFrom([{ t: TODAY + ' 10:00 KST', dry: false, pnl: 100 }, { t: TODAY + ' 10:01 KST', dry: true, pnl: 9999 }], [], 0, TODAY) === 100, '실거래만 합산(dry 무시)');
// 어제 청산은 제외(오늘분만)
ok(F.dayPnlFrom([{ t: '20260615 14:00 KST', dry: false, pnl: 8888 }], [], 0, TODAY) === 0, '어제 실현은 오늘 일일손익에 미포함');
// 방어: 비정상 입력
ok(F.dayPnlFrom(null, null, null, TODAY) === 0, 'null 입력 → 0(NaN 없음)');
ok(F.dayPnlFrom([{ dry: false, pnl: 100 }], [], 0, TODAY) === 0, 't 누락 거래는 무시(날짜 매칭 불가)');

console.log('17) recordFill: 체결 원장 적재/순서/상한');
{
  const stA = {};
  F.recordFill(stA, { t: 'a', kind: '매수', ticker: '1', qty: 10 });
  F.recordFill(stA, { t: 'b', kind: '매도', ticker: '1', qty: 10, pnl: 500 });
  ok(Array.isArray(stA.fills) && stA.fills.length === 2, 'fills 미존재 시 배열 초기화 후 적재');
  ok(stA.fills[0].t === 'a' && stA.fills[1].t === 'b', '시간순(append) 보존');
  ok(stA.fills[1].pnl === 500, '매도 pnl 보존');
  // 상한: FILLS_MAX(300) 초과분은 앞에서 잘리고 최신이 유지
  const stB = { fills: [] };
  for (let i = 0; i < 305; i++) F.recordFill(stB, { t: 't' + i, kind: '매수', ticker: 'x', qty: 1 });
  ok(stB.fills.length === 300, `상한 300 유지 (실제 ${stB.fills.length})`);
  ok(stB.fills[stB.fills.length - 1].t === 't304', '최신 체결 유지(꼬리 보존)');
  ok(stB.fills[0].t === 't5', '오래된 체결은 앞에서 제거(t0~t4 잘림)');
}

console.log(`\n결과: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
