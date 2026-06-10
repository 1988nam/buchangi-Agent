/**
 * 부챙이 대시보드 — UI 로직
 */
(() => {
  const $ = (id) => document.getElementById(id);
  // 입력 중(포커스된)인 칸은 자동 새로고침이 덮어쓰지 않는다 — 자격증명 입력 도중 값이 지워지는 것 방지
  const setIfIdle = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
  const cfgVals = window.BUCHANGI_CONFIG || {};
  let curCfg = null;
  let timer = null;
  let strategyDirty = false; // 프리셋/수동 편집 중인 미저장 전략값을 자동새로고침이 덮지 않게

  const NUM_FIELDS = ['orderKrw', 'breakoutK', 'maPeriod', 'takeProfitPct', 'stopLossPct',
    'marketMaPeriod', 'cashFloorPct', 'maxPositionPct', 'dailyMaxLossKrw', 'dailyMaxOrders',
    'atrPeriod', 'atrStopMult', 'trailAtrMult', 'trailArmPct', 'volMultiplier',
    'entryTranches', 'partialTpPct', 'partialTpFraction', 'regimeFullMarginPct', 'regimeMinFraction', 'adxPeriod', 'adxMin'];
  const BOOL_FIELDS = ['closeOnEod', 'useAtrStop', 'useTrailingStop', 'requireVolumeConfirm', 'requireRangeExpansion',
    'regimeSizing', 'regimeFallbackFull', 'requireAdx'];

  // ── 투자성향 프리셋(폼만 채움 — 저장은 사용자가 「전략 저장」으로) ──
  const PRESETS = {
    safe: { // 🛡️ 안전: 빨리 손절·현금 많이·분산·보호필터 ON·분할매수·오버나이트 회피
      orderKrw: 300000, breakoutK: 0.6, maPeriod: 10, takeProfitPct: 4, stopLossPct: 2,
      marketMaPeriod: 20, cashFloorPct: 50, maxPositionPct: 15, dailyMaxLossKrw: 100000, dailyMaxOrders: 5, closeOnEod: true,
      // 안전=손절 2% 고정으로 빨리 자름(useAtrStop OFF). 수익 구간엔 트레일링으로 잠금.
      atrPeriod: 14, useAtrStop: false, atrStopMult: 1.5, useTrailingStop: true, trailAtrMult: 2.0, trailArmPct: 1,
      requireVolumeConfirm: true, volMultiplier: 1.5, requireRangeExpansion: false,
      entryTranches: 3, partialTpPct: 2, partialTpFraction: 0.5,
      regimeSizing: true, regimeFullMarginPct: 3, regimeMinFraction: 0.3, regimeFallbackFull: false,
      requireAdx: true, adxPeriod: 14, adxMin: 25,
    },
    normal: { // ⚖️ 보통: 현재 검증된 기본값(보호필터 OFF, 단발 변동성돌파+추세)
      orderKrw: 500000, breakoutK: 0.5, maPeriod: 5, takeProfitPct: 5, stopLossPct: 3,
      marketMaPeriod: 20, cashFloorPct: 30, maxPositionPct: 25, dailyMaxLossKrw: 200000, dailyMaxOrders: 10, closeOnEod: false,
      atrPeriod: 14, useAtrStop: false, atrStopMult: 2.0, useTrailingStop: false, trailAtrMult: 2.5, trailArmPct: 1,
      requireVolumeConfirm: false, volMultiplier: 1.5, requireRangeExpansion: false,
      entryTranches: 1, partialTpPct: 0, partialTpFraction: 0.5,
      regimeSizing: false, regimeFullMarginPct: 3, regimeMinFraction: 0.4, regimeFallbackFull: true,
      requireAdx: false, adxPeriod: 14, adxMin: 20,
    },
    aggressive: { // 🔥 공격: 크게·집중·손절 넓게·필터 OFF로 기회 많이·오버나이트 보유
      orderKrw: 1000000, breakoutK: 0.4, maPeriod: 5, takeProfitPct: 8, stopLossPct: 5,
      marketMaPeriod: 20, cashFloorPct: 10, maxPositionPct: 40, dailyMaxLossKrw: 400000, dailyMaxOrders: 20, closeOnEod: false,
      atrPeriod: 14, useAtrStop: true, atrStopMult: 3.0, useTrailingStop: true, trailAtrMult: 3.0, trailArmPct: 2,
      requireVolumeConfirm: false, volMultiplier: 1.5, requireRangeExpansion: false,
      entryTranches: 1, partialTpPct: 0, partialTpFraction: 0.5,
      regimeSizing: false, regimeFullMarginPct: 3, regimeMinFraction: 0.4, regimeFallbackFull: true,
      requireAdx: false, adxPeriod: 14, adxMin: 20,
    },
  };

  // ── 용어 설명(ⓘ 툴팁) — 각 전략 파라미터 1줄 설명 ──
  const HELP = {
    orderKrw: '한 번에 매수할 금액(원). 계좌 규모에 맞게. 분할매수를 켜면 이 금액을 나눠서 들어갑니다.',
    breakoutK: '변동성 돌파 계수. 전일 변동폭 × k 만큼 오르면 매수 신호. 높을수록 큰 돌파만(신중·거래↓), 낮을수록 자주 진입(공격·거래↑).',
    maPeriod: '종목 추세 판단용 이동평균 일수. 현재가가 이 평균 위일 때만 매수(역추세 방지). 길수록 추세 확인이 엄격.',
    takeProfitPct: '이 수익률(%)에 도달하면 전량 익절.',
    stopLossPct: '이 손실률(%)에 도달하면 전량 손절. 작을수록 빨리 손실을 자릅니다(방어적).',
    marketMaPeriod: '코스피 지수 이동평균 일수. 지수가 이 평균 위(상승장)일 때만 신규 매수 허용 — 시장 게이트.',
    cashFloorPct: '항상 남겨둘 현금 비중(%). 이 아래로 떨어지게는 매수하지 않음. 높을수록 보수적.',
    maxPositionPct: '한 종목이 차지할 수 있는 계좌 내 최대 비중(%). 낮을수록 여러 종목에 분산.',
    dailyMaxLossKrw: '하루 손실이 이 금액(원)을 넘으면 그날 신규 매수 중단(손절 매도는 계속).',
    dailyMaxOrders: '하루 최대 주문 횟수. 과도한 매매(수수료·과열) 방지.',
    closeOnEod: '장 마감 직전(15:10~) 당일 산 종목을 종가에 청산. 다음날 갭(오버나이트) 리스크 회피.',
    atrPeriod: 'ATR(평균 변동폭) 계산 기간(일). 변동성 기반 손절·트레일링에 사용.',
    useAtrStop: '켜면 고정 손절% 대신 ATR(변동성)에 맞춘 손절선 사용. 변동성 큰 종목은 손절폭을 더 넓게.',
    atrStopMult: 'ATR 손절폭 배수. 손절선 = 진입가 − (이 배수 × ATR). 작을수록 타이트(빨리 손절).',
    useTrailingStop: '켜면 수익이 나는 동안 고점을 따라 손절선을 끌어올림. 추세를 끝까지 먹되 꺾이면 청산.',
    trailAtrMult: '트레일링 폭 배수. 청산선 = 최고가 − (이 배수 × ATR). 작을수록 빨리 차익 실현.',
    trailArmPct: '이 수익(%) 이상 올라야 트레일링이 작동 시작 — 진입 직후 노이즈에 일찍 털리지 않게.',
    requireVolumeConfirm: '켜면 거래량이 평균보다 충분히 늘었을 때만 매수 — 가짜 돌파 억제.',
    volMultiplier: '거래량 확인 기준. 당일 거래량 ≥ (이 배수 × 평균 거래량)이어야 매수.',
    requireRangeExpansion: '켜면 당일 변동폭이 평소(ATR)보다 클 때만 매수 — 힘 있는 돌파만.',
    entryTranches: '한 종목을 몇 번에 나눠 살지(1=한 번에). 나눠 사면 평단가가 분산돼 진입 리스크↓.',
    partialTpPct: '이 수익(%)에 도달하면 보유의 일부를 먼저 익절(0=안 함). 나머지는 계속 보유.',
    partialTpFraction: '부분익절 시 팔 비율(0~1). 0.5=절반.',
    regimeFullMarginPct: '코스피가 MA보다 이 % 이상 위면 풀사이즈 매수(시장 강세 정도 기준).',
    regimeMinFraction: '약세장(MA 간신히 위)일 때 매수액 축소 하한(0~1). 0.4 = 평소의 40%까지 줄임.',
    regimeSizing: '켜면 시장이 약할수록 1회 매수액을 자동으로 줄임(약세장 방어).',
    regimeFallbackFull: '코스피 데이터를 못 받을 때 풀사이즈로 살지(켜기) 줄일지(끄기).',
    requireAdx: '켜면 추세 강도(ADX)가 충분할 때만 매수 — 횡보장 가짜 신호 억제.',
    adxPeriod: 'ADX 계산 기간(일). 일봉 데이터가 ~30개뿐이라 10~14 권장(키우면 매수가 멈출 수 있음).',
    adxMin: '이 ADX 값 이상이어야 매수. 20~25 = 뚜렷한 추세. 높을수록 엄격.',
  };
  function applyPreset(name) {
    const p = PRESETS[name]; if (!p) return;
    NUM_FIELDS.forEach(k => { if (p[k] != null && $('p-' + k)) $('p-' + k).value = p[k]; });
    BOOL_FIELDS.forEach(k => { if (p[k] != null && $('p-' + k)) $('p-' + k).checked = !!p[k]; });
    strategyDirty = true;
    document.querySelectorAll('#tab-strategy details.adv').forEach(d => { d.open = true; });
    document.querySelectorAll('.btn.preset').forEach(b => b.classList.toggle('active', b.dataset.preset === name));
    const label = { safe: '🛡️ 안전', normal: '⚖️ 보통', aggressive: '🔥 공격' }[name];
    toast(`${label} 프리셋 적용됨 — 검토 후 「전략 저장」을 누르세요`, 'success');
  }
  function injectHelp() {
    Object.entries(HELP).forEach(([k, tip]) => {
      const el = $('p-' + k); if (!el) return;
      const label = el.closest('label'); if (!label || label.querySelector('.tip')) return;
      const s = document.createElement('span');
      s.className = 'tip'; s.textContent = 'ⓘ'; s.tabIndex = 0;
      s.setAttribute('data-tip', tip);
      // ⓘ는 <label> 안에 있어 클릭 시 라벨의 체크박스를 토글시킴 → 차단(모바일 탭 포함)
      s.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      label.appendChild(s);
    });
  }

  // ── 유틸 ──
  const won = (n) => (n == null ? '-' : Math.round(n).toLocaleString() + '원');
  function toast(msg, type = 'info') {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show ' + type;
    setTimeout(() => (el.className = 'toast'), 3000);
  }
  function setBadge(id, text, cls) {
    const el = $(id); el.textContent = text; el.className = 'badge ' + cls;
  }

  // ── 연결 ──
  function loadConnUI() {
    const c = Api.getConn();
    $('c-url').value = c.url || '';
    $('c-token').value = c.token || '';
  }

  async function refresh() {
    if (!Api.isConfigured()) {
      setBadge('badge-conn', '연결 안 됨', 'gray');
      return;
    }
    try {
      const data = await Api.status(true);
      setBadge('badge-conn', '연결됨', 'green');
      render(data);
    } catch (e) {
      setBadge('badge-conn', '오류', 'red');
      toast('상태 조회 실패: ' + e.message, 'error');
    }
  }

  // ── 렌더 ──
  function render(data) {
    curCfg = data.cfg;
    // 배지
    setBadge('badge-env', '환경: ' + (curCfg.tradeEnv === 'real' ? '실전' : '모의(VTS)'),
      curCfg.tradeEnv === 'real' ? 'red' : 'blue');
    setBadge('badge-dry', curCfg.dryRun ? 'dry-run ON' : 'dry-run OFF',
      curCfg.dryRun ? 'amber' : 'green');
    setBadge('badge-enabled', curCfg.enabled ? '자동매매 ON' : '자동매매 OFF',
      curCfg.enabled ? 'green' : 'gray');
    $('kill-btn').classList.toggle('active', !!curCfg.killSwitch);
    $('kill-btn').textContent = curCfg.killSwitch ? '🛑 KILL 해제' : '🛑 KILL SWITCH';

    // 스위치
    $('sw-enabled').checked = !!curCfg.enabled;
    $('sw-dry').checked = !!curCfg.dryRun;
    $('sw-env').value = curCfg.tradeEnv || 'mock';

    // 상태 통계
    const st = data.state || {};
    const bal = data.balance && !data.balance.error ? data.balance : null;
    $('s-cash').textContent = bal ? won(bal.cash) : '-';
    $('s-eval').textContent = bal ? won(bal.stockEval) : '-';
    $('s-total').textContent = bal ? won(bal.totalValue) : '-';
    const pnl = st.dayPnl || 0;
    $('s-pnl').textContent = won(pnl);
    $('s-pnl').className = pnl > 0 ? 'up' : pnl < 0 ? 'down' : '';
    $('s-orders').textContent = `${st.dayOrders || 0} / ${curCfg.dailyMaxOrders}`;
    $('s-cycle').textContent = st.lastCycleAt || '-';
    if (data.balance && data.balance.error) toast('잔고: ' + data.balance.error, 'error');

    renderHoldings(bal ? bal.holdings : []);
    renderWatchlist(curCfg.watchlist || []);
    renderStrategy(curCfg);
    renderRecSettings(curCfg);
    renderKis(curCfg);
    renderPerf(data.stats);
    renderLog(data.logTail || []);
  }

  function renderPerf(stats) {
    if (!stats) return;
    const a = stats.all || {}, r = stats.real || {}, d = stats.dry || {};
    $('pf-winrate').textContent = a.count ? `${a.winRate}% (${a.wins}/${a.count})` : '-';
    $('pf-pnl').textContent = a.count ? won(a.totalPnl) : '-';
    $('pf-pnl').className = a.totalPnl > 0 ? 'pf-up' : a.totalPnl < 0 ? 'pf-down' : '';
    $('pf-count').textContent = `${r.count || 0} / ${d.count || 0}`;
    $('pf-mdd').textContent = a.count ? won(a.maxDrawdown) : '-';
    const rec = stats.recent || [];
    $('pf-note').innerHTML = rec.length
      ? '최근 청산: ' + rec.slice(0, 6).map(t =>
        `<span class="${t.pnl >= 0 ? 'pf-up' : 'pf-down'}">${esc(t.name || t.ticker)} ${t.pct >= 0 ? '+' : ''}${t.pct}%${t.dry ? '(dry)' : ''}</span>`).join(' · ')
      : '아직 청산된 거래가 없습니다 (매도가 발생하면 누적됩니다).';
  }

  function renderRecSettings(cfg) {
    setIfIdle('rec-source', cfg.recommendSource || 'volume');
    setIfIdle('rec-count', cfg.recommendCount != null ? cfg.recommendCount : 30);
    setIfIdle('rec-shortlist', cfg.recommendShortlist != null ? cfg.recommendShortlist : 8);
    if (document.activeElement !== $('rec-gemini')) $('rec-gemini').value = '';
    $('rec-gemini').placeholder = Api.hasGeminiKey() ? '저장됨 · 변경 시에만 입력' : '미설정(선택)';
  }

  function renderHoldings(holdings) {
    const tb = $('holdings-tbl').querySelector('tbody');
    if (!holdings || !holdings.length) {
      tb.innerHTML = '<tr><td colspan="8" class="muted">보유 종목 없음</td></tr>';
      return;
    }
    tb.innerHTML = holdings.map(h => `
      <tr>
        <td>${esc(h.name)}</td><td>${esc(h.ticker)}</td>
        <td>${h.qty.toLocaleString()}</td><td>${won(h.avgPrice)}</td>
        <td>${won(h.curPrice)}</td><td>${won(h.value)}</td>
        <td class="${h.pnl >= 0 ? 'up' : 'down'}">${won(h.pnl)}</td>
        <td class="${h.yield >= 0 ? 'up' : 'down'}">${h.yield.toFixed(2)}%</td>
      </tr>`).join('');
  }

  function renderWatchlist(list) {
    const ul = $('wl-list');
    if (!list.length) { ul.innerHTML = '<li class="muted">비어있음 — 종목을 추가하세요</li>'; return; }
    ul.innerHTML = list.map(w => `
      <li><span><b>${esc(w.name || '')}</b> <code>${esc(w.ticker)}</code></span>
      <button class="x" data-ticker="${esc(w.ticker)}">✕</button></li>`).join('');
    ul.querySelectorAll('.x').forEach(b => b.onclick = () => removeWatch(b.dataset.ticker));
  }

  function renderStrategy(cfg) {
    if (strategyDirty) return; // 미저장 편집/프리셋 값을 자동새로고침이 덮어쓰지 않게(저장 시 해제)
    NUM_FIELDS.forEach(k => { if ($('p-' + k)) setIfIdle('p-' + k, cfg[k]); });
    BOOL_FIELDS.forEach(k => { const el = $('p-' + k); if (el && document.activeElement !== el) el.checked = !!cfg[k]; });
  }

  function renderKis(cfg) {
    // 계좌는 노출 OK(전체값 표시). 키/시크릿류는 입력칸을 비워두고 저장 여부는 placeholder로만 안내
    // → 마스킹 값(PS****es)이 입력칸에 다시 들어가 재저장 시 무시되는 함정 제거.
    setIfIdle('k-account', cfg.account || '');
    ['k-appkey', 'k-secret', 'k-dataAppkey', 'k-dataSecret'].forEach(id => setIfIdle(id, ''));
    $('k-appkey').placeholder = cfg.appkey ? `저장됨 (${cfg.appkey}) · 변경 시에만 입력` : '미설정 — 입력 필요';
    $('k-secret').placeholder = cfg._hasSecret ? '저장됨 · 변경 시에만 입력' : '미설정 — 입력 필요';
    $('k-account').placeholder = '예: 5002345601 (10자리)';
    $('k-dataAppkey').placeholder = cfg.dataAppkey ? `저장됨 (${cfg.dataAppkey}) · 변경 시에만 입력` : '미설정(선택)';
    $('k-dataSecret').placeholder = cfg._hasDataSecret ? '저장됨 · 변경 시에만 입력' : '미설정(선택)';
  }

  function renderLog(logs) {
    const el = $('log');
    if (!logs.length) { el.innerHTML = '<p class="muted">로그 없음</p>'; return; }
    el.innerHTML = logs.slice().reverse().map(l =>
      `<div class="log-line lv-${esc(l.level)}"><span class="lt">${esc(l.t || '')}</span> <span class="lm">${esc(l.msg || '')}</span></div>`
    ).join('');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── 액션 ──
  async function saveCfgPatch(patch, okMsg) {
    try {
      const res = await Api.saveConfig(patch);
      curCfg = res.cfg;
      toast(okMsg || '저장됨', 'success');
      refresh();
      return true;
    } catch (e) { toast('저장 실패: ' + e.message, 'error'); return false; }
  }

  function addWatch() {
    const ticker = $('wl-ticker').value.trim();
    const name = $('wl-name').value.trim();
    if (!/^\d{6}$/.test(ticker)) { toast('종목코드 6자리를 입력하세요', 'error'); return; }
    const list = (curCfg?.watchlist || []).slice();
    if (list.some(w => w.ticker === ticker)) { toast('이미 있는 종목', 'error'); return; }
    list.push({ ticker, name });
    $('wl-ticker').value = ''; $('wl-name').value = '';
    saveCfgPatch({ watchlist: list }, '워치리스트 추가됨');
  }
  function removeWatch(ticker) {
    const list = (curCfg?.watchlist || []).filter(w => w.ticker !== ticker);
    saveCfgPatch({ watchlist: list }, '제거됨');
  }

  async function saveStrategy() {
    const patch = {};
    NUM_FIELDS.forEach(k => { patch[k] = parseFloat($('p-' + k).value) || 0; });
    BOOL_FIELDS.forEach(k => { patch[k] = $('p-' + k).checked; });
    // 방어 clamp: 분할매수 1~5, 부분익절/regime 축소 비율 0~1
    patch.entryTranches = Math.max(1, Math.min(5, Math.round(patch.entryTranches) || 1));
    patch.partialTpFraction = Math.max(0, Math.min(1, patch.partialTpFraction || 0));
    patch.regimeMinFraction = Math.max(0, Math.min(1, patch.regimeMinFraction || 0));
    // ⚠️ 저장 성공이 확인된 뒤에만 dirty 해제 — 실패 시 미저장 편집을 보존(자동새로고침이 덮지 않게)
    const ok = await saveCfgPatch(patch, '전략 저장됨');
    if (ok) {
      strategyDirty = false;
      document.querySelectorAll('.btn.preset').forEach(b => b.classList.remove('active'));
    }
  }

  function saveKis() {
    // 입력칸이 비어있으면 보내지 않음(서버가 기존값 유지) → 빈 값으로 덮어쓰기/마스킹 왕복 방지.
    // 즉 "바꾸려는 칸에만 값을 넣고 저장"하면 된다.
    const fields = {
      appkey: 'k-appkey', secret: 'k-secret', account: 'k-account',
      dataAppkey: 'k-dataAppkey', dataSecret: 'k-dataSecret',
    };
    const patch = {}; const saved = [];
    const labels = { appkey: '거래AppKey', secret: '거래Secret', account: '계좌', dataAppkey: '데이터AppKey', dataSecret: '데이터Secret' };
    for (const [k, id] of Object.entries(fields)) {
      const v = $(id).value.trim();
      if (v) { patch[k] = v; saved.push(labels[k]); }
    }
    if (!saved.length) { toast('변경할 칸에 값을 입력한 뒤 저장하세요', 'error'); return; }
    saveCfgPatch(patch, '저장됨: ' + saved.join(', '));
  }

  // ── 전략 추천(스캐너) ──
  function saveRecSettings() {
    const gem = $('rec-gemini').value.trim();
    if (gem) { Api.saveGeminiKey(gem); $('rec-gemini').value = ''; }
    saveCfgPatch({
      recommendSource: $('rec-source').value,
      recommendCount: Math.max(5, Math.min(40, parseInt($('rec-count').value, 10) || 30)),
      recommendShortlist: Math.max(0, Math.min(20, parseInt($('rec-shortlist').value, 10) || 8)),
    }, gem ? '추천 설정 + Gemini 키 저장됨' : '추천 설정 저장됨');
  }

  async function runRecommend() {
    const btn = $('rec-run');
    btn.disabled = true; btn.textContent = '분석 중…';
    $('rec-meta').textContent = ''; $('rec-ai').textContent = '';
    $('rec-results').innerHTML = '<p class="muted">KIS 시세로 후보를 스캔 중… (정량, 수십 초 소요)</p>';
    try {
      const data = await Api.recommend();
      renderRecommendations(data);
      // 정성 2차(Gemini)는 브라우저에서 — 워커는 지역차단되므로 여기서 호출
      if (data.ok && Api.hasGeminiKey() && (data.items || []).some(i => i.score >= 2)) {
        enrichWithGemini(data);
      } else if (data.ok && !Api.hasGeminiKey()) {
        $('rec-ai').textContent = 'ℹ️ Gemini 키를 넣으면 상위 종목을 AI가 정성 2차 검토합니다(정량 점수만으로도 동작).';
      }
    } catch (e) {
      $('rec-results').innerHTML = `<p class="muted">실패: ${esc(e.message)}</p>`;
      toast('추천 실패: ' + e.message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = '🔍 지금 분석';
    }
  }

  // 브라우저에서 Gemini 정성검토 → 상위 종목에 매수/관망 + 사유 주입 후 재렌더
  const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];
  async function enrichWithGemini(data) {
    const n = data.shortlist || 8;
    const shortlist = (data.items || []).filter(i => i.score >= 2).slice(0, n);
    if (!shortlist.length) return;
    $('rec-ai').textContent = `🤖 Gemini 정성검토 중… (상위 ${shortlist.length}종목)`;
    try {
      const { opinions, model } = await geminiAnnotate(Api.getGeminiKey(), data.market, shortlist);
      const byT = {}; (opinions || []).forEach(o => { byT[String(o.ticker)] = o; });
      data.items.forEach(it => { const o = byT[it.ticker]; if (o) { it.ai = { verdict: o.verdict, reason: o.reason }; it.verdict = o.verdict; } });
      data.aiUsed = true;
      renderRecommendations(data);
      $('rec-ai').textContent = `🤖 AI 정성검토 완료 · 모델 ${model}`;
    } catch (e) {
      $('rec-ai').textContent = '🤖 AI 검토 실패(정량 점수는 유효): ' + e.message;
    }
  }

  async function geminiAnnotate(apiKey, market, shortlist) {
    const sys = '너는 한국 주식 단기 자동매매 봇 "부챙이"의 보조 애널리스트다. '
      + '전략은 변동성 돌파 + 추세추종이며, 코스피 시장 게이트를 통과해야 신규 매수한다. '
      + '아래 후보는 이미 정량 필터(시장/추세/셋업)를 통과했다. 각 종목을 단기 진입 관점에서 최종 판정하라. '
      + '과최적화·뇌동매매를 경계하고, 불확실하면 보수적으로 "관망". 사유는 이슈/촉매/리스크를 담은 한국어 한 줄.';
    const payload = {
      시장: (market && market.available) ? { 코스피: Math.round(market.kospi), MA: Math.round(market.ma), 게이트: market.gate ? '통과' : '관망' } : '지수데이터없음',
      후보: shortlist.map(i => ({ ticker: i.ticker, name: i.name, 현재가: i.price, 단계: { 시장: i.market, 추세: i.trend, 셋업: i.setup }, 지표: i.metrics })),
    };
    const body = {
      systemInstruction: { parts: [{ text: sys }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            opinions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ticker: { type: 'string' },
                  verdict: { type: 'string', enum: ['매수', '관망'] },
                  reason: { type: 'string' },
                },
                required: ['ticker', 'verdict', 'reason'],
              },
            },
          },
          required: ['opinions'],
        },
      },
    };
    const models = [...new Set([Api.getGeminiModel(), ...GEMINI_MODELS].filter(Boolean))];
    let lastErr = '';
    for (const model of models) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        Api.saveGeminiModel(model);
        const text = (d.candidates && d.candidates[0] && d.candidates[0].content
          && d.candidates[0].content.parts && d.candidates[0].content.parts[0]
          && d.candidates[0].content.parts[0].text) || '{}';
        return { opinions: JSON.parse(text).opinions || [], model };
      }
      lastErr = `${res.status}: ${(d.error && d.error.message) || ''}`.slice(0, 160);
      if (res.status !== 404) throw new Error(lastErr); // 404(모델 없음)만 다음 후보로
    }
    throw new Error('사용 가능한 모델 없음 (' + lastErr + ')');
  }

  function _dot(s) {
    const g = String(s).toUpperCase() === 'GREEN';
    return `<span class="rdot ${g ? 'g' : 'r'}" title="${g ? '통과' : '미달'}"></span>`;
  }

  function renderRecommendations(data) {
    if (!data || !data.ok) {
      const extra = (data && data.notes && data.notes.length) ? ' · ' + data.notes.join(' / ') : '';
      $('rec-meta').textContent = '';
      $('rec-results').innerHTML = `<p class="muted">${esc((data && data.error) || '실패')}${esc(extra)}</p>`;
      return;
    }
    const m = data.market || {}, u = data.universe || {};
    const gateTxt = m.gate ? '🟢 매수허용' : '🔴 관망';
    const kospiTxt = (m.available && m.kospi) ? ` (코스피 ${Math.round(m.kospi)} / MA ${Math.round(m.ma)})` : '';
    $('rec-meta').textContent = `${data.ts} · ${u.source} ${u.scanned}종목 평가 ${u.evaluated}`
      + `${u.skipped ? ` (스킵 ${u.skipped})` : ''} · 시장게이트 ${gateTxt}${kospiTxt}`
      + `${data.aiUsed ? ' · 🤖 AI 정성검토 적용' : ''}`;
    const items = data.items || [];
    if (!items.length) { $('rec-results').innerHTML = '<p class="muted">조건 통과 종목 없음 — 시장이 관망 구간이거나 셋업이 없습니다.</p>'; return; }
    $('rec-results').innerHTML = items.map(recCard).join('');
    $('rec-results').querySelectorAll('.rec-add').forEach(b =>
      b.onclick = () => addWatchFromRec(b.dataset.ticker, b.dataset.name));
    if (data.notes && data.notes.length) {
      $('rec-results').insertAdjacentHTML('beforeend', `<p class="hint">ℹ️ ${esc(data.notes.join(' / '))}</p>`);
    }
  }

  function recCard(it) {
    const buy = it.verdict === '매수';
    const inWatch = (curCfg && curCfg.watchlist || []).some(w => w.ticker === it.ticker);
    const mt = it.metrics || {};
    const dist = mt.breakoutDist != null ? `${mt.breakoutDist >= 0 ? '+' : ''}${mt.breakoutDist}%` : '-';
    const momTxt = mt.mom != null ? ` · ${mt.maPeriod || ''}일 ${mt.mom >= 0 ? '+' : ''}${mt.mom}%` : '';
    return `<div class="rec-card${buy ? ' buy' : ''}">
      <div class="rec-top">
        <span><b>${esc(it.name)}</b> <code>${esc(it.ticker)}</code></span>
        <span class="rec-verdict ${buy ? 'g' : 'a'}">${esc(it.verdict)} · ${it.score}/3</span>
      </div>
      <div class="rec-dots">${_dot(it.market)}시장 ${_dot(it.trend)}추세 ${_dot(it.setup)}셋업</div>
      <div class="rec-metrics">${won(it.price)} · 돌파선 대비 ${dist}${momTxt}</div>
      ${it.ai && it.ai.reason ? `<div class="rec-reason">🤖 ${esc(it.ai.reason)}</div>` : ''}
      <button class="btn rec-add" data-ticker="${esc(it.ticker)}" data-name="${esc(it.name)}" ${inWatch ? 'disabled' : ''}>${inWatch ? '워치리스트에 있음' : '+ 워치리스트 추가'}</button>
    </div>`;
  }

  // ── 백테스트 ──
  async function runBacktest() {
    const btn = $('bt-run'); btn.disabled = true; btn.textContent = '백테스트 중…';
    $('bt-meta').textContent = '';
    $('bt-results').innerHTML = '<p class="muted">최근 일봉을 받아 전략 재생 중… (종목당 1회 조회)</p>';
    try {
      renderBacktest(await Api.backtest());
    } catch (e) {
      $('bt-results').innerHTML = `<p class="muted">실패: ${esc(e.message)}</p>`;
      toast('백테스트 실패: ' + e.message, 'error');
    } finally { btn.disabled = false; btn.textContent = '▶ 백테스트(워치리스트)'; }
  }

  function renderBacktest(data) {
    if (!data || !data.ok) {
      $('bt-meta').textContent = '';
      $('bt-results').innerHTML = `<p class="muted">${esc((data && data.error) || '실패')}</p>`;
      return;
    }
    const ag = data.aggregate || {};
    $('bt-meta').textContent = `${data.ts} · ${data.note || ''}`;
    const rows = (data.perTicker || []).map(p => p.error
      ? `<tr><td>${esc(p.name)}</td><td>${esc(p.ticker)}</td><td colspan="5" class="muted">${esc(p.error)}</td></tr>`
      : `<tr>
          <td>${esc(p.name)}</td><td>${esc(p.ticker)}</td>
          <td>${p.count}</td>
          <td>${p.count ? p.winRate + '%' : '-'}</td>
          <td class="${p.avgPct >= 0 ? 'pf-up' : 'pf-down'}">${p.count ? (p.avgPct >= 0 ? '+' : '') + p.avgPct + '%' : '-'}</td>
          <td class="${p.totalPnl >= 0 ? 'pf-up' : 'pf-down'}">${p.count ? won(p.totalPnl) : '-'}</td>
          <td class="pf-down">${p.count ? won(p.maxDrawdown) : '-'}</td>
        </tr>`).join('');
    $('bt-results').innerHTML = `
      <p class="hint">집계: 거래 <b>${ag.count || 0}</b>건 · 승률 <b>${ag.winRate || 0}%</b> · 평균 <b class="${ag.avgPct >= 0 ? 'pf-up' : 'pf-down'}">${ag.avgPct >= 0 ? '+' : ''}${ag.avgPct || 0}%</b> · 손익 <b class="${ag.totalPnl >= 0 ? 'pf-up' : 'pf-down'}">${won(ag.totalPnl || 0)}</b> · MDD <b class="pf-down">${won(ag.maxDrawdown || 0)}</b></p>
      <table class="tbl">
        <thead><tr><th>종목</th><th>코드</th><th>거래</th><th>승률</th><th>평균</th><th>손익</th><th>MDD</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">결과 없음</td></tr>'}</tbody>
      </table>`;
  }

  function addWatchFromRec(ticker, name) {
    const list = (curCfg && curCfg.watchlist || []).slice();
    if (list.some(w => w.ticker === ticker)) { toast('이미 워치리스트에 있음', 'error'); return; }
    list.push({ ticker, name });
    saveCfgPatch({ watchlist: list }, `${name}(${ticker}) 워치리스트 추가됨`);
  }

  async function saveConn() {
    Api.saveConn($('c-url').value, $('c-token').value);
    toast('연결 저장됨, 테스트 중...', 'info');
    await refresh();
  }

  async function toggleKill() {
    if (!curCfg) return;
    const on = !curCfg.killSwitch;
    if (on && !confirm('Kill switch를 켜면 신규 주문이 전면 중단됩니다. 진행할까요?')) return;
    try { await Api.killswitch(on); toast(on ? 'KILL ON' : 'KILL 해제', on ? 'error' : 'success'); refresh(); }
    catch (e) { toast('실패: ' + e.message, 'error'); }
  }

  async function runOnce() {
    if (!confirm('지금 한 사이클을 수동 실행합니다.' + (curCfg && !curCfg.dryRun && curCfg.tradeEnv === 'real' ? '\n\n⚠️ 실전 + dry-run OFF 상태 — 실제 주문이 나갈 수 있습니다!' : ''))) return;
    try { const r = await Api.runOnce(); toast('실행: ' + r.summary, 'success'); refresh(); }
    catch (e) { toast('실행 실패: ' + e.message, 'error'); }
  }

  async function resetDay() {
    if (!confirm('오늘 손익/주문 카운터와 당일 매수기록을 리셋할까요?')) return;
    try { await Api.resetDay(); toast('리셋됨', 'success'); refresh(); }
    catch (e) { toast('실패: ' + e.message, 'error'); }
  }

  // ── 토글(즉시 저장) ──
  function bindToggles() {
    $('sw-enabled').onchange = (e) => saveCfgPatch({ enabled: e.target.checked },
      e.target.checked ? '자동매매 활성화' : '자동매매 비활성화');
    $('sw-dry').onchange = (e) => {
      if (!e.target.checked && !confirm('Dry-run을 끄면 실제 주문이 전송됩니다. 계속할까요?')) { e.target.checked = true; return; }
      saveCfgPatch({ dryRun: e.target.checked }, e.target.checked ? 'dry-run ON' : 'dry-run OFF');
    };
    $('sw-env').onchange = (e) => {
      if (e.target.value === 'real' && !confirm('실전(REAL) 환경으로 전환하면 실제 계좌로 거래합니다. 정말 전환할까요?')) { e.target.value = 'mock'; return; }
      saveCfgPatch({ tradeEnv: e.target.value }, '거래환경: ' + e.target.value);
    };
  }

  // ── 네비게이션(탭 전환 + 모바일 드로어) ──
  const TABS = ['dashboard', 'stocks', 'strategy', 'settings'];
  function switchTab(tab) {
    if (!TABS.includes(tab)) tab = 'dashboard';
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    $('tab-' + tab)?.classList.add('active');
    $('nav-' + tab)?.classList.add('active');
    try { localStorage.setItem('buchangi_tab', tab); } catch (_) {}
    closeDrawer();
  }
  function openDrawer() { $('sidebar')?.classList.add('open'); $('sidebar-overlay')?.classList.add('show'); }
  function closeDrawer() { $('sidebar')?.classList.remove('open'); $('sidebar-overlay')?.classList.remove('show'); }

  // ── 초기화 ──
  function init() {
    loadConnUI();
    bindToggles();
    // 사이드바 탭 + 드로어
    document.querySelectorAll('.nav-item[data-tab]').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
    $('nav-toggle').onclick = () => ($('sidebar').classList.contains('open') ? closeDrawer() : openDrawer());
    $('sidebar-overlay').onclick = closeDrawer;
    switchTab(localStorage.getItem('buchangi_tab') || 'dashboard');
    $('kill-btn').onclick = toggleKill;
    $('run-btn').onclick = runOnce;
    $('refresh-btn').onclick = refresh;
    $('resetday-btn').onclick = resetDay;
    $('wl-add').onclick = addWatch;
    $('rec-run').onclick = runRecommend;
    $('rec-save').onclick = saveRecSettings;
    $('bt-run').onclick = runBacktest;
    $('strategy-save').onclick = saveStrategy;
    // 투자성향 프리셋 + 미저장 편집 보호 + 용어 툴팁
    document.querySelectorAll('.btn.preset[data-preset]').forEach(b => b.onclick = () => applyPreset(b.dataset.preset));
    $('tab-strategy').addEventListener('input', () => { strategyDirty = true; });
    injectHelp();
    $('kis-save').onclick = saveKis;
    $('conn-save').onclick = saveConn;
    $('log-refresh').onclick = async () => {
      try { renderLog((await Api.logs()).logs.slice(-80)); } catch (e) { toast(e.message, 'error'); }
    };

    refresh();
    const sec = parseInt(cfgVals.REFRESH_SEC || 30, 10);
    if (sec > 0) timer = setInterval(refresh, sec * 1000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
