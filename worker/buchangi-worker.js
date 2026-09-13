/**
 * 부챙이 자동매매 워커 (Cloudflare Worker)
 * ====================================================================
 * 역할: 브라우저와 무관하게 Cron으로 깨어나 KIS(한국투자증권) OpenAPI로
 *       국내주식을 "스스로" 매매한다. 동시에 대시보드용 HTTP API를 제공한다.
 *
 * 두 진입점:
 *   - scheduled(): Cron Trigger → 1 매매 사이클 실행
 *   - fetch():     대시보드 ↔ 워커 (상태/로그 조회, 설정/킬스위치, 수동 실행)
 *
 * 안전: 모의투자(mock) 기본 · dry-run 기본 ON · kill-switch · 일일 손실/주문 한도.
 *       자세한 규칙은 docs/strategy.md 참고.
 *
 * 비밀값: ADMIN_TOKEN(대시보드 인증)은 `wrangler secret put ADMIN_TOKEN`.
 *         KIS appkey/secret/계좌는 대시보드에서 입력 → KV(cfg)에 저장(응답엔 마스킹).
 * ====================================================================
 */

const KIS = {
  real: 'https://openapi.koreainvestment.com:9443',
  mock: 'https://openapivts.koreainvestment.com:29443',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const LOG_MAX = 300; // KV 로그 링버퍼 최대 길이

// 기본 설정 (대시보드에서 덮어씀)
const DEFAULT_CFG = {
  enabled: false,        // 자동매매 마스터 스위치
  dryRun: true,          // true면 주문 전송 안 함(로그만)
  killSwitch: false,     // true면 신규 주문 전면 중단
  tradeEnv: 'mock',      // 'mock' | 'real'

  // KIS 거래 크레덴셜
  appkey: '', secret: '', account: '',  // account: 숫자 10자리(앞8=CANO, 뒤2=상품코드)

  // 데이터 조회 전용 크레덴셜(실전 도메인, 선택) — 모의 거래 시 시세 확보용
  dataAppkey: '', dataSecret: '',

  // 전략 파라미터
  watchlist: [],         // [{ticker:'005930', name:'삼성전자'}]
  orderKrw: 500000,      // 1회 매수액(원)
  breakoutK: 0.5,        // 변동성 돌파 계수
  maPeriod: 5,           // 종목 추세 이동평균 일수
  takeProfitPct: 5,      // 익절 %
  stopLossPct: 3,        // 손절 %
  marketMaPeriod: 20,    // 코스피 추세 MA(게이트 ①)
  cashFloorPct: 30,      // 현금 비중 하한 %(게이트 ②)
  maxPositionPct: 25,    // 종목당 최대 비중 %(게이트 ②)
  dailyMaxLossKrw: 200000, // 일일 최대 손실액(게이트 ③)
  dailyMaxOrders: 10,    // 일일 최대 주문 횟수(게이트 ③)
  closeOnEod: false,     // 장 마감 전 당일 진입분 청산

  // 리스크: ATR 변동성 스탑 + 트레일링 스탑 (Tier 1)
  atrPeriod: 14,         // ATR 계산 기간(일)
  useAtrStop: false,     // true면 손절을 ATR 기반으로(진입가 - atrStopMult×ATR)
  atrStopMult: 2.0,      // ATR 손절 배수
  useTrailingStop: false, // true면 트레일링 스탑(고점 - trailAtrMult×ATR 이탈 시 청산)
  trailAtrMult: 2.5,     // 트레일링 스탑 ATR 배수
  trailArmPct: 1,        // 트레일링 발동 최소 수익 %(이 이상 올라야 트레일 시작)

  // 진입 품질 확인 (Tier 1) — 가짜 돌파 억제
  requireVolumeConfirm: false, // 돌파 시 거래량 증가 요구
  volMultiplier: 1.5,    // 당일 거래량 ≥ volMultiplier × 평균거래량(maPeriod)
  requireRangeExpansion: false, // 당일 변동폭 ≥ 직전 ATR(확장 돌파만)

  // 분할매매 (Tier 2)
  entryTranches: 1,        // orderKrw를 N등분해 사이클마다 1트랜치씩 최대 N회 진입(1=단발=현재동작)
  partialTpPct: 0,         // 부분익절 발동 수익%(0=비활성). takeProfitPct보다 작게 설정해야 의미.
  partialTpFraction: 0.5,  // 부분익절 시 매도 비율(0~1)

  // regime(시장체제) 적응형 사이징 (Tier 2) — 라이브 전용
  regimeSizing: false,     // 코스피 vs MA 마진에 비례해 1회 매수액 축소
  regimeFullMarginPct: 3,  // 코스피가 MA보다 이 %↑면 풀사이즈(factor=1)
  regimeMinFraction: 0.4,  // 축소 하한(0~1). 1이면 사실상 비활성
  regimeFallbackFull: true,// 코스피 데이터 없을 때 풀사이즈(끄면 regimeMinFraction로 축소)

  // ADX 추세강도 진입 필터 (Tier 2)
  requireAdx: false,       // ADX≥adxMin일 때만 신규 진입(횡보 억제)
  adxPeriod: 14,           // ADX 기간(일봉 ~30봉 한계상 10~14 권장, 키우면 매수 멈출 수 있음)
  adxMin: 20,              // 진입 허용 최소 ADX(20~25 권장)

  // 전략 추천(스캐너) — 워치리스트 후보를 자동 발굴
  recommendSource: 'volume',     // 후보 유니버스: 'volume'(거래량순위) | 'marketcap'(시총순위) | 'both'
  recommendCount: 30,            // 스캔할 후보 수(5~40, KIS 서브요청 한도 고려)
  recommendShortlist: 8,         // 정량 통과 중 AI 정성검토로 넘길 상위 N
  // 정성 2차(Gemini)는 대시보드(브라우저)에서 호출한다 — Google이 무료 Gemini API를
  // 서버 위치(워커 출구 IP) 기준으로 지역차단하기 때문. 키는 브라우저 localStorage에 보관.

  // 인프라
  cfSubreqLimit: 50,             // Cloudflare invocation당 subrequest 한도(무료 50, 유료 1000). 플랜 업그레이드 시 /api/config로 상향
};

// ── 시간 유틸 (KST) ──────────────────────────────────────────────
// Cloudflare 런타임 Date는 UTC. +9h 시프트 후 getUTC*로 KST 필드를 읽는다.
function nowKST() { return new Date(Date.now() + 9 * 3600 * 1000); }
function ymd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
function hhmm(d) {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function isMarketHours(d) {
  const dow = d.getUTCDay();              // 시프트된 날짜에서 KST 요일
  if (dow === 0 || dow === 6) return false; // 주말 (공휴일은 V1 미반영)
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 9 * 60 && mins <= 15 * 60 + 20; // 09:00 ~ 15:20
}
function isEodWindow(d) {
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 15 * 60 + 10; // 15:10 이후
}

// ── KV 헬퍼 ──────────────────────────────────────────────────────
async function getCfg(env) {
  const raw = await env.BUCHANGI_KV.get('cfg', 'json');
  const cfg = { ...DEFAULT_CFG, ...(raw || {}) };
  // 구버전 마이그레이션: 서버측 Gemini 제거됨 → 저장돼 있던 키/모델 폐기(노출 방지, 다음 저장 시 KV에서도 사라짐)
  delete cfg.geminiApiKey; delete cfg.geminiModel;
  return cfg;
}
async function setCfg(env, cfg) {
  await env.BUCHANGI_KV.put('cfg', JSON.stringify(cfg));
}
async function getState(env) {
  return (await env.BUCHANGI_KV.get('state', 'json')) || freshDay(ymd(nowKST()));
}
async function setState(env, state) {
  await env.BUCHANGI_KV.put('state', JSON.stringify(state));
}
// 중복 실행 방지용 best-effort 락(cron×수동 /api/run, 겹치는 cron의 state lost-update 완화).
// KV는 강한 일관성이 아니라 완벽하진 않음 — TTL로 크래시 시 자동 해제. 완전한 직렬화는 Durable Objects 필요.
async function acquireLock(env, ttlSec = 90) {
  const now = Date.now();
  const cur = await env.BUCHANGI_KV.get('lock', 'json');
  if (cur && cur.until > now) return false;
  await env.BUCHANGI_KV.put('lock', JSON.stringify({ until: now + ttlSec * 1000 }), { expiration: Math.floor(now / 1000) + ttlSec });
  return true;
}
async function releaseLock(env) {
  try { await env.BUCHANGI_KV.delete('lock'); } catch (_) {}
}
function freshDay(today) {
  return { day: today, dayStartValue: null, dayStartUnrealized: null, dayPnl: 0, dayOrders: 0, bought: {}, peak: {}, tranches: {}, partialDone: {}, trades: [], fills: [], lastCycleAt: null, scanCursor: 0 };
}
const TRADES_MAX = 200; // 성과 추적용 실현/모의 매도 기록 보관 수
function recordTrade(state, tr) {
  if (!Array.isArray(state.trades)) state.trades = [];
  state.trades.push(tr);
  if (state.trades.length > TRADES_MAX) state.trades = state.trades.slice(-TRADES_MAX);
}
const FILLS_MAX = 300; // 체결 원장 보관 수 — "실제로 사고 판 것"만(매수+매도). 동작 로그의 게이트/신호 노이즈 제외.
// 체결 원장: 성공한 주문(매수/매도, dry 포함)만 시간순으로 적재. trades(매도 P&L 라운드트립)와
// 별개로 "실집행 내역"을 보존한다 → 대시보드 실적 로그는 동작 로그의 잡음 없이 이것만 보여준다.
function recordFill(state, fill) {
  if (!Array.isArray(state.fills)) state.fills = [];
  state.fills.push(fill);
  if (state.fills.length > FILLS_MAX) state.fills = state.fills.slice(-FILLS_MAX);
}
// 거래 기록 → 성과지표(승률/누적손익/MDD). dry/실거래 분리 집계.
function tradeStats(trades, { dryOnly } = {}) {
  const list = (trades || []).filter(t => dryOnly == null ? true : !!t.dry === dryOnly);
  const n = list.length;
  const wins = list.filter(t => t.pnl > 0).length;
  const totalPnl = list.reduce((a, t) => a + (t.pnl || 0), 0);
  // 누적손익 곡선 기준 최대낙폭(MDD)
  let cum = 0, peak = 0, mdd = 0;
  for (const t of list) { cum += t.pnl || 0; peak = Math.max(peak, cum); mdd = Math.min(mdd, cum - peak); }
  const avgPct = n ? list.reduce((a, t) => a + (t.pct || 0), 0) / n : 0;
  return {
    count: n, wins, losses: n - wins,
    winRate: n ? +(wins / n * 100).toFixed(1) : 0,
    totalPnl, avgPct: +avgPct.toFixed(2), maxDrawdown: Math.round(mdd),
  };
}
// 일일 손익: 총자산 차이가 아니라 "매매 성과"로 정의한다. 현금잔고를 절대 읽지 않으므로
// 입출금·모의계좌 리셋·D+2 예수금 정산 아티팩트가 손익으로 둔갑하지 않는다.
//   = 오늘 실현손익(실거래분, dry 제외) + (현재 평가손익 − 그날 첫 사이클 평가손익)
// 실현은 dry 제외 — 평가손익을 실계좌 보유분(holdings)에서 읽으므로, dry 청산을 더하면
// "팔았지만 실제론 그대로 보유 중인" 포지션을 이중계상하게 된다. dayStartUnrealized=null
// (그날 첫 사이클)이면 평가손익 변동분은 0(지금을 기준점으로 스냅샷).
function dayPnlFrom(trades, holdings, dayStartUnrealized, today) {
  const realizedToday = (trades || [])
    .filter(t => !t.dry && typeof t.t === 'string' && t.t.slice(0, 8) === today)
    .reduce((a, t) => a + (t.pnl || 0), 0);
  const unrealizedNow = (holdings || []).reduce((a, h) => a + (h.pnl || 0), 0);
  const base = dayStartUnrealized == null ? unrealizedNow : dayStartUnrealized;
  return Math.round(realizedToday + (unrealizedNow - base));
}
async function appendLog(env, entries) {
  try {
    if (!env || !env.BUCHANGI_KV) {
      console.warn('appendLog: BUCHANGI_KV 바인딩이 없습니다. 로그를 KV에 저장할 수 없습니다.');
      console.log(entries);
      return;
    }
    const arr = (await env.BUCHANGI_KV.get('log', 'json')) || [];
    const next = arr.concat(entries).slice(-LOG_MAX);
    await env.BUCHANGI_KV.put('log', JSON.stringify(next));
  } catch (e) {
    console.error('appendLog 실패:', e);
    try { console.log(entries); } catch (_) {}
  }
}
async function getLogs(env) {
  try {
    if (!env || !env.BUCHANGI_KV) {
      console.warn('getLogs: BUCHANGI_KV 바인딩이 없습니다. 빈 로그 배열을 반환합니다.');
      return [];
    }
    return (await env.BUCHANGI_KV.get('log', 'json')) || [];
  } catch (e) {
    console.error('getLogs 실패:', e);
    return [];
  }
}

// ── KIS 토큰 (KV 캐시, 24h 유효) ─────────────────────────────────
async function issueToken(env, host, appkey, secret) {
  const cacheKey = `tok:${host.includes('vts') ? 'm' : 'r'}:${appkey.slice(-6)}`;
  const cached = await env.BUCHANGI_KV.get(cacheKey, 'json');
  if (cached && cached.token && cached.exp > Date.now()) return cached.token;

  const r = await kisFetch(host + '/oauth2/tokenP', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey, appsecret: secret }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    throw new Error(`토큰 발급 실패(${r.status}): ${d.error_description || d.msg1 || JSON.stringify(d).slice(0, 120)}`);
  }
  const exp = Date.now() + ((d.expires_in || 86400) - 7200) * 1000; // 2h 여유
  // 만료 직전까지 캐시 (KIS는 토큰 발급 1회/분 제한이 있어 캐시가 중요)
  await env.BUCHANGI_KV.put(cacheKey, JSON.stringify({ token: d.access_token, exp }), {
    expiration: Math.floor(exp / 1000),
  });
  return d.access_token;
}

function kisHeaders(appkey, secret, token, tr) {
  return {
    'content-type': 'application/json; charset=utf-8',
    authorization: 'Bearer ' + token,
    appkey, appsecret: secret, tr_id: tr, custtype: 'P',
  };
}

// ── Cloudflare subrequest 예산 ───────────────────────────────────
// Workers는 invocation당 subrequest 한도가 있다(무료 50, 유료 1000 — KV 호출 포함).
// 한도를 넘으면 이후 fetch가 전부 "Too many subrequests"로 죽어 매도/매수 주문까지
// 실패하므로, KIS fetch 수를 직접 세서 (1) 조회는 주문 몫(SUBREQ_ORDER_RESERVE)을
// 침범하지 않게 막고 (2) 매수 스캔은 예산이 남을 때만 진행한다(나머지는 다음 사이클).
const SUBREQ_KV_HEADROOM = 12;  // cfg/state/log/lock/토큰캐시 등 KV 호출 몫
const SUBREQ_ORDER_RESERVE = 6; // 조회가 침범할 수 없는 주문 전용 예산(주문 + rate-limit 재시도)
const _candleCache = new Map(); // invocation 내 일봉 캐시(청산 루프·매수 스캔 중복 조회 절약)
let _subreqUsed = 0;
let _subreqMax = 50 - SUBREQ_KV_HEADROOM;
function subreqReset(limit) {
  _subreqUsed = 0;
  _subreqMax = Math.max(SUBREQ_ORDER_RESERVE + 4, (parseInt(limit, 10) || 50) - SUBREQ_KV_HEADROOM);
  _candleCache.clear();
}
function subreqLeft() { return _subreqMax - _subreqUsed; }
function subreqTake() { _subreqUsed += 1; }
function kisFetch(url, opts) { subreqTake(); return fetch(url, opts); }

// ── KIS rate-limit 보호 ──────────────────────────────────────────
// KIS는 초당 호출 한도가 있다(모의 ≈2건/초, 실전 ≈20건/초). isolate 내 모든 KIS
// 조회를 단일 체인으로 직렬화해 최소 간격을 강제하고, "초당 거래건수 초과"는 재시도한다.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _kisChain = Promise.resolve();
let _kisLast = 0;
function kisGapFor(url) { return url.includes('openapivts') ? 700 : 170; } // 모의는 넉넉히
function kisThrottle(gap) {
  const run = _kisChain.then(async () => {
    const wait = gap - (Date.now() - _kisLast);
    if (wait > 0) await sleep(wait);
    _kisLast = Date.now();
  });
  _kisChain = run.catch(() => {});
  return run;
}
function isKisRateLimited(status, text) {
  return (status === 500 || status === 429) && /초당|거래건수|EGW00201|EGW00133|rate|초과/i.test(text || '');
}
// 주문용 rate-limit 판정은 보수적으로: "초당 거래건수" 또는 게이트웨이 코드만 본다.
// (kisGet의 느슨한 패턴('초과' 등)을 주문에 쓰면 "주문가능금액 초과" 같은 진짜 실패까지
//  재시도할 위험이 있고, rate-limit은 HTTP 200 + rt_cd!='0'으로 올 수도 있어 status 무관)
function isOrderRateLimited(text) { return /초당\s*거래\s*건수|EGW00201/i.test(text || ''); }
// 간격 제어 + rate-limit 재시도가 적용된 KIS GET. { ok, status, d(파싱 JSON) } 반환.
async function kisGet(url, headers, { retries = 4 } = {}) {
  const gap = kisGapFor(url);
  for (let attempt = 0; ; attempt++) {
    // 주문 몫(SUBREQ_ORDER_RESERVE)은 조회가 못 쓰게 보호 — 예산 부족 시 즉시 명시적 실패
    if (subreqLeft() <= SUBREQ_ORDER_RESERVE) throw new Error('Cloudflare subrequest 예산 부족(주문 몫 보호)');
    await kisThrottle(gap);
    const r = await kisFetch(url, { headers });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch (_) { d = {}; }
    if (isKisRateLimited(r.status, text) && attempt < retries && subreqLeft() > SUBREQ_ORDER_RESERVE) {
      await sleep(gap * (attempt + 2)); // 점증 백오프
      continue;
    }
    return { ok: r.ok, status: r.status, d };
  }
}

// 거래용 인증 컨텍스트
async function tradeAuth(env, cfg) {
  if (!cfg.appkey || !cfg.secret || !cfg.account) {
    throw new Error('KIS 거래 설정(appkey/secret/계좌) 누락');
  }
  const host = cfg.tradeEnv === 'real' ? KIS.real : KIS.mock;
  const token = await issueToken(env, host, cfg.appkey, cfg.secret);
  const acc = cfg.account.replace(/[^0-9]/g, '');
  if (acc.length < 10) throw new Error('계좌번호는 10자리여야 합니다.');
  return {
    host, token, appkey: cfg.appkey, secret: cfg.secret,
    cano: acc.slice(0, 8), acntPrdtCd: acc.slice(8, 10),
    isMock: cfg.tradeEnv !== 'real',
  };
}

// 데이터(시세) 조회용 인증 컨텍스트. dataAppkey 있으면 실전 도메인, 없으면 거래 컨텍스트 재사용.
async function dataAuth(env, cfg) {
  if (cfg.dataAppkey && cfg.dataSecret) {
    const token = await issueToken(env, KIS.real, cfg.dataAppkey, cfg.dataSecret);
    return { host: KIS.real, token, appkey: cfg.dataAppkey, secret: cfg.dataSecret, real: true };
  }
  const t = await tradeAuth(env, cfg);
  return { host: t.host, token: t.token, appkey: t.appkey, secret: t.secret, real: cfg.tradeEnv === 'real' };
}

// ── KIS 조회/주문 ────────────────────────────────────────────────
// 예수금: 한국 주식은 D+2 결제라 오늘 매수/매도가 D+0 예수금(dnca_tot_amt)에는 반영되지
// 않는다(매수해도 천만원 그대로 보이는 원인). 가수도정산금액(D+2)이 D+0과 다르면 정산이
// 반영된 값이므로 그대로 쓰고, 같으면(모의투자는 D+2도 당일 체결 미반영인 경우가 있음)
// 금일 매수/매도금액으로 직접 보정한다. '0'은 정당한 값(전액 투자)이므로 ||가 아닌
// '필드 존재' 기준으로 읽는다.
function settledCash(out2) {
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const d0 = num(out2 && out2.dnca_tot_amt);
  const d2 = num(out2 && out2.prvs_rcvb_amt) ?? num(out2 && out2.nxdy_excc_amt);
  if (d2 != null && d2 !== d0) return Math.max(0, d2);
  const base = d0 ?? d2 ?? 0;
  const buy = num(out2 && out2.thdt_buy_amt) || 0;
  const sell = num(out2 && out2.thdt_sll_amt) || 0;
  return Math.max(0, base - buy + sell);
}
// KIS 잔고 output1 1행 → 보유 종목 객체. 모의투자는 평가손익(evlu_pl_amt)·평가금(evlu_amt)·
// 수익률(evlu_erng_rt)이 0/빈값으로 오는 경우가 있어 평단·현재가로 직접 계산해 보완한다
// (정상 응답이면 KIS 값 그대로. KIS 손익은 수수료 반영이라 보완값과 미세 차이 가능).
function parseHolding(h) {
  const qty = parseInt(h.hldg_qty, 10) || 0;
  const avgPrice = parseFloat(h.pchs_avg_pric) || 0;
  const curPrice = parseFloat(h.prpr) || 0;
  return {
    name: h.prdt_name, ticker: h.pdno, qty, avgPrice, curPrice,
    value: parseFloat(h.evlu_amt) || Math.round(curPrice * qty),
    pnl: parseFloat(h.evlu_pl_amt) || (avgPrice && curPrice ? Math.round((curPrice - avgPrice) * qty) : 0),
    yield: parseFloat(h.evlu_erng_rt) || (avgPrice && curPrice ? +(((curPrice - avgPrice) / avgPrice) * 100).toFixed(2) : 0),
  };
}
async function inquireBalance(t) {
  const tr = t.isMock ? 'VTTC8434R' : 'TTTC8434R';
  // 보유 종목은 페이지네이션(tr_cont/CTX_AREA_*)으로 전량 수집한다.
  // (한 페이지(~50건)만 읽으면 다종목 계정에서 보유 종목이 누락되어 청산/상태정리가 틀어짐)
  const holdings = [];
  let lastOut2 = {};
  let fk = '', nk = '', cont = '';
  for (let page = 0; page < 10; page++) { // 최대 10페이지 안전 상한
    const qs = new URLSearchParams({
      CANO: t.cano, ACNT_PRDT_CD: t.acntPrdtCd, AFHR_FLPR_YN: 'N', OFL_YN: '',
      INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '01', CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
    });
    await kisThrottle(kisGapFor(t.host));
    const r = await kisFetch(t.host + '/uapi/domestic-stock/v1/trading/inquire-balance?' + qs, {
      headers: { ...kisHeaders(t.appkey, t.secret, t.token, tr), tr_cont: cont },
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`잔고조회 실패(${r.status}): ${d.msg1 || ''}`);
    for (const h of (d.output1 || [])) {
      const parsed = parseHolding(h);
      if (parsed.qty <= 0) continue;
      holdings.push(parsed);
    }
    if (d.output2 && d.output2[0]) lastOut2 = d.output2[0]; // 예수금 등 요약(마지막 페이지 기준)
    const trCont = r.headers.get('tr_cont'); // F/M=다음 페이지 있음, D/E/공백=마지막
    if (trCont !== 'F' && trCont !== 'M') break;
    fk = d.ctx_area_fk100 || ''; nk = d.ctx_area_nk100 || ''; cont = 'N';
  }
  const cash = settledCash(lastOut2);
  const stockEval = holdings.reduce((a, h) => a + h.value, 0);
  return { cash, stockEval, totalValue: cash + stockEval, holdings };
}

// 현재가 (관심종목/사이징용)
async function currentPrice(da, ticker) {
  const qs = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker });
  const { ok, status, d } = await kisGet(da.host + '/uapi/domestic-stock/v1/quotations/inquire-price?' + qs,
    kisHeaders(da.appkey, da.secret, da.token, 'FHKST01010100'));
  if (!ok || !d.output) throw new Error(`시세 조회 실패(${status})`);
  const o = d.output;
  return {
    price: parseFloat(o.stck_prpr) || 0,   // 현재가
    open: parseFloat(o.stck_oprc) || 0,    // 시가
    high: parseFloat(o.stck_hgpr) || 0,    // 고가
    low: parseFloat(o.stck_lwpr) || 0,     // 저가
    prevClose: parseFloat(o.stck_sdpr) || 0, // 전일 종가(기준가)
  };
}

