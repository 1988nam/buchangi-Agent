// Retired service: no imports, bindings, outbound requests, or scheduled work.
export default {
  async fetch(request) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    return new Response(JSON.stringify({ status: 'retired', enabled: false, geminiEnabled: false, message: '부챙이는 운영이 종료되었습니다.' }), { status: 410, headers });
  },
  async scheduled() { /* Explicit no-op, including any already queued cron event. */ },
};
