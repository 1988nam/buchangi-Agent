/**
 * 부챙이 대시보드 ↔ 워커 통신 모듈
 * 연결 설정(워커 주소/관리 토큰)은 localStorage에 저장.
 */
const Api = (() => {
  const LS = {
    url: 'buchangi_worker_url',
    token: 'buchangi_admin_token',
    geminiKey: 'buchangi_gemini_key',     // 브라우저에만 보관(워커로 안 보냄)
    geminiModel: 'buchangi_gemini_model', // 마지막으로 작동한 모델 캐시
  };

  function getConn() {
    const cfg = window.BUCHANGI_CONFIG || {};
    return {
      url: (localStorage.getItem(LS.url) || cfg.WORKER_URL || '').trim().replace(/\/+$/, ''),
      token: (localStorage.getItem(LS.token) || cfg.ADMIN_TOKEN || '').trim(),
    };
  }
  function saveConn(url, token) {
    localStorage.setItem(LS.url, (url || '').trim().replace(/\/+$/, ''));
    localStorage.setItem(LS.token, (token || '').trim());
  }
  function isConfigured() {
    const c = getConn();
    return !!(c.url && c.token);
  }

  async function call(path, { method = 'GET', body } = {}) {
    const { url, token } = getConn();
    if (!url || !token) throw new Error('연결 미설정: 워커 주소와 관리 토큰을 입력하세요.');
    const res = await fetch(url + path, {
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await res.json(); } catch (_) { data = { error: 'HTTP ' + res.status }; }
    if (!res.ok) throw new Error(data.error || `요청 실패(${res.status})`);
    return data;
  }

  // Gemini 키/모델은 브라우저 localStorage에만 둔다(워커 출구 IP가 Gemini 지역차단되기 때문).
  const getGeminiKey = () => (localStorage.getItem(LS.geminiKey) || '').trim();
  const saveGeminiKey = (k) => localStorage.setItem(LS.geminiKey, (k || '').trim());
  const hasGeminiKey = () => !!getGeminiKey();
  const getGeminiModel = () => (localStorage.getItem(LS.geminiModel) || '').trim();
  const saveGeminiModel = (m) => localStorage.setItem(LS.geminiModel, (m || '').trim());

  return {
    getConn, saveConn, isConfigured,
    getGeminiKey, saveGeminiKey, hasGeminiKey, getGeminiModel, saveGeminiModel,
    status: (withBalance) => call('/api/status' + (withBalance ? '?balance=1' : '')),
    logs: () => call('/api/logs'),
    saveConfig: (cfg) => call('/api/config', { method: 'POST', body: cfg }),
    killswitch: (on) => call('/api/killswitch', { method: 'POST', body: { on } }),
    runOnce: () => call('/api/run', { method: 'POST' }),
    resetDay: () => call('/api/reset-day', { method: 'POST' }),
    recommend: () => call('/api/recommend'),
  };
})();