// 일봉 OHLC 배열 (변동성 돌파/MA 계산용). output[0]=당일, [1]=전일 ...
// invocation 내 캐시: 청산 루프(ATR)와 매수 스캔이 같은 종목 일봉을 두 번 안 부르게(subrequest 절약)
async function dailyCandles(da, ticker) {
  const ck = da.host + ':' + ticker;
  if (_candleCache.has(ck)) return _candleCache.get(ck);
  const qs = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker,
    FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '1',
  });
  const { ok, status, d } = await kisGet(da.host + '/uapi/domestic-stock/v1/quotations/inquire-daily-price?' + qs,
    kisHeaders(da.appkey, da.secret, da.token, 'FHKST01010400'));
  if (!ok || !Array.isArray(d.output)) throw new Error(`일봉 조회 실패(${status})`);
  const out = d.output.map(c => ({
    date: c.stck_bsop_date,
    open: parseFloat(c.stck_oprc) || 0,
    high: parseFloat(c.stck_hgpr) || 0,
    low: parseFloat(c.stck_lwpr) || 0,
    close: parseFloat(c.stck_clpr) || 0,
    volume: parseFloat(c.acml_vol) || 0,
  }));
  _candleCache.set(ck, out);
  return out;
}

// 코스피 일봉(게이트 ①). 미지원/실패 시 null. [{date, close}] 최신→과거.
async function kospiDailyBars(da) {
  try {
    const qs = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001',
      FID_INPUT_DATE_1: '', FID_INPUT_DATE_2: '', FID_PERIOD_DIV_CODE: 'D',
    });
    const { d } = await kisGet(da.host + '/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice?' + qs,
      kisHeaders(da.appkey, da.secret, da.token, 'FHKUP03500100'));
    const rows = d.output2 || d.output || [];
    if (!Array.isArray(rows) || !rows.length) return null;
    const bars = rows
      .map(c => ({ date: c.stck_bsop_date, close: parseFloat(c.bstp_nmix_prpr || c.stck_clpr || 0) }))
      .filter(b => b.date && b.close);
    return bars.length ? bars : null;
  } catch (_) { return null; }
}
async function kospiDaily(da) {
  const bars = await kospiDailyBars(da);
  return bars ? bars.map(b => b.close) : null;
}

