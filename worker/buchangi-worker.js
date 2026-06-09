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

  // 전략 추천(스캐너) — 워치리스트 후보를 자동 발굴
  recommendSource: 'volume',     // 후보 유니버스: 'volume'(거래량순위) | 'marketcap'(시총순위) | 'both'
  recommendCount: 30,            // 스캔할 후보 수(5~40, KIS 서브요청 한도 고려)
  recommendShortlist: 8,         // 정량 통과 중 AI 정성검토로 넘길 상위 N
  // 정성 2차(Gemini)는 대시보드(브라우저)에서 호출한다 — Google이 무료 Gemini API를
  // 서버 위치(워커 출구 IP) 기준으로 지역차단하기 때문. 키는 브라우저 localStorage에 보관.
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
function freshDay(today) {
  return { day: today, dayStartValue: null, dayPnl: 0, dayOrders: 0, bought: {}, lastCycleAt: null };
}
async function appendLog(env, entries) {
  const arr = (await env.BUCHANGI_KV.get('log', 'json')) || [];
  const next = arr.concat(entries).slice(-LOG_MAX);
  await env.BUCHANGI_KV.put('log', JSON.stringify(next));
}
async function getLogs(env) {
  return (await env.BUCHANGI_KV.get('log', 'json')) || [];
}

