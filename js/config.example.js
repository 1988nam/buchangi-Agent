/**
 * 부챙이 대시보드 - 기본 설정 예시
 * 실제 값은 대시보드 UI(⚙️ 연결)에서 입력하면 localStorage에 저장됩니다.
 * 이 파일은 기본값/참고용입니다. (js/config.js 로 복사해 쓰거나 그대로 두어도 됩니다)
 */
const BUCHANGI_CONFIG = {
  // 배포한 Cloudflare Worker 주소 (예: https://buchangi.<계정>.workers.dev)
  WORKER_URL: '',

  // 워커 관리 토큰 (wrangler secret put ADMIN_TOKEN 으로 설정한 값과 동일해야 함)
  // ⚠️ 공개 리포에 실제 토큰을 커밋하지 마세요. UI에서 입력 권장.
  ADMIN_TOKEN: '',

  // 대시보드 자동 새로고침 주기(초)
  REFRESH_SEC: 30,
};