// 날짜별 시장 게이트 맵(YYYYMMDD → 그날 코스피 ≥ MA 여부). bars=[{date,close}] 최신→과거.
// 라이브 게이트(closes[0] >= sma(closes, period))를 각 과거 날짜에 동일하게 적용한 것.
function marketGateMap(bars, period) {
  if (!bars || bars.length < period) return null;
  const map = {};
  for (let i = 0; i + period <= bars.length; i++) {
    let s = 0;
    for (let j = i; j < i + period; j++) s += bars[j].close;
    map[bars[i].date] = bars[i].close >= s / period;
  }
  return map;
}

// 주문 전송. 조회와 같은 스로틀 체인을 타서 시세 조회 직후 주문이 KIS 초당 한도에
// 부딪히지 않게 하고, "초당 거래건수 초과"만 백오프 후 재시도한다 — 이 오류는 게이트웨이가
// 접수 전에 거절한 것이라 재시도해도 중복 주문이 없다. 그 외 오류는 접수됐을 가능성이
// 있어 재시도하지 않는다(중복 주문 위험).
async function placeOrder(t, { ticker, qty, isBuy, ordDvsn = '01', price = 0 }, { retries = 4 } = {}) {
  const tr = t.isMock ? (isBuy ? 'VTTC0802U' : 'VTTC0801U') : (isBuy ? 'TTTC0802U' : 'TTTC0801U');
  const gap = kisGapFor(t.host);
  for (let attempt = 0; ; attempt++) {
    if (subreqLeft() <= 0) throw new Error('Cloudflare subrequest 예산 소진 — 다음 사이클에 재시도');
    await kisThrottle(gap);
    const r = await kisFetch(t.host + '/uapi/domestic-stock/v1/trading/order-cash', {
      method: 'POST',
      headers: kisHeaders(t.appkey, t.secret, t.token, tr),
      body: JSON.stringify({
        CANO: t.cano, ACNT_PRDT_CD: t.acntPrdtCd, PDNO: ticker,
        ORD_DVSN: ordDvsn, ORD_QTY: String(qty), ORD_UNPR: String(price || 0),
      }),
    });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch (_) { d = {}; }
    if (r.ok && d.rt_cd === '0') return { orderNo: d.output?.ODNO, msg: d.msg1, retries: attempt };
    if (isOrderRateLimited(text) && attempt < retries && subreqLeft() > 0) {
      await sleep(gap * (attempt + 2)); // 점증 백오프(모의 0.7s 기준 1.4s→3.5s)
      continue;
    }
    throw new Error((d.msg1 || `주문 실패(${r.status})`) + (isOrderRateLimited(text) ? ` [재시도 ${attempt}회 소진]` : ''));
  }
}

// ── 전략 헬퍼 ────────────────────────────────────────────────────
function sma(values, period) {
  if (!values || values.length < period) return null;
  const s = values.slice(0, period).reduce((a, b) => a + b, 0);
  return s / period;
}