// ── KIS 토큰 (KV 캐시, 24h 유효) ─────────────────────────────────
async function issueToken(env, host, appkey, secret) {
  const cacheKey = `tok:${host.includes('vts') ? 'm' : 'r'}:${appkey.slice(-6)}`;
  const cached = await env.BUCHANGI_KV.get(cacheKey, 'json');
  if (cached && cached.token && cached.exp > Date.now()) return cached.token;

  const r = await fetch(host + '/oauth2/tokenP', {
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
// 간격 제어 + rate-limit 재시도가 적용된 KIS GET. { ok, status, d(파싱 JSON) } 반환.
async function kisGet(url, headers, { retries = 4 } = {}) {
  const gap = kisGapFor(url);
  for (let attempt = 0; ; attempt++) {
    await kisThrottle(gap);
    const r = await fetch(url, { headers });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch (_) { d = {}; }
    if (isKisRateLimited(r.status, text) && attempt < retries) {
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
async function inquireBalance(t) {
  const tr = t.isMock ? 'VTTC8434R' : 'TTTC8434R';
  const qs = new URLSearchParams({
    CANO: t.cano, ACNT_PRDT_CD: t.acntPrdtCd, AFHR_FLPR_YN: 'N', OFL_YN: '',
    INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N',
    FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '01', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
  });
  const r = await fetch(t.host + '/uapi/domestic-stock/v1/trading/inquire-balance?' + qs, {
    headers: kisHeaders(t.appkey, t.secret, t.token, tr),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`잔고조회 실패(${r.status}): ${d.msg1 || ''}`);
  const holdings = (d.output1 || []).map(h => ({
    name: h.prdt_name, ticker: h.pdno,
    qty: parseInt(h.hldg_qty, 10) || 0,
    avgPrice: parseFloat(h.pchs_avg_pric) || 0,
    curPrice: parseFloat(h.prpr) || 0,
    value: parseFloat(h.evlu_amt) || 0,
    pnl: parseFloat(h.evlu_pl_amt) || 0,
    yield: parseFloat(h.evlu_erng_rt) || 0,
  })).filter(h => h.qty > 0);
  const s = (d.output2 || [{}])[0] || {};
  const cash = parseFloat(s.dnca_tot_amt || s.prvs_rcvb_amt || 0);
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
async function dailyCandles(da, ticker) {
  const qs = new URLSearchParams({
    FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker,
    FID_PERIOD_DIV_CODE: 'D', FID_ORG_ADJ_PRC: '1',
  });
  const { ok, status, d } = await kisGet(da.host + '/uapi/domestic-stock/v1/quotations/inquire-daily-price?' + qs,
    kisHeaders(da.appkey, da.secret, da.token, 'FHKST01010400'));
  if (!ok || !Array.isArray(d.output)) throw new Error(`일봉 조회 실패(${status})`);
  return d.output.map(c => ({
    date: c.stck_bsop_date,
    open: parseFloat(c.stck_oprc) || 0,
    high: parseFloat(c.stck_hgpr) || 0,
    low: parseFloat(c.stck_lwpr) || 0,
    close: parseFloat(c.stck_clpr) || 0,
  }));
}

// 코스피 일봉(게이트 ①). 미지원/실패 시 null.
async function kospiDaily(da) {
  try {
    const qs = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: '0001',
      FID_INPUT_DATE_1: '', FID_INPUT_DATE_2: '', FID_PERIOD_DIV_CODE: 'D',
    });
    const { d } = await kisGet(da.host + '/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice?' + qs,
      kisHeaders(da.appkey, da.secret, da.token, 'FHKUP03500100'));
    const rows = d.output2 || d.output || [];
    if (!Array.isArray(rows) || !rows.length) return null;
    return rows.map(c => parseFloat(c.bstp_nmix_prpr || c.stck_clpr || 0)).filter(Boolean);
  } catch (_) { return null; }
}

async function placeOrder(t, { ticker, qty, isBuy, ordDvsn = '01', price = 0 }) {
  const tr = t.isMock ? (isBuy ? 'VTTC0802U' : 'VTTC0801U') : (isBuy ? 'TTTC0802U' : 'TTTC0801U');
  const r = await fetch(t.host + '/uapi/domestic-stock/v1/trading/order-cash', {
    method: 'POST',
    headers: kisHeaders(t.appkey, t.secret, t.token, tr),
    body: JSON.stringify({
      CANO: t.cano, ACNT_PRDT_CD: t.acntPrdtCd, PDNO: ticker,
      ORD_DVSN: ordDvsn, ORD_QTY: String(qty), ORD_UNPR: String(price || 0),
    }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.rt_cd !== '0') throw new Error(d.msg1 || `주문 실패(${r.status})`);
  return { orderNo: d.output?.ODNO, msg: d.msg1 };
}

// ── 전략 헬퍼 ────────────────────────────────────────────────────
function sma(values, period) {
  if (!values || values.length < period) return null;
  const s = values.slice(0, period).reduce((a, b) => a + b, 0);
  return s / period;
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

  // ① 시장: 코스피 게이트(전 후보 공통). 데이터 없으면 통과 처리.
  const market = marketGreen ? 'GREEN' : 'RED';
  // ② 추세·모멘텀: MA 위 + 모멘텀 비음수(투챙이 '섹터 흐름' 자리를 부챙이 데이터로 치환)
  const trendOk = (ma == null ? price >= today.open : price >= ma) && (mom == null || mom >= 0);
  // ③ 변동성 셋업·유동성: 양봉 + 돌파선 -3% 이내(근접/돌파) + 유효 변동폭
  const setupOk = range > 0 && price >= today.open && breakoutDist >= -3;

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
      volume: c.volume || null, maPeriod: cfg.maPeriod, marketAvailable,
    },
  };
}

async function runRecommend(env) {
  const cfg = await getCfg(env);
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

// ── 매매 사이클 ──────────────────────────────────────────────────
async function runCycle(env, { manual = false } = {}) {
  const cfg = await getCfg(env);
  const now = nowKST();
  const today = ymd(now);
  const ts = `${today} ${hhmm(now)} KST`;
  const events = [];
  const note = (level, msg, extra) => events.push({ t: ts, level, msg, ...(extra || {}) });

  let state = await getState(env);
  if (state.day !== today) state = freshDay(today);
  state.lastCycleAt = ts;

  const finish = async (summary) => {
    note('cycle', summary);
    await setState(env, state);
    await appendLog(env, events);
    return { ok: true, ts, summary, events };
  };

  // ── 사전 게이트 ──
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

  // 일일 손익 기준값(그날 첫 사이클에 스냅샷)
  if (state.dayStartValue == null) state.dayStartValue = bal.totalValue;
  state.dayPnl = Math.round(bal.totalValue - state.dayStartValue);

  const dailyLossHit = state.dayPnl <= -Math.abs(cfg.dailyMaxLossKrw);
  const dailyOrdersHit = state.dayOrders >= cfg.dailyMaxOrders;
  note('info', `잔고: 현금 ${bal.cash.toLocaleString()} / 평가 ${bal.stockEval.toLocaleString()} / 총 ${bal.totalValue.toLocaleString()} / 일손익 ${state.dayPnl.toLocaleString()} / 주문 ${state.dayOrders}건`,
    { dayPnl: state.dayPnl, dayOrders: state.dayOrders, cash: bal.cash, totalValue: bal.totalValue });
  if (dailyLossHit) note('warn', `일일 손실 한도 도달(${state.dayPnl.toLocaleString()} ≤ -${cfg.dailyMaxLossKrw.toLocaleString()}) → 신규 매수 중단(손절 매도는 허용)`);

  // 데이터 인증(시세). 실패해도 청산 로직은 잔고 기반으로 가능.
  let da = null;
  try { da = await dataAuth(env, cfg); } catch (e) { note('warn', '데이터 인증 실패: ' + e.message); }

  // ── 게이트 ①: 시장 추세 (코스피 MA) ──
  let marketGate = true;
  if (da) {
    const closes = await kospiDaily(da);
    const ma = sma(closes, cfg.marketMaPeriod);
    if (closes && ma) {
      const idx = closes[0];
      marketGate = idx >= ma;
      note('gate', `시장추세: 코스피 ${idx.toFixed(2)} vs MA${cfg.marketMaPeriod} ${ma.toFixed(2)} → ${marketGate ? '매수허용' : '관망'}`);
    } else {
      note('gate', '시장추세: 코스피 지수 데이터 없음(모의 미지원 가능) → 게이트 스킵(통과 처리)');
    }
  } else {
    note('gate', '시장추세: 데이터 인증 없음 → 게이트 스킵(통과 처리)');
  }

  const order = async (action, h) => {
    // 실제 주문 또는 dry-run 로그. dayOrders 증가.
    if (cfg.dryRun) {
      note('dry', `[DRY] ${action.kind} ${action.name}(${action.ticker}) ${action.qty}주 @${action.price || '시장가'} — ${action.reason}`, action);
      if (action.kind === '매수') state.bought[action.ticker] = today; // 중복 방지
      return;
    }
    try {
      const res = await placeOrder(t, { ticker: action.ticker, qty: action.qty, isBuy: action.kind === '매수' });
      state.dayOrders += 1;
      if (action.kind === '매수') state.bought[action.ticker] = today;
      note('order', `✅ ${action.kind} ${action.name}(${action.ticker}) ${action.qty}주 — 주문번호 ${res.orderNo} (${action.reason})`, { ...action, orderNo: res.orderNo });
    } catch (e) {
      note('error', `❌ ${action.kind} ${action.name}(${action.ticker}) 실패: ${e.message}`, action);
    }
  };

  // ── 1) 청산(익절/손절/EOD) — 보유 종목 대상 ──
  const eod = cfg.closeOnEod && isEodWindow(now);
  for (const h of bal.holdings) {
    // 워치리스트 밖 종목도 보유 중이면 손절/익절은 적용(안전). 단 EOD 당일분만.
    const inWatch = cfg.watchlist.some(w => w.ticker === h.ticker);
    const y = h.avgPrice > 0 ? ((h.curPrice - h.avgPrice) / h.avgPrice) * 100 : 0;
    let reason = null;
    if (y >= cfg.takeProfitPct) reason = `익절(+${y.toFixed(2)}% ≥ ${cfg.takeProfitPct}%)`;
    else if (y <= -cfg.stopLossPct) reason = `손절(${y.toFixed(2)}% ≤ -${cfg.stopLossPct}%)`;
    else if (eod && state.bought[h.ticker] === today) reason = '종가청산(당일 진입분)';
    if (reason && inWatch) {
      if (dailyOrdersHit) { note('warn', `매도 보류(${h.name}): 일일 주문 한도 초과`); continue; }
      await order('매도', { kind: '매도', ticker: h.ticker, name: h.name, qty: h.qty, price: 0, reason });
    }
  }

  // ── 2) 진입(변동성 돌파 + 추세) — 워치리스트 대상 ──
  const canBuyGate = marketGate && !dailyLossHit && !cfg.killSwitch;
  if (!canBuyGate) {
    note('gate', `신규 매수 차단: ${!marketGate ? '시장관망 ' : ''}${dailyLossHit ? '일일손실한도 ' : ''}`.trim() || '게이트 미통과');
  } else if (!da) {
    note('warn', '신규 매수 스킵: 시세 데이터 인증 없음(변동성 돌파 계산 불가)');
  } else {
    for (const w of cfg.watchlist) {
      try {
        if (state.dayOrders >= cfg.dailyMaxOrders) { note('warn', '일일 주문 한도 초과 → 매수 중단'); break; }
        if (state.bought[w.ticker] === today) { continue; } // 당일 1회 매수 제한
        if (heldBy[w.ticker]) { note('skip', `${w.name || w.ticker}: 이미 보유 중 → 진입 생략`); continue; }

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
        if (!breakout || !trendOk) {
          note('signal', `${w.name || w.ticker}: 신호없음 (현재 ${px.price.toLocaleString()} / 돌파선 ${Math.round(target).toLocaleString()} / MA${cfg.maPeriod} ${ma ? Math.round(ma).toLocaleString() : '-'})`);
          continue;
        }

        // 사이징 + 비중/현금 게이트(②)
        let qty = Math.floor(cfg.orderKrw / px.price);
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

        await order('매수', {
          kind: '매수', ticker: w.ticker, name: w.name || w.ticker, qty, price: 0,
          reason: `변동성돌파 (현재 ${px.price.toLocaleString()} ≥ 돌파선 ${Math.round(target).toLocaleString()}, MA${cfg.maPeriod}↑)`,
        });
        // 매수 후 현금 차감(같은 사이클 내 다음 종목 계산 보정)
        bal.cash -= qty * px.price;
      } catch (e) {
        note('error', `${w.name || w.ticker} 처리 실패: ${e.message}`);
      }
    }
  }

  return finish(`사이클 완료 (매수${events.filter(e => e.kind === '매수' || (e.level === 'dry' && e.msg.includes('매수'))).length} 매도${events.filter(e => e.kind === '매도' || (e.level === 'dry' && e.msg.includes('매도'))).length} / 주문누계 ${state.dayOrders})`);
}

// ── HTTP API (대시보드) ──────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
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
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' || path === '/health') {
    return json({ ok: true, service: 'buchangi-worker', now: `${ymd(nowKST())} ${hhmm(nowKST())} KST` });
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
      return json({ cfg: maskCfg(cfg), state, balance, logTail: log.slice(-50) });
    }

    if (path === '/api/logs' && request.method === 'GET') {
      return json({ logs: await getLogs(env) });
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

export default {
  async fetch(request, env, ctx) {
    return handleFetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCycle(env, { manual: false }).catch(async (e) => {
      await appendLog(env, [{ t: `${ymd(nowKST())} ${hhmm(nowKST())} KST`, level: 'error', msg: 'cron 사이클 예외: ' + (e.message || e) }]);
    }));
  },
};
