# 롤백 스냅샷

이 시점은 **검증된 안정 버전**이다. 이후 작업 중 문제가 생기면 여기로 되돌린다.

## 🟢 최신 안정: 투자성향 프리셋 + 용어 툴팁 v5 (2026-06-10)
- git 태그: `rollback-presets-v5`
- tar: `/workspaces/claude-box/snapshots/buchangi-20260610-presets-v5.tar.gz`
- **워커 안정 버전 ID**: `55ee826f-...` (불변 — Pages 대시보드만 변경)
- 추가: 전략 카드 상단 🛡️안전/⚖️보통/🔥공격 프리셋(폼만 채움, 저장 안 함, strategyDirty 보호) + 전략 파라미터 30필드 ⓘ 용어 툴팁.
- 적대적 리뷰 fix-then-ship 4건 수정: 저장 실패 시 미저장값 소실(성공 시에만 dirty 해제) · ⓘ 탭 시 체크박스 토글 차단 · 안전 프리셋 손절2% 실제 작동(useAtrStop off) · ⓘ 위치(switch 인라인/숫자 우상단).

## 이전 안정: UI 사이드바 탭 구조 v4 (2026-06-10)
- git 태그: `rollback-ui-tabs-v4`
- tar: `/workspaces/claude-box/snapshots/buchangi-20260610-ui-tabs-v4.tar.gz`
- **워커 안정 버전 ID**: `55ee826f-911c-4ba1-b3e1-329e110e196b` (v3와 동일 — 이번 변경은 Pages 대시보드만)
- 변경: 단일 페이지 9카드 → 영구 상태헤더 + 좌측 사이드바 4탭(대시보드/워치리스트·추천/전략·백테스트/설정). 투챙이/가챙이식 `switchTab()`. Tier1/2 고급옵션은 `<details>` 접기, 위험동작(실전전환/dry-off)은 danger-zone 격리, 모바일 오프캔버스 드로어. **기존 main.js 로직/ID/이벤트 100% 보존**(DOM 위치만 이동).
- 롤백 시 주의: UI만 되돌리려면 index.html/style.css/js/main.js + dist/ 만 복원(워커 불변).

## 이전 안정: Tier 2 고도화 v3 (2026-06-10)
- git 태그: `rollback-tier2-v3`
- tar: `/workspaces/claude-box/snapshots/buchangi-20260610-tier2-v3.tar.gz`
- **워커 안정 버전 ID**: `55ee826f-911c-4ba1-b3e1-329e110e196b`
- 추가: 분할매수/분할익절 · regime 적응형 사이징 · ADX 추세강도 필터(텔레그램 제외). 모두 기본 OFF.
- 수정(리뷰 발견): 청산 한도 미적용(손절 무한확대 방지) · order() 인자버그 · 당일 재진입 금지 · stale prune · 동시실행 락 · 잔고 페이지네이션 · 백테스트 손절 우선.
- 검증: 단위테스트 24/24, 적대적 리뷰 2라운드(ship). dry-run/백테스트/잔고 라이브 스모크 통과.

## 이전 안정: Tier 1 고도화 v2 (2026-06-10)
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