// ATR(평균 진정변동폭). candles[0]=당일... start=1이면 당일(미완성봉) 제외하고 직전부터.
function atr(candles, period, start = 1) {
  if (!candles || candles.length < start + period + 1) return null;
  let sum = 0;
  for (let i = start; i < start + period; i++) {
    const c = candles[i], p = candles[i + 1];
    if (!c || !p) return null;
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

// 평균 거래량(직전 period일, 당일 제외)
function avgVolume(candles, period) {
  const vols = candles.slice(1, period + 1).map(c => c.volume).filter(v => v > 0);
  if (!vols.length) return null;
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

// 비율을 [0,1]로 강제(잘못된 입력/NaN → 안전값 1)
function clampFrac(x) { x = Number(x); if (!isFinite(x)) return 1; return Math.max(0, Math.min(1, x)); }

// regime(시장체제) 사이징 팩터: 코스피가 MA보다 regimeFullMarginPct% 이상 위면 1(풀),
// 간신히 위면 regimeMinFraction까지 축소. 데이터 이상/0나눗셈은 1(중립) 반환.
function regimeFactorFor(kospi, ma, cfg) {
  const minFrac = clampFrac(cfg.regimeMinFraction);
  const fullPct = Number(cfg.regimeFullMarginPct);
  if (!ma || ma <= 0 || !isFinite(kospi)) return 1;
  if (!isFinite(fullPct) || fullPct <= 0) return 1;
  const factor = ((kospi / ma - 1) * 100) / fullPct; // 1.0=풀, <0이면 MA 아래
  return Math.max(minFrac, Math.min(1, factor));
}

// ADX(Wilder) 추세강도. 시간순(오래된→최신) 봉 배열에서 마지막 ADX 1개를 반환.
function _adxFromChrono(bars, period) {
  const n = bars.length;
  if (n < 2 * period + 1) return null;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < n; i++) {
    const c = bars[i], p = bars[i - 1];
    const up = c.high - p.high, dn = p.low - c.low;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const m = tr.length;
  if (m < 2 * period) return null;
  let trS = 0, pdmS = 0, mdmS = 0;
  for (let i = 0; i < period; i++) { trS += tr[i]; pdmS += pdm[i]; mdmS += mdm[i]; }
  const dxs = [];
  const pushDX = () => {
    const pDI = trS === 0 ? 0 : 100 * pdmS / trS;
    const mDI = trS === 0 ? 0 : 100 * mdmS / trS;
    const sum = pDI + mDI;
    dxs.push(sum === 0 ? 0 : 100 * Math.abs(pDI - mDI) / sum);
  };
  pushDX();
  for (let i = period; i < m; i++) {
    trS = trS - trS / period + tr[i];
    pdmS = pdmS - pdmS / period + pdm[i];
    mdmS = mdmS - mdmS / period + mdm[i];
    pushDX();
  }
  if (dxs.length < period) return null;
  let adxV = 0;
  for (let i = 0; i < period; i++) adxV += dxs[i];
  adxV /= period;
  for (let i = period; i < dxs.length; i++) adxV = (adxV * (period - 1) + dxs[i]) / period;
  return adxV;
}
// 라이브/스캐너용: candles[0]=당일(미완성봉) → start=1로 제외, 최신→과거를 시간순으로 뒤집어 계산.
function adx(candles, period, start = 1) {
  if (!candles || candles.length < start + 2 * period + 1) return null;
  return _adxFromChrono(candles.slice(start).reverse(), period);
}
// 백테스트용: bars=시간순(과거→최신). [0,end) 구간으로 end 직전까지의 ADX.
function adxAt(bars, end, period) {
  if (end < 2 * period + 1) return null;
  return _adxFromChrono(bars.slice(0, end), period);
}

// ── 전략 추천(스캐너) ────────────────────────────────────────────
// 워치리스트는 거래 화이트리스트(이 종목만 매매). 추천 엔진은 거꾸로
// "넓은 후보 유니버스 → 부챙이 전략 함수로 점수화 → 통과분 추천 → 원클릭 워치리스트 추가".
// 하이브리드: 정량 스크리너로 싸게 압축 → 통과 상위만 Gemini가 정성 2차 검토.

// 동시성 제한 풀(KIS rate-limit·Worker 서브요청 한도 보호)
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// 후보 유니버스 ①: 거래량 순위 (투챙이 kis-proxy와 동일 파라미터, 검증됨)
async function volumeRank(da, count) {
  const qs = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20171', FID_INPUT_ISCD: '0000',
    FID_DIV_CLS_CODE: '0', FID_BLNG_CLS_CODE: '0', FID_TRGT_CLS_CODE: '111111111',
    FID_TRGT_EXLS_CLS_CODE: '000000', FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '',
    FID_VOL_CNT: '', FID_INPUT_DATE_1: '',
  });
  const { ok, status, d } = await kisGet(da.host + '/uapi/domestic-stock/v1/quotations/volume-rank?' + qs,
    kisHeaders(da.appkey, da.secret, da.token, 'FHPST01710000'));
  if (!ok || !Array.isArray(d.output)) throw new Error(`거래량순위 실패(${status}): ${d.msg1 || ''}`);
  return d.output.map(o => ({
    ticker: o.mksc_shrn_iscd, name: o.hts_kor_isnm,
    price: parseFloat(o.stck_prpr) || 0, volume: parseFloat(o.acml_vol) || 0,
  })).filter(x => /^\d{6}$/.test(x.ticker || '')).slice(0, count);
}

// 후보 유니버스 ②: 시가총액 순위 (모의환경은 미지원일 수 있음)
async function marketCapRank(da, count) {
  const qs = new URLSearchParams({
    fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20174', fid_div_cls_code: '0',
    fid_input_iscd: '0000', fid_trgt_cls_code: '0', fid_trgt_exls_cls_code: '0',
    fid_input_price_1: '', fid_input_price_2: '', fid_vol_cnt: '',
  });
  const { ok, status, d } = await kisGet(da.host + '/uapi/domestic-stock/v1/ranking/market-cap?' + qs,
    kisHeaders(da.appkey, da.secret, da.token, 'FHPST01740000'));
  if (!ok || !Array.isArray(d.output)) throw new Error(`시총순위 실패(${status}): ${d.msg1 || ''}`);
  return d.output.map(o => ({
    ticker: o.mksc_shrn_iscd, name: o.hts_kor_isnm,
    price: parseFloat(o.stck_prpr) || 0, volume: parseFloat(o.acml_vol) || 0,
  })).filter(x => /^\d{6}$/.test(x.ticker || '')).slice(0, count);
}

// 후보 1종목을 부챙이 전략(시장①·추세②·셋업③)으로 점수화.
// 일봉만으로 계산(현재가=당일봉 종가) → 종목당 KIS 호출 1회로 절약.
function scoreCandidate(cfg, c, candles, marketGreen, marketAvailable) {
  const today = candles[0];
  const prev = candles[1] || today;
  const price = today.close || c.price || 0;
  const range = (prev.high - prev.low) || 0;
  const target = today.open + cfg.breakoutK * range;          // 변동성 돌파선
  const maCloses = candles.slice(1, cfg.maPeriod + 1).map(x => x.close);
  const ma = sma(maCloses, cfg.maPeriod);                     // 추세선(전일 기준 MA)
  const pastClose = candles[cfg.maPeriod] && candles[cfg.maPeriod].close;
  const mom = pastClose ? ((price - pastClose) / pastClose) * 100 : null; // N일 모멘텀
  const breakoutDist = target > 0 ? ((price - target) / target) * 100 : -100; // 돌파선 대비 +위/-아래 %
  const avgVol = avgVolume(candles, cfg.maPeriod);
  const volRatio = avgVol ? +(today.volume / avgVol).toFixed(2) : null; // 당일/평균 거래량 비

  // ① 시장: 코스피 게이트(전 후보 공통). 데이터 없으면 통과 처리.
  const market = marketGreen ? 'GREEN' : 'RED';
  // ② 추세·모멘텀: MA 위 + 모멘텀 비음수(투챙이 '섹터 흐름' 자리를 부챙이 데이터로 치환)
  const trendOk = (ma == null ? price >= today.open : price >= ma) && (mom == null || mom >= 0);
  // ③ 변동성 셋업·유동성: 양봉 + 돌파선 -3% 이내 + 유효 변동폭 + 거래량 증가(있으면)
  const setupOk = range > 0 && price >= today.open && breakoutDist >= -3 && (volRatio == null || volRatio >= 1);

  const trend = trendOk ? 'GREEN' : 'RED';
  const setup = setupOk ? 'GREEN' : 'RED';
  const score = [market, trend, setup].filter(s => s === 'GREEN').length;
  return {
    ticker: c.ticker, name: c.name, price, market, trend, setup, score,
    verdict: score === 3 ? '매수' : '관망', ai: null,
    metrics: {
      ma: ma ? Math.round(ma) : null, target: Math.round(target),
      breakoutDist: +breakoutDist.toFixed(2),
      mom: mom == null ? null : +mom.toFixed(2),
      volRatio, volume: c.volume || null, maPeriod: cfg.maPeriod, marketAvailable,
    },
  };
}

async function runRecommend(env) {
  const cfg = await getCfg(env);
  subreqReset(cfg.cfSubreqLimit);
  const ts = `${ymd(nowKST())} ${hhmm(nowKST())} KST`;
  const notes = [];
  const note = (m) => notes.push(m);

  let da;
  try { da = await dataAuth(env, cfg); }
  catch (e) { return { ok: false, ts, error: '시세 인증 실패: ' + e.message + ' — KIS 데이터 키(또는 거래 키)가 필요합니다.' }; }

  // 시장 게이트 ①(전 후보 공통, 1회 계산)
  let market = { available: false, kospi: null, ma: null, gate: true };
  try {
    const closes = await kospiDaily(da);
    const ma = sma(closes, cfg.marketMaPeriod);
    if (closes && ma) market = { available: true, kospi: closes[0], ma, gate: closes[0] >= ma };
    else note('코스피 지수 데이터 없음 → 시장 게이트 통과 처리(모의 미지원 가능)');
  } catch (e) { note('시장 게이트 계산 실패: ' + e.message); }

  // 후보 유니버스 수집(설정값으로 소스/개수 조절)
  const count = Math.max(5, Math.min(40, parseInt(cfg.recommendCount, 10) || 30));
  const sources = cfg.recommendSource === 'both' ? ['volume', 'marketcap'] : [cfg.recommendSource || 'volume'];
  let raw = [];
  for (const src of sources) {
    try {
      raw = raw.concat(src === 'marketcap' ? await marketCapRank(da, count) : await volumeRank(da, count));
    } catch (e) { note(`${src} 순위 조회 실패: ${e.message}`); }
  }
  const seen = new Set();
  const scanList = raw.filter(u => !seen.has(u.ticker) && seen.add(u.ticker)).slice(0, count);
  if (!scanList.length) {
    return { ok: false, ts, notes, error: '후보 유니버스를 가져오지 못했습니다(거래량/시총 순위 조회 실패 — 모의환경 미지원일 수 있음).' };
  }

  // 정량 스코어링(동시성 4, 종목당 일봉 1회)
  const marketGreen = market.available ? market.gate : true;
  let skipped = 0;
  const scored = await mapPool(scanList, 2, async (c) => {
    try {
      const candles = await dailyCandles(da, c.ticker);
      if (!candles.length) { skipped++; return null; }
      return scoreCandidate(cfg, c, candles, marketGreen, market.available);
    } catch (_) { skipped++; return null; }
  });
  const items = scored.filter(Boolean);
  items.sort((a, b) => b.score - a.score || b.metrics.breakoutDist - a.metrics.breakoutDist);

  // 정성 2차(Gemini)는 대시보드(브라우저)에서 수행한다. 워커는 정량 결과만 반환하고,
  // 어느 종목을 AI로 넘길지 힌트(shortlist 수)만 알려준다.
  const shortlistN = Math.max(0, Math.min(20, parseInt(cfg.recommendShortlist, 10) || 8));

  return {
    ok: true, ts,
    market,
    universe: { source: cfg.recommendSource, requested: count, scanned: scanList.length, evaluated: items.length, skipped },
    shortlist: shortlistN,
    items: items.slice(0, 20),
    notes,
  };
}

// ── 경량 백테스터 ────────────────────────────────────────────────
// KIS 일봉(최근 ~수십~100일)에 부챙이 전략을 재생해 승률·평균수익·MDD를 추정.
// 약식(일봉·종가 근사): 진입은 당일 돌파선 체결 가정, 청산은 다음 봉부터. 깊은 검증 아닌
// "파라미터가 과거에 말이 되나" 방향성 점검용. **자동 최적화는 의도적으로 미제공(과최적화 방지).**
function smaAt(bars, end, period) { // bars 시간순, [end-period, end) 종가 평균
  if (end < period) return null;
  let s = 0; for (let i = end - period; i < end; i++) s += bars[i].close;
  return s / period;
}
function atrAt(bars, end, period) {
  if (end < period + 1) return null;
  let s = 0; for (let i = end - period; i < end; i++)
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
  return s / period;
}
function avgVolAt(bars, end, period) {
  if (end < period) return null;
  let s = 0, c = 0; for (let i = end - period; i < end; i++) if (bars[i].volume > 0) { s += bars[i].volume; c++; }
  return c ? s / c : null;
}
function pickStrategyParams(cfg) {
  return {
    breakoutK: cfg.breakoutK, maPeriod: cfg.maPeriod, takeProfitPct: cfg.takeProfitPct, stopLossPct: cfg.stopLossPct,
    useAtrStop: cfg.useAtrStop, atrStopMult: cfg.atrStopMult, atrPeriod: cfg.atrPeriod,
    useTrailingStop: cfg.useTrailingStop, trailAtrMult: cfg.trailAtrMult, trailArmPct: cfg.trailArmPct,
    requireVolumeConfirm: cfg.requireVolumeConfirm, volMultiplier: cfg.volMultiplier,
    requireRangeExpansion: cfg.requireRangeExpansion, closeOnEod: cfg.closeOnEod, orderKrw: cfg.orderKrw,
    entryTranches: cfg.entryTranches, partialTpPct: cfg.partialTpPct, partialTpFraction: cfg.partialTpFraction,
    regimeSizing: cfg.regimeSizing, requireAdx: cfg.requireAdx, adxPeriod: cfg.adxPeriod, adxMin: cfg.adxMin,
  };
}
function backtestSymbol(cfg, candles, marketGateByDate = null) {
  const bars = candles.slice().reverse();            // 오래된→최신
  const n = bars.length;
  const warm = Math.max(cfg.maPeriod, cfg.atrPeriod, cfg.requireAdx ? 2 * cfg.adxPeriod : 0) + 1;
  const trades = [];
  let pos = null;
  for (let i = warm; i < n; i++) {
    const bar = bars[i];
    // 1) 보유 중 → 청산(진입 다음 봉부터). 같은 날 stop/tp 동시 시 손절 우선(보수적).
    if (pos && i > pos.entryIdx) {
      pos.peak = Math.max(pos.peak, bar.high);
      const tp = pos.entry * (1 + cfg.takeProfitPct / 100);
      const stop = (cfg.useAtrStop && pos.atr) ? pos.entry - cfg.atrStopMult * pos.atr : pos.entry * (1 - cfg.stopLossPct / 100);
      let trail = 0;
      if (cfg.useTrailingStop && pos.atr && pos.peak >= pos.entry * (1 + cfg.trailArmPct / 100)) trail = pos.peak - cfg.trailAtrMult * pos.atr;
      const effStop = Math.max(stop, trail);
      let exit = null, reason = null;
      if (effStop && bar.low <= effStop) {
        // 손절 우선(보수적): 같은 봉에서 부분익절가도 닿았더라도 전량 손절가 청산
        exit = effStop; reason = (trail && effStop === trail) ? '트레일링' : (cfg.useAtrStop ? 'ATR손절' : '손절');
      } else {
        // 손절 미발생 봉에서만 분할익절 1회 처리(잔량 차감 후 계속 보유) → 그다음 풀익절
        if (cfg.partialTpPct > 0 && !pos.partialDone) {
          const pt = pos.entry * (1 + cfg.partialTpPct / 100);
          if (bar.high >= pt && pt < tp) {
            const q = Math.max(1, Math.floor(pos.qty * clampFrac(cfg.partialTpFraction)));
            if (q < pos.qty) {
              const pct = (pt - pos.entry) / pos.entry * 100;
              trades.push({ entryDate: pos.date, exitDate: bar.date, entry: Math.round(pos.entry), exit: Math.round(pt), pct: +pct.toFixed(2), pnl: Math.round((pt - pos.entry) * q), reason: '부분익절', partial: true });
              pos.qty -= q; pos.partialDone = true;
            }
          }
        }
        if (bar.high >= tp) { exit = tp; reason = '익절'; }
      }
      if (exit != null) {
        const pct = (exit - pos.entry) / pos.entry * 100;
        trades.push({ entryDate: pos.date, exitDate: bar.date, entry: Math.round(pos.entry), exit: Math.round(exit), pct: +pct.toFixed(2), pnl: Math.round((exit - pos.entry) * pos.qty), reason });
        pos = null;
      }
    }
    // 2) 미보유 → 진입 검사
    if (!pos) {
      const prev = bars[i - 1];
      const range = (prev.high - prev.low) || 0;
      const target = bar.open + cfg.breakoutK * range;
      const ma = smaAt(bars, i, cfg.maPeriod);
      const atrV = atrAt(bars, i, cfg.atrPeriod);
      const avgV = avgVolAt(bars, i, cfg.maPeriod);
      const adxV = adxAt(bars, i, cfg.adxPeriod);
      const breakout = range > 0 && bar.high >= target;
      const trendOk = ma == null ? true : prev.close >= ma;
      const volOk = !cfg.requireVolumeConfirm || (avgV && bar.volume >= cfg.volMultiplier * avgV);
      const rangeOk = !cfg.requireRangeExpansion || (atrV && (bar.high - bar.low) >= atrV);
      const adxOk = !cfg.requireAdx || (adxV != null && adxV >= cfg.adxMin);
      // 시장 게이트(게이트 ①): 그날 코스피 ≥ MA일 때만 진입. 지수 데이터가 없는 날은
      // 라이브 폴백(게이트 스킵→통과)과 동일하게 통과 처리. 청산에는 적용하지 않음(라이브 동일).
      const mktOk = !marketGateByDate || marketGateByDate[bar.date] !== false;
      if (breakout && trendOk && volOk && rangeOk && adxOk && mktOk) {
        const entry = Math.max(target, bar.open);
        const qty = Math.max(1, Math.floor(cfg.orderKrw / entry));
        pos = { entry, qty, entryIdx: i, date: bar.date, peak: bar.high, atr: atrV, partialDone: false };
        if (cfg.closeOnEod) { // 종가청산 모드: 진입 당일 종가로 즉시 청산
          const pct = (bar.close - entry) / entry * 100;
          trades.push({ entryDate: bar.date, exitDate: bar.date, entry: Math.round(entry), exit: Math.round(bar.close), pct: +pct.toFixed(2), pnl: Math.round((bar.close - entry) * qty), reason: '종가청산' });
          pos = null;
        }
      }
    }
  }
  return trades;
}
async function runBacktest(env, { tickers } = {}) {
  const cfg = await getCfg(env);
  subreqReset(cfg.cfSubreqLimit);
  const ts = `${ymd(nowKST())} ${hhmm(nowKST())} KST`;
  let da;
  try { da = await dataAuth(env, cfg); }
  catch (e) { return { ok: false, ts, error: '시세 인증 실패: ' + e.message + ' — KIS 데이터 키가 필요합니다.' }; }

  const names = Object.fromEntries((cfg.watchlist || []).map(w => [w.ticker, w.name]));
  const list = ((tickers && tickers.length ? tickers : (cfg.watchlist || []).map(w => w.ticker)) || [])
    .filter(x => /^\d{6}$/.test(x));
  if (!list.length) return { ok: false, ts, error: '백테스트할 종목이 없습니다(워치리스트가 비어있거나 종목 미지정).' };

  // 시장 게이트(게이트 ①)를 백테스트에도 반영 — 코스피 일봉으로 날짜별 통과 여부를 만들어
  // 종목 봉과 날짜를 맞춰 적용. 지수 데이터 실패 시 라이브 폴백처럼 게이트 없이 진행.
  const gateMap = marketGateMap(await kospiDailyBars(da), cfg.marketMaPeriod);

  const perTicker = []; const allTrades = []; let maxBars = 0;
  const perTickerNoGate = []; const allTradesNoGate = []; // 게이트 미반영 변형(비교 토글용)
  await mapPool(list, 2, async (ticker) => {
    const name = names[ticker] || ticker;
    try {
      const candles = await dailyCandles(da, ticker);
      maxBars = Math.max(maxBars, candles.length);
      const trades = backtestSymbol(cfg, candles, gateMap);
      perTicker.push({ ticker, name, bars: candles.length, ...tradeStats(trades) });
      trades.forEach(tr => allTrades.push({ ...tr, ticker, name }));
      if (gateMap) { // 같은 일봉으로 미반영 변형도 재생(추가 KIS 호출 없음) — 게이트가 손익에 주는 효과 비교용
        const tradesNG = backtestSymbol(cfg, candles, null);
        perTickerNoGate.push({ ticker, name, bars: candles.length, ...tradeStats(tradesNG) });
        tradesNG.forEach(tr => allTradesNoGate.push({ ...tr, ticker, name }));
      }
    } catch (e) {
      perTicker.push({ ticker, name, error: e.message });
      if (gateMap) perTickerNoGate.push({ ticker, name, error: e.message });
    }
  });
  const byPnl = (a, b) => (b.totalPnl || 0) - (a.totalPnl || 0);
  perTicker.sort(byPnl); perTickerNoGate.sort(byPnl);
  return {
    ok: true, ts, bars: maxBars, params: pickStrategyParams(cfg),
    aggregate: tradeStats(allTrades), perTicker,
    noGate: gateMap ? { aggregate: tradeStats(allTradesNoGate), perTicker: perTickerNoGate } : null,
    sample: allTrades.slice().sort((a, b) => (a.exitDate > b.exitDate ? -1 : 1)).slice(0, 30),
    note: `최근 ${maxBars}일 일봉 기준 약식 백테스트(일봉 근사). 깊은 검증 아님 — 파라미터 방향성 점검용.`
      + (gateMap
        ? ` ※ 시장게이트(코스피≥MA${cfg.marketMaPeriod}) 반영 — 게이트 산출 ${Object.keys(gateMap).length}일 중 관망 ${Object.values(gateMap).filter(g => !g).length}일은 진입 제외.`
        : ' ※ 코스피 지수 데이터 없음 → 시장게이트 미반영(전일 통과 처리).')
      + ` ※ 분할매수·regime 사이징은 라이브 전용(일봉 백테스트 미반영), ADX는 일봉 ${maxBars}봉 한계로 표본이 빈약할 수 있음.`,
  };
}

// ── 매매 사이클 ──────────────────────────────────────────────────
async function runCycle(env, { manual = false, watchdog = false, budgetPad = 0 } = {}) {
  const cfg = await getCfg(env);
  // invocation 예산 리셋(+일봉 캐시 비움). 워치독 경유면 이 invocation이 이미 status/잔고
  // 조회로 subrequest를 썼을 수 있어 budgetPad만큼 보수적으로 줄인다.
  subreqReset((parseInt(cfg.cfSubreqLimit, 10) || 50) - budgetPad);
  const now = nowKST();
  const today = ymd(now);
  const ts = `${today} ${hhmm(now)} KST`;
  const events = [];
  const note = (level, msg, extra) => events.push({ t: ts, level, msg, ...(extra || {}) });

  // 중복 실행 방지 락(획득 실패 시 이번 실행은 스킵). 모든 정상 종료 경로(finish)에서 해제.
  if (!(await acquireLock(env))) {
    return { ok: true, ts, summary: '스킵: 다른 사이클 실행 중(중복 방지 락)', events: [] };
  }

  let state = await getState(env);
  if (state.day !== today) {
    // 날이 바뀌면 일일 카운터만 리셋. 성과기록(trades)·보유 고점(peak)·부분익절 이력(partialDone)은
    // 이어가고, 트랜치 카운트(tranches)는 리셋(보유 안 한 종목 잔재가 재진입을 막지 않도록).
    state = { ...freshDay(today), trades: state.trades || [], fills: state.fills || [], peak: state.peak || {}, partialDone: state.partialDone || {} };
  }
  // 방어: 구버전 KV state에 없을 수 있는 필드 보장(TypeError 방지)
  state.peak ??= {}; state.tranches ??= {}; state.partialDone ??= {}; state.fills ??= [];
  state.lastCycleAt = ts;

  const finish = async (summary) => {
    note('cycle', summary);
    // 비챙이 alert 판정은 setState 전에(state.lossNotified 플래그가 영속되도록).
    const biAlert = buildBichangiAlert(cfg, state, events);
    await setState(env, state);
    await appendLog(env, events);
    await releaseLock(env); // 정상 종료 시 락 해제(예외 시엔 TTL로 자동 해제)
    // 락 해제·상태 저장 이후에 통지(실패해도 매매/상태에 무영향).
    if (biAlert) { try { await notifyBichangi(env, biAlert); } catch (_) {} }
    return { ok: true, ts, summary, events };
  };

  // ── 사전 게이트 ──
  if (watchdog) note('info', '⏰ 워치독 보충 실행 — cron 미실행 감지(대시보드/health 요청 수명 사용)');
  if (!cfg.enabled && !manual) return finish('스킵: 자동매매 비활성(enabled=false)');
  if (cfg.killSwitch) return finish('스킵: kill-switch ON (신규 주문 중단)');
  if (!isMarketHours(now) && !manual) return finish('스킵: 거래시간(09:00~15:20 KST) 아님');
  if (!cfg.watchlist?.length) return finish('스킵: 워치리스트 비어있음');

  // ── 잔고/포지션 ──
  let bal, t;
  try {
    t = await tradeAuth(env, cfg);
    bal = await inquireBalance(t);
  } catch (e) {
    note('error', '잔고 조회 실패: ' + e.message);
    return finish('중단: 잔고 조회 실패');
  }
  const heldBy = Object.fromEntries(bal.holdings.map(h => [h.ticker, h]));

  // stale 상태 정리: 더 이상 보유하지 않고 오늘 매수하지도 않은 종목의 peak/tranches/partialDone 제거.
  // (수동매도·워치 제거·한도초과로 봇 풀청산 경로를 못 탄 잔재가 다음 lot의 트레일링/분할익절을
  //  오염시키는 것 방지 + 맵 무한성장 방지. 오늘 매수분은 잔고 스냅샷에 아직 안 잡힐 수 있어 제외.)
  for (const m of [state.peak, state.tranches, state.partialDone]) {
    for (const k of Object.keys(m)) {
      if (!heldBy[k] && state.bought[k] !== today) delete m[k];
    }
  }

  // 일일 손익: 매매 성과 기반(현금잔고 비참조 → 입출금·계좌리셋 오염 없음). 그날 첫 사이클에
  // 평가손익 기준점을 스냅샷. dayStartValue도 함께 남겨 "총자산Δ"(입출금 포함 원시 변동)와의
  // 차이를 진단할 수 있게 한다.
  const unrealizedNow = bal.holdings.reduce((a, h) => a + (h.pnl || 0), 0);
  if (state.dayStartUnrealized == null) state.dayStartUnrealized = unrealizedNow;
  if (state.dayStartValue == null) state.dayStartValue = bal.totalValue;
  state.dayPnl = dayPnlFrom(state.trades, bal.holdings, state.dayStartUnrealized, today);
  const rawDelta = Math.round(bal.totalValue - state.dayStartValue); // 입출금/리셋 포함 원시 총자산 변동(진단용)

  const dailyLossHit = state.dayPnl <= -Math.abs(cfg.dailyMaxLossKrw);
  const dailyOrdersHit = state.dayOrders >= cfg.dailyMaxOrders;
  note('info', `잔고: 현금 ${bal.cash.toLocaleString()} / 평가 ${bal.stockEval.toLocaleString()} / 총 ${bal.totalValue.toLocaleString()} / 일손익 ${state.dayPnl.toLocaleString()}(총자산Δ ${rawDelta.toLocaleString()}) / 주문 ${state.dayOrders}건`,
    { dayPnl: state.dayPnl, dayPnlRaw: rawDelta, dayOrders: state.dayOrders, cash: bal.cash, totalValue: bal.totalValue });
  // 비챙이 풀(오전·오후 브리핑)용 잔고 스냅샷.
  state.lastBalance = {
    cash: bal.cash, stockEval: bal.stockEval, totalValue: bal.totalValue,
    dayPnl: state.dayPnl, holdings: bal.holdings.length, at: ts,
  };
  if (dailyLossHit) note('warn', `일일 손실 한도 도달(${state.dayPnl.toLocaleString()} ≤ -${cfg.dailyMaxLossKrw.toLocaleString()}) → 신규 매수 중단(손절 매도는 허용)`);

  // 데이터 인증(시세). 실패해도 청산 로직은 잔고 기반으로 가능.
  let da = null;
  try { da = await dataAuth(env, cfg); } catch (e) { note('warn', '데이터 인증 실패: ' + e.message); }

  // ── 게이트 ①: 시장 추세 (코스피 MA) + regime 사이징 팩터(Tier 2) ──
  let marketGate = true;
  let regimeFactor = 1;                 // 기본 풀사이즈 (regimeSizing OFF면 항상 1)
  let kospiIdx = null, kospiMa = null;
  if (da) {
    const closes = await kospiDaily(da);
    const ma = sma(closes, cfg.marketMaPeriod);
    if (closes && ma) {
      kospiIdx = closes[0]; kospiMa = ma;
      marketGate = kospiIdx >= ma;
      note('gate', `시장추세: 코스피 ${kospiIdx.toFixed(2)} vs MA${cfg.marketMaPeriod} ${ma.toFixed(2)} → ${marketGate ? '매수허용' : '관망'}`);
    } else {
      note('gate', '시장추세: 코스피 지수 데이터 없음(모의 미지원 가능) → 게이트 스킵(통과 처리)');
    }
  } else {
    note('gate', '시장추세: 데이터 인증 없음 → 게이트 스킵(통과 처리)');
  }
  if (cfg.regimeSizing) { // 코스피 vs MA 마진에 비례해 목표 매수액 축소(추가 KIS 호출 없음)
    if (kospiIdx != null && kospiMa) {
      regimeFactor = regimeFactorFor(kospiIdx, kospiMa, cfg);
      note('gate', `regime 사이징: factor ${regimeFactor.toFixed(2)} (목표 매수액 ${Math.round(cfg.orderKrw * regimeFactor).toLocaleString()})`, { regimeFactor });
    } else {
      regimeFactor = cfg.regimeFallbackFull === false ? clampFrac(cfg.regimeMinFraction) : 1;
      note('gate', `regime 사이징: 코스피 데이터 없음 → fallback factor ${regimeFactor.toFixed(2)}`, { regimeFactor });
    }
  }

  const order = async (action) => {
    // 실제 주문 또는 dry-run 로그. 매수 시 bought/tranches 기록. dayOrders는 dry/live 모두 증가
    // (분할매수/부분익절의 일일 주문 한도 거동을 dry-run에서도 동일하게 검증하기 위함).
    // 반환값: 접수 성공 여부 — 실패 시 호출부가 성과기록/상태정리/현금차감을 하면 안 된다
    // (실패한 매도를 체결로 기록하면 가짜 거래가 통계를 오염시키고, 상태를 지우면 재시도가 막힘).
    const onBuy = () => {
      state.bought[action.ticker] = today;
      state.tranches[action.ticker] = (state.tranches[action.ticker] || 0) + 1;
    };
    // 성공 체결만 원장에 적재(매수/매도·dry 공통). 매도는 pnl/pct/partial을 함께 보존.
    const logFill = (orderNo) => recordFill(state, {
      t: ts, kind: action.kind, ticker: action.ticker, name: action.name, qty: action.qty,
      price: action.fillPrice ?? null, reason: action.reason, dry: !!cfg.dryRun,
      ...(orderNo ? { orderNo } : {}),
      ...(action.pnl != null ? { pnl: action.pnl, pct: action.pct } : {}),
      ...(action.partial ? { partial: true } : {}),
    });
    if (cfg.dryRun) {
      note('dry', `[DRY] ${action.kind} ${action.name}(${action.ticker}) ${action.qty}주 @${action.price || '시장가'} — ${action.reason}`, action);
      state.dayOrders += 1;
      if (action.kind === '매수') onBuy();
      logFill();
      return true;
    }
    try {
      const res = await placeOrder(t, { ticker: action.ticker, qty: action.qty, isBuy: action.kind === '매수' });
      state.dayOrders += 1;
      if (action.kind === '매수') onBuy();
      const retryTag = res.retries ? ` [rate-limit 재시도 ${res.retries}회 후 성공]` : '';
      note('order', `✅ ${action.kind} ${action.name}(${action.ticker}) ${action.qty}주 — 주문번호 ${res.orderNo}${retryTag} (${action.reason})`, { ...action, orderNo: res.orderNo, retries: res.retries });
      logFill(res.orderNo);
      return true;
    } catch (e) {
      note('error', `❌ ${action.kind} ${action.name}(${action.ticker}) 실패: ${e.message}`, action);
      return false;
    }
  };

  // ── 1) 청산(익절/ATR·트레일링·고정 손절/EOD) — 보유 종목 대상 ──
  const eod = cfg.closeOnEod && isEodWindow(now);
  for (const h of bal.holdings) {
    // ⚠️ 청산(손절/익절/트레일링/EOD)은 워치리스트 안 종목에만 실행된다(아래 `reason && inWatch`).
    //    보유 종목을 워치에서 빼면 봇이 더는 청산하지 않으므로 수동 관리 필요(대시보드가 삭제 시 경고).
    //    EOD 종가청산은 당일 진입분만.
    const inWatch = cfg.watchlist.some(w => w.ticker === h.ticker);
    const y = h.avgPrice > 0 ? ((h.curPrice - h.avgPrice) / h.avgPrice) * 100 : 0;

    // ATR(변동성)과 보유 중 고점 — 트레일링/ATR 스탑 활성 시에만 일봉 조회
    let aTR = null;
    if (da && (cfg.useAtrStop || cfg.useTrailingStop)) {
      try { aTR = atr(await dailyCandles(da, h.ticker), cfg.atrPeriod); } catch (_) {}
    }
    if (cfg.useTrailingStop) state.peak[h.ticker] = Math.max(state.peak[h.ticker] || h.avgPrice, h.curPrice);

    // 분할익절(Tier 2): partialTpPct 도달 시 1회 부분매도, 잔량은 트레일링/풀익절로 계속.
    // 풀청산이 아니므로 peak/tranches/partialDone는 건드리지 않고, 같은 사이클 후속 청산은 생략(중복주문 방지).
    if (cfg.partialTpPct > 0 && !state.partialDone[h.ticker] && inWatch &&
        y >= cfg.partialTpPct && y < cfg.takeProfitPct) {
      const frac = clampFrac(cfg.partialTpFraction);
      const sellQty = Math.max(1, Math.floor(h.qty * frac));
      if (sellQty < h.qty && !dailyOrdersHit) {
        const pnl = Math.round((h.curPrice - h.avgPrice) * sellQty);
        const ok = await order({ kind: '매도', ticker: h.ticker, name: h.name, qty: sellQty, price: 0,
          fillPrice: Math.round(h.curPrice), pnl, pct: +y.toFixed(2), partial: true,
          reason: `부분익절(+${y.toFixed(2)}% ≥ ${cfg.partialTpPct}%, ${Math.round(frac * 100)}%)` });
        if (ok) {
          recordTrade(state, {
            t: ts, ticker: h.ticker, name: h.name, qty: sellQty,
            entry: Math.round(h.avgPrice), exit: Math.round(h.curPrice),
            pct: +y.toFixed(2), pnl,
            reason: '부분익절', dry: !!cfg.dryRun, partial: true,
          });
          state.partialDone[h.ticker] = true;
        }
        continue; // 실패해도 같은 사이클 내 동일 종목 추가 매도는 금지(다음 사이클에 재시도)
      }
    }

    let reason = null;
    if (y >= cfg.takeProfitPct) {
      reason = `익절(+${y.toFixed(2)}% ≥ ${cfg.takeProfitPct}%)`;
    } else if (cfg.useTrailingStop && aTR && state.peak[h.ticker]) {
      const peak = state.peak[h.ticker];
      const trailStop = peak - cfg.trailAtrMult * aTR;
      const armed = peak >= h.avgPrice * (1 + cfg.trailArmPct / 100); // 일정 수익 후 발동
      if (armed && h.curPrice <= trailStop) {
        reason = `트레일링청산(고점 ${Math.round(peak).toLocaleString()} − ${cfg.trailAtrMult}×ATR → ${Math.round(trailStop).toLocaleString()}, ${y.toFixed(2)}%)`;
      }
    }
    if (!reason) { // 손절: ATR 우선, ATR 불가 시 고정 %
      if (cfg.useAtrStop && aTR) {
        const atrStop = h.avgPrice - cfg.atrStopMult * aTR;
        if (h.curPrice <= atrStop) reason = `ATR손절(진입 ${Math.round(h.avgPrice).toLocaleString()} − ${cfg.atrStopMult}×ATR → ${Math.round(atrStop).toLocaleString()}, ${y.toFixed(2)}%)`;
      } else if (y <= -cfg.stopLossPct) {
        reason = `손절(${y.toFixed(2)}% ≤ -${cfg.stopLossPct}%)`;
      }
    }
    if (!reason && eod && state.bought[h.ticker] === today) reason = '종가청산(당일 진입분)';

    if (reason && inWatch) {
      // ⚠️ 청산(손절/익절/트레일링/EOD)은 일일 주문 한도로 막지 않는다 — 손절이 한도에 걸려
      //    보류되면 손실이 무한 확대될 수 있음(핵심 안전 원칙: 청산은 항상 허용). 한도는 신규 매수에만.
      const pnl = Math.round((h.curPrice - h.avgPrice) * h.qty);
      const ok = await order({ kind: '매도', ticker: h.ticker, name: h.name, qty: h.qty, price: 0,
        fillPrice: Math.round(h.curPrice), pnl, pct: +y.toFixed(2), reason });
      if (ok) {
        recordTrade(state, {
          t: ts, ticker: h.ticker, name: h.name, qty: h.qty,
          entry: Math.round(h.avgPrice), exit: Math.round(h.curPrice),
          pct: +y.toFixed(2), pnl,
          reason, dry: !!cfg.dryRun,
        });
        // 풀청산: 보유 상태(고점/트랜치/부분익절 이력)를 함께 정리
        delete state.peak[h.ticker]; delete state.tranches[h.ticker]; delete state.partialDone[h.ticker];
      } // 실패 시 상태 보존 → 다음 사이클에 청산 재시도
    }
  }

  // ── 2) 진입(변동성 돌파 + 추세) — 워치리스트 대상 ──
  const canBuyGate = marketGate && !dailyLossHit && !cfg.killSwitch;
  if (!canBuyGate) {
    note('gate', `신규 매수 차단: ${!marketGate ? '시장관망 ' : ''}${dailyLossHit ? '일일손실한도 ' : ''}`.trim() || '게이트 미통과');
  } else if (!da) {
    note('warn', '신규 매수 스킵: 시세 데이터 인증 없음(변동성 돌파 계산 불가)');
  } else {
    const effectiveOrderKrw = Math.max(0, Math.round(cfg.orderKrw * regimeFactor)); // regime 반영 목표 매수액
    const maxT = Math.max(1, Math.min(5, parseInt(cfg.entryTranches, 10) || 1));     // 분할매수 트랜치 수(1=단발)
    // 스캔 커서 회전: 예산/한도로 스캔이 끊겨도 다음 사이클이 끊긴 지점부터 이어서 보게 해
    // 워치리스트 전체가 공평하게 순회되도록 한다(없으면 뒤쪽 종목이 영원히 스캔 안 될 수 있음).
    const wlN = cfg.watchlist.length;
    const scanStart = (parseInt(state.scanCursor, 10) || 0) % wlN;
    let scanBroke = false;
    for (let wi = 0; wi < wlN; wi++) {
      const w = cfg.watchlist[(scanStart + wi) % wlN];
      try {
        if (state.dayOrders >= cfg.dailyMaxOrders) {
          note('warn', '일일 주문 한도 초과 → 매수 중단');
          state.scanCursor = (scanStart + wi) % wlN; scanBroke = true;
          break;
        }
        // 종목당 일봉+현재가 2건 + 주문 몫을 쓸 예산이 안 남으면, 주문 fetch까지 죽는
        // "Too many subrequests"를 피하기 위해 스캔을 멈춘다(나머지 종목은 다음 사이클에).
        if (subreqLeft() <= SUBREQ_ORDER_RESERVE + 2) {
          note('warn', `Cloudflare subrequest 예산 임박(잔여 ${subreqLeft()}) → 나머지 종목은 다음 사이클이 이어서 스캔`);
          state.scanCursor = (scanStart + wi) % wlN; scanBroke = true;
          break;
        }
        const filled = state.tranches[w.ticker] || 0;
        if (filled >= maxT) continue; // 트랜치 모두 채움(maxT=1이면 포지션당 1회 = 기존 동작)
        // 당일 이미 진입했다가 청산된 종목(filled=0인데 bought=today)은 당일 재진입 금지.
        // 손절 직후 같은 종목 재매수를 막고, maxT=1에서 기존 '당일 1회' 불변식을 보존한다.
        if (state.bought[w.ticker] === today && filled === 0) continue;
        // 단발(maxT=1)일 때만 '이미 보유 시 진입 생략'. 분할매수(maxT>1)는 보유 중에도 트랜치를 더 쌓음.
        if (heldBy[w.ticker] && maxT <= 1) { note('skip', `${w.name || w.ticker}: 이미 보유 중 → 진입 생략`); continue; }

        const candles = await dailyCandles(da, w.ticker);
        const px = await currentPrice(da, w.ticker);
        if (!candles.length || !px.price) { note('skip', `${w.ticker}: 시세 없음`); continue; }

        const todayOpen = candles[0]?.open || px.open;
        const prev = candles[1] || candles[0];
        const range = (prev.high - prev.low) || 0;
        const target = todayOpen + cfg.breakoutK * range; // 변동성 돌파선
        const closes = candles.slice(1, cfg.maPeriod + 1).map(c => c.close); // 전일 기준 MA
        const ma = sma(closes, cfg.maPeriod);

        const breakout = px.price >= target && range > 0;
        const trendOk = ma == null ? true : px.price >= ma;

        // 돌파 품질 확인(Tier 1) — 가짜 돌파 억제
        const avgVol = avgVolume(candles, cfg.maPeriod);
        const todayVol = candles[0]?.volume || 0;
        const volRatio = avgVol ? todayVol / avgVol : null;
        const volOk = !cfg.requireVolumeConfirm || (volRatio != null && volRatio >= cfg.volMultiplier);
        const aTRv = atr(candles, cfg.atrPeriod);
        const todayRange = (candles[0] ? candles[0].high - candles[0].low : (px.high - px.low)) || 0;
        const rangeOk = !cfg.requireRangeExpansion || (aTRv != null && todayRange >= aTRv);
        // ADX 추세강도 필터(Tier 2) — 봉 부족으로 계산 불가 시 보수적으로 차단(횡보 억제 목적)
        const adxV = cfg.requireAdx ? adx(candles, cfg.adxPeriod) : null;
        const adxOk = !cfg.requireAdx || (adxV != null && adxV >= cfg.adxMin);

        if (!breakout || !trendOk || !volOk || !rangeOk || !adxOk) {
          const fail = [!breakout && '돌파X', !trendOk && '추세X', !volOk && `거래량X(${volRatio ? volRatio.toFixed(1) : '-'}<${cfg.volMultiplier})`, !rangeOk && '변동폭X', !adxOk && `ADX X(${adxV != null ? adxV.toFixed(1) : '-'}<${cfg.adxMin})`].filter(Boolean).join(' ');
          note('signal', `${w.name || w.ticker}: 신호없음 [${fail}] (현재 ${px.price.toLocaleString()} / 돌파선 ${Math.round(target).toLocaleString()} / MA${cfg.maPeriod} ${ma ? Math.round(ma).toLocaleString() : '-'})`);
          continue;
        }

        // 사이징: regime 반영 목표액(effectiveOrderKrw)을 트랜치(maxT)로 분할 + 비중/현금 게이트(②)
        const trancheKrw = Math.floor(effectiveOrderKrw / maxT);
        let qty = Math.floor(trancheKrw / px.price);
        const maxPosKrw = bal.totalValue * (cfg.maxPositionPct / 100);
        const heldVal = heldBy[w.ticker]?.value || 0;
        if (heldVal + qty * px.price > maxPosKrw) {
          qty = Math.floor((maxPosKrw - heldVal) / px.price);
        }
        const cashFloor = bal.totalValue * (cfg.cashFloorPct / 100);
        if (bal.cash - qty * px.price < cashFloor) {
          qty = Math.floor((bal.cash - cashFloor) / px.price);
        }
        if (qty < 1) { note('skip', `${w.name || w.ticker}: 매수 신호 있으나 한도(비중/현금)로 수량 0 → 생략`); continue; }

        const ok = await order({
          kind: '매수', ticker: w.ticker, name: w.name || w.ticker, qty, price: 0, fillPrice: Math.round(px.price),
          reason: `변동성돌파 ${maxT > 1 ? `[트랜치 ${filled + 1}/${maxT}] ` : ''}(현재 ${px.price.toLocaleString()} ≥ 돌파선 ${Math.round(target).toLocaleString()}, MA${cfg.maPeriod}↑${volRatio ? `, 거래량 ${volRatio.toFixed(1)}배` : ''}${adxV != null ? `, ADX ${adxV.toFixed(0)}` : ''})`,
        });
        // 매수 성공 시에만 현금 차감(같은 사이클 내 다음 종목 계산 보정)
        if (ok) bal.cash -= qty * px.price;
      } catch (e) {
        note('error', `${w.name || w.ticker} 처리 실패: ${e.message}`);
      }
    }
    if (!scanBroke) state.scanCursor = 0; // 전 종목 스캔 완료 → 다음 사이클은 처음부터
  }

  // 성공 체결(order/dry)만 집계 — 실패(error 노트)는 제외. 부분익절도 '매도'로 합산됨.
  const filled = (kind) => events.filter(e => (e.level === 'order' || e.level === 'dry') && e.kind === kind).length;
  return finish(`사이클 완료 (매수${filled('매수')} 매도${filled('매도')} / 주문누계 ${state.dayOrders})`);
}

// ── cron 워치독 ──────────────────────────────────────────────────
// 2026-06-12: cron 스케줄이 등록돼 있어도 Cloudflare가 실행하지 않는 장애 발생(스케줄
// 삭제 후 재등록해도 미복구). 장중에 마지막 사이클이 WATCHDOG_STALE_MIN을 넘게 오래되면
// HTTP 요청(대시보드 폴링 ≈60s, /health 핑)의 수명(waitUntil)을 빌려 사이클을 보충 실행한다.
// 중복 실행은 acquireLock이 막고, runCycle 내부 게이트(enabled/거래시간/킬스위치)가 그대로
// 적용되며, cron이 정상 동작하는 동안에는 staleness 조건이 안 걸려 완전히 잠잠하다.
const WATCHDOG_STALE_MIN = 7;
function kstStrToMs(s) { // "20260612 10:19 KST" → epoch ms (KST=UTC+9 고정)
  const m = /^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2})/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5]) : 0;
}
async function maybeWatchdogCycle(env, { full = false } = {}) {
  if (!isMarketHours(nowKST())) return null;
  const cfg = await getCfg(env);
  if (!cfg.enabled || cfg.killSwitch) return null;
  const state = await getState(env);
  const last = kstStrToMs(state.lastCycleAt);
  if (last && Date.now() - last < WATCHDOG_STALE_MIN * 60 * 1000) return null;
  // full(=/api/kick 동기 호출): 응답을 사이클 완료 후 반환하므로 waitUntil 30초 제한이 없다
  //   → 거의 전체 예산으로 풀 사이클. 대시보드가 폴링마다 호출(돌지 말지는 여기서 판단).
  // fallback(=GET waitUntil 경유): 응답 후 ~30초 안에 끝나야 강제 취소를 면하므로 KIS
  //   호출을 ~12건으로 바짝 줄인다(청산·매도 우선은 그대로, 스캔은 scanCursor 회전으로 분할).
  return runCycle(env, { manual: false, watchdog: true, budgetPad: full ? 6 : 26 });
}

