# 롤백 스냅샷

이 시점은 **검증된 안정 버전**이다. 이후 작업 중 문제가 생기면 여기로 되돌린다.

## 🟢 최신 안정: Tier 1 고도화 v2 (2026-06-10)
- git 태그: `rollback-tier1-v2`
- tar: `/workspaces/claude-box/snapshots/buchangi-20260610-tier1-v2.tar.gz`
- **워커 안정 버전 ID**: `f600e543-233f-4b6c-b771-685562550bbe`
- 추가된 것: ATR/트레일링 스탑 · 돌파 품질확인(거래량/변동폭) · 경량 백테스터(`/api/backtest`) · 성과지표(`/api/status` stats). 모두 기본 OFF, dry-run 검증됨.
- ⚠️ 쓰지 말 것: `11d36ee3`(Gemini 키 노출 버그).

## 이전 안정: 전략추천 스캐너 v1
- git 태그: `rollback-recommend-v1` / tar: `buchangi-20260610-recommend-v1.tar.gz` / 워커 `050a5452`

---
### v1에 포함된 것(참고)

## 이 버전에 포함된 것
- `/api/recommend` 정량 스크리너(시장/추세/셋업 3단계) + 워치리스트 원클릭 추가
- KIS 호출 **throttle + rate-limit 재시도**(모의 700ms·실전 170ms 간격, 단일 게이트 직렬화)
- Gemini 정성 2차 검토는 **브라우저측**(Google 서버 지역차단 우회), 모델 자동 폴백(2.5-flash 등)
- KIS 자격증명 입력 UX: 포커스 가드(자동 새로고침이 입력 중 값 안 지움) + 마스킹 왕복 제거
- 서버 cfg에서 Gemini 키 완전 제거(노출 차단)

## 코드 롤백
```bash
cd /workspaces/claude-box/buchangi-Agent
# 방법 A) git
git stash            # 작업 중 변경 보관(선택)
git checkout rollback-recommend-v1 -- .   # 파일만 이 시점으로
# 또는 완전 리셋: git reset --hard rollback-recommend-v1

# 방법 B) tar (git이 꼬였을 때)
tar -xzf /workspaces/claude-box/snapshots/buchangi-20260610-recommend-v1.tar.gz \
    -C /workspaces/claude-box/buchangi-Agent
```

## 배포 롤백 (Cloudflare)
- **워커 안정 버전 ID**: `050a5452-42ea-4823-8ad9-75ec39ebd80f`
  ```bash
  cd /workspaces/claude-box/buchangi-Agent
  set -a; . /workspaces/claude-box/.cf-credentials; set +a
  npx wrangler@4 deployments list           # 이력 확인
  npx wrangler@4 rollback 050a5452-42ea-4823-8ad9-75ec39ebd80f
  # 또는 코드 롤백 후 재배포: npx wrangler@4 deploy
  ```
  ⚠️ 쓰지 말 것: `11d36ee3`(Gemini 키 평문 노출 버그 있던 중간 버전).
- **대시보드(Pages)**: `npx wrangler@4 pages deploy dist --project-name=buchangi` 로 재배포, 또는
  Cloudflare 대시보드 Pages > buchangi > Deployments 에서 이전 배포로 Rollback.

## 복원 후 확인
```bash
curl https://buchangi.1988nam.workers.dev/health
# /api/recommend 가 ok:true 로 정량 결과 반환하는지(관리 토큰 필요)
```
