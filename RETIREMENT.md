# 부챙이 운영 종료

2026-09-13 사용자 요청으로 폐기. Worker fetch는 410, scheduled는 no-op, Cron은 빈 배열입니다. 프런트는 종료 안내이며 connect-src none으로 외부 호출을 금지합니다. 기존 Gemini 함수도 즉시 오류를 반환합니다. KV 데이터와 Git 이력은 보존합니다. 운영 재개 또는 이전 버전 롤백을 하지 마세요.