// ── HTTP API (대시보드) ──────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}

// ── 비챙이(Bichangi) 연동 ───────────────────────────────────────────
// 미설정(토큰 없음) 시 무동작. 전송 실패해도 매매 사이클에 영향 없음(호출부에서 try/catch).
async function notifyBichangi(env, { level, title, detail, items }) {
  try {
    if (!env.SVC_BICHANGI || !env.BICHANGI_INGEST_TOKEN) return;
    // 서비스 바인딩으로 호출(host 무시, path /api/agent-event가 비챙이에서 처리).
    await env.SVC_BICHANGI.fetch('https://bichangi/api/agent-event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.BICHANGI_INGEST_TOKEN },
      body: JSON.stringify({ agent: '부챙이', level, title, detail, items }),
    });
  } catch (e) { console.error('notifyBichangi 실패:', e && e.message); }
}

// 한 사이클의 events/state로 카톡 가치가 있는 alert만 만든다.
// 실체결(level 'order')·주문오류(level 'error')·일일손실한도 도달(하루 1회)만 alert.
// dry-run에서는 'order'/'error'가 생기지 않으므로 자동으로 조용함(스팸 방지).
function buildBichangiAlert(cfg, state, events) {
  // 체결·손실한도는 실시간 푸시하지 않는다(노이즈). 일손익·잔고는 비챙이 오전·오후
  // 브리핑(풀 /api/bichangi-status)으로 전달된다. 실시간 alert는 '주문 실패' 같은
  // 실제 오류만 — 매도/손절 실패 등 즉시 확인이 필요한 경우.
  const errors = events.filter((e) => e.level === 'error');
  if (!errors.length) return null;
  return {
    level: 'alert',
    title: `부챙이 주문 오류 ${errors.length}건`,
    detail: `${cfg.tradeEnv || ''}/${cfg.dryRun ? 'dry-run' : 'LIVE'} · 일손익 ${Number(state.dayPnl || 0).toLocaleString()}`,
    items: errors.map((e) => e.msg),
  };
}
function maskCfg(cfg) {
  const m = (s) => (s ? s.slice(0, 2) + '****' + s.slice(-2) : '');
  const out = { ...cfg, secret: m(cfg.secret), dataSecret: m(cfg.dataSecret),
    appkey: m(cfg.appkey), dataAppkey: m(cfg.dataAppkey),
    _hasSecret: !!cfg.secret, _hasDataSecret: !!cfg.dataSecret };
  delete out.geminiApiKey; delete out.geminiModel; // 구버전 저장값 노출 차단(방어적)
  return out;
}
function authed(request, env) {
  if (!env.ADMIN_TOKEN) return false; // 토큰 미설정이면 전부 거부(안전)
  const h = request.headers.get('Authorization') || '';
  return h === `Bearer ${env.ADMIN_TOKEN}`;
}

async function handleFetch(request, env, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  subreqReset(DEFAULT_CFG.cfSubreqLimit); // 기본값으로 리셋(runCycle/recommend/backtest는 cfg값으로 재설정)
  // cron 워치독: 응답을 막지 않도록 waitUntil로. (/api/run 수동 실행과는 락으로 상호배제)
  if (request.method === 'GET') ctx.waitUntil(maybeWatchdogCycle(env).catch((e) => console.error('워치독 실패:', e)));
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/health') {
    return json({ ok: true, service: 'buchangi-worker', now: `${ymd(nowKST())} ${hhmm(nowKST())} KST` });
  }

  // 비챙이(Bichangi) 풀 상태 — ADMIN_TOKEN이 아니라 ingest 토큰으로 보호(인증 게이트 앞).
  // 요약/체결 건수만 노출(KIS 키·계좌 등 민감정보 없음).
  if (path === '/api/bichangi-status' && request.method === 'GET') {
    const tok = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
      || url.searchParams.get('token') || '';
    if (!env.BICHANGI_INGEST_TOKEN || tok !== env.BICHANGI_INGEST_TOKEN) return json({ error: 'forbidden' }, 403);
    const [cfg, state] = await Promise.all([getCfg(env), getState(env)]);
    // 일손익 + 현재 잔고만 보고(체결 내역 나열 안 함).
    const bal = state.lastBalance || null;
    const dayPnl = Number((bal && bal.dayPnl != null ? bal.dayPnl : state.dayPnl) || 0);
    const lossHit = dayPnl <= -Math.abs(cfg.dailyMaxLossKrw || 0);
    const lastMs = kstStrToMs(state.lastCycleAt);
    // 장중·자동매매 ON·killswitch OFF인데 12분 넘게 사이클이 없으면 엔진 정지 의심.
    const stale = isMarketHours(nowKST()) && cfg.enabled && !cfg.killSwitch && lastMs && (Date.now() - lastMs > 12 * 60 * 1000);
    const status = (lossHit || stale) ? 'alert' : 'ok';
    const won = (n) => `${Number(n || 0).toLocaleString()}원`;
    const items = bal
      ? [
          `일손익 ${won(bal.dayPnl)}`,
          `총자산 ${won(bal.totalValue)}`,
          `현금 ${won(bal.cash)}`,
          `주식평가 ${won(bal.stockEval)} (${bal.holdings || 0}종목)`,
        ]
      : ['잔고 정보 대기 중 — 다음 매매 사이클에서 갱신됩니다'];
    return json({
      status,
      level: status === 'alert' ? 'alert' : 'info',
      summary: `부챙이 ${cfg.tradeEnv}/${cfg.dryRun ? 'dry' : 'LIVE'}${cfg.enabled ? '' : '(꺼짐)'}${cfg.killSwitch ? '(killswitch)' : ''}`
        + ` · 일손익 ${won(dayPnl)}${bal ? ` · 총자산 ${won(bal.totalValue)}` : ''}`
        + `${lossHit ? ' · ⚠️손실한도' : ''}${stale ? ' · ⚠️사이클 지연' : ''}`,
      items,
    });
  }

  // 이하 /api/* 는 모두 관리 토큰 필요
  if (!authed(request, env)) return json({ error: '인증 필요(Authorization: Bearer <ADMIN_TOKEN>)' }, 401);

  try {
    if (path === '/api/status' && request.method === 'GET') {
      const [cfg, state, log] = await Promise.all([getCfg(env), getState(env), getLogs(env)]);
      let balance = null;
      if (url.searchParams.get('balance') === '1' && cfg.appkey) {
        try { balance = await inquireBalance(await tradeAuth(env, cfg)); } catch (e) { balance = { error: e.message }; }
      }
      const stats = {
        all: tradeStats(state.trades), real: tradeStats(state.trades, { dryOnly: false }), dry: tradeStats(state.trades, { dryOnly: true }),
        recent: (state.trades || []).slice(-12).reverse(),
      };
      // 폴링 페이로드 절감: 체결 원장은 화면 표시분(+여유)만 내려보낸다. 전체(최대 FILLS_MAX)는
      // KV에 보존됨 — 이 핸들러는 setState를 하지 않으므로 응답용 복사본만 잘라도 영속 데이터 무손실.
      const stateOut = { ...state, fills: (state.fills || []).slice(-120) };
      return json({ cfg: maskCfg(cfg), state: stateOut, balance, stats, logTail: log.slice(-50) });
    }

    if (path === '/api/logs' && request.method === 'GET') {
      return json({ logs: await getLogs(env) });
    }

    if (path === '/api/backtest' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return json(await runBacktest(env, { tickers: body.tickers }));
    }

    if (path === '/api/config' && request.method === 'POST') {
      const body = await request.json();
      const cur = await getCfg(env);
      const next = { ...cur, ...body };
      // 빈 secret/appkey는 기존값 유지(마스킹된 값으로 덮어쓰기 방지)
      for (const k of ['secret', 'dataSecret', 'appkey', 'dataAppkey']) {
        if (body[k] === undefined || body[k] === '' || /\*\*\*\*/.test(body[k] || '')) next[k] = cur[k];
      }
      await setCfg(env, next);
      return json({ ok: true, cfg: maskCfg(next) });
    }

    if (path === '/api/killswitch' && request.method === 'POST') {
      const { on } = await request.json();
      const cfg = await getCfg(env);
      cfg.killSwitch = !!on;
      await setCfg(env, cfg);
      return json({ ok: true, killSwitch: cfg.killSwitch });
    }

    if (path === '/api/run' && request.method === 'POST') {
      const result = await runCycle(env, { manual: true });
      return json(result);
    }

    // 워치독 킥(동기): 대시보드가 폴링마다 호출. staleness(7분)·장중·락 판단은 워커가 하므로
    // 호출 자체는 무해하고, 사이클이 돌 때만 ran=true. (cron 미실행 장애 대응 — 2026-06-12)
    if (path === '/api/kick' && request.method === 'POST') {
      const result = await maybeWatchdogCycle(env, { full: true });
      return json({ ok: true, ran: !!result, summary: result ? result.summary : null });
    }

    if (path === '/api/recommend' && request.method === 'GET') {
      return json(await runRecommend(env));
    }

    if (path === '/api/reset-day' && request.method === 'POST') {
      await setState(env, freshDay(ymd(nowKST())));
      return json({ ok: true });
    }

    return json({ error: 'unknown endpoint: ' + path }, 404);
  } catch (e) {
    return json({ error: String(e.message || e) }, 500);
  }
}

const retiredLegacyHandler = {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env, { manual: false }).catch(async (e) => {
      const msg = `${ymd(nowKST())} ${hhmm(nowKST())} KST cron 사이클 예외: ${e.message || e}`;
      try {
        await appendLog(env, [{ t: `${ymd(nowKST())} ${hhmm(nowKST())} KST`, level: 'error', msg }]);
      } catch (err) {
        console.error('scheduled: appendLog 실패:', err);
        console.error(msg);
      }
      try {
        await notifyBichangi(env, { level: 'alert', title: '부챙이 cron 사이클 예외', detail: String(e.message || e).slice(0, 300) });
      } catch (_) {}
    }));
  },
};

// 순수 전략 로직 — 단위 테스트용 named export(Cloudflare 런타임은 default만 사용, 무영향).
export const _internals = { sma, atr, avgVolume, clampFrac, regimeFactorFor, adx, adxAt, smaAt, atrAt, avgVolAt, backtestSymbol, scoreCandidate, tradeStats, pickStrategyParams, marketGateMap,
  isKisRateLimited, isOrderRateLimited, subreqReset, subreqLeft, subreqTake, SUBREQ_ORDER_RESERVE, parseHolding, kstStrToMs, settledCash, dayPnlFrom, recordFill };

export { default } from './retired-worker.mjs';
