# 부챙이 (Buchangi) — 국내주식 자동매매 에이전트 📈

> 흰챙이 가족 챙이 패밀리의 4번째 멤버. **투챙이(투자 분석)**가 깔아둔 KIS 연동·3단계 필터를
> 이어받아, 사람이 버튼을 누르지 않아도 **스스로 매수/매도**한다.
>
> 🛡️ **모의투자(VTS) 기본 · dry-run 기본 ON.** 검증한 뒤에만 실거래로 전환하세요.

---

## ⚠️ 먼저 읽을 것 — 자동매매는 실제 돈입니다

- 손익에 대한 **모든 책임은 운용자(본인)** 에게 있습니다. 이 도구는 보조 수단입니다.
- 기본값은 **모의투자(mock) + dry-run(주문 안 보냄)**. 처음엔 이 상태로 며칠 로그만 보세요.
- 실거래 순서: ① 모의에서 동작 확인 → ② dry-run OFF로 모의 실제 주문 확인 → ③ 마지막에 `real` 전환.
- 안전장치: kill-switch, 일일 손실/주문 한도, 화이트리스트 전용, 종목당 비중·현금 비중 하한.
- 전략 상세는 [docs/strategy.md](docs/strategy.md) 참고.

---

## 🏗️ 구조

```
buchangi-Agent
├── worker/buchangi-worker.js  ← 실행 엔진: Cron으로 깨어나 KIS로 자동매매 + 대시보드 API
├── wrangler.toml               ← Worker 설정(Cron + KV 바인딩)
├── index.html                  ← 관제 대시보드 UI
├── js/
│   ├── config.example.js       ← 워커주소/관리토큰 기본값(예시)
│   ├── api.js                  ← 대시보드 ↔ 워커 통신
│   └── main.js                 ← 대시보드 로직
├── style.css
└── docs/strategy.md            ← 전략·리스크 설계
```

- **엔진**은 브라우저와 무관하게 도는 Cloudflare Worker(+Cron). 브라우저를 꺼도 매매가 진행됩니다.
- **대시보드**는 단순 관제판: 설정 변경, 포지션·로그 확인, kill-switch, 수동 실행.
- **상태/설정/로그**는 Cloudflare KV에 저장.

---

## 🚀 배포 (약 10분)

### 0) 사전 준비
- [한국투자증권 KIS Developers](https://apiportal.koreainvestment.com)에서 **모의투자** appkey/appsecret 발급 + 모의 계좌(10자리).
- Cloudflare 계정(무료). `npm i -g wrangler` 후 `wrangler login`.

### 1) KV 네임스페이스 생성
```bash
cd buchangi-Agent
wrangler kv namespace create BUCHANGI_KV
```
출력된 `id = "..."` 를 [wrangler.toml](wrangler.toml)의 `id` 자리에 붙여넣습니다.

### 2) 관리 토큰 설정 (대시보드 ↔ 워커 인증)
```bash
wrangler secret put ADMIN_TOKEN
# 아무 강한 무작위 문자열 입력 (대시보드에서 동일 값 사용)
```

### 3) 워커 배포
```bash
npm install
wrangler deploy
# 출력된 주소 예: https://buchangi.<계정>.workers.dev
```

### 4) 대시보드 열기
- 로컬: `index.html`을 그냥 브라우저로 열어도 됩니다(파일 직접 또는 `npx serve .`).
- 또는 Cloudflare Pages/GitHub Pages에 `index.html`,`js/`,`style.css`를 올려 호스팅.
- 대시보드 **🔌 연결 설정**에 워커 주소 + 관리 토큰 입력 → 저장.
- 다른 기기 추가: 설정 탭 **📲 설정 복사/붙여넣기**에서 코드를 복사해, 새 기기의 같은 칸에 붙여넣고 적용하면 연결 설정(+Gemini 키)이 그대로 옮겨집니다.

### 5) KIS 설정 & 워치리스트
- **🔑 KIS 연동**: 모의 appkey/secret/계좌(10자리) 입력. (모의 시세 제한 회피용 실전 데이터 키는 선택)
- **⭐ 워치리스트**: 거래할 종목코드 6자리 등록(예: `005930` 삼성전자).
- **🎯 전략 파라미터**: 1회 매수액·돌파 k·익절/손절 등 조정.

### 6) 켜기 (단계적)
1. 처음엔 **dry-run ON + enabled ON** → 로그에 "샀을 것/팔았을 것"만 쌓이는지 관찰.
2. 모의 실제 체결을 보려면 **dry-run OFF** (여전히 mock).
3. 충분히 검증되면 **거래환경 → 실전(REAL)**. (각 전환마다 확인창)

> Cron은 평일 09:00~15:20 KST에 5분 간격으로 자동 실행됩니다. **지금 실행(수동)** 버튼으로 즉시 1회 테스트도 가능.

---

## 🎯 전략 한눈에

**3단계 게이트(GO/NO-GO) + 표준 전략(진입/청산)** — 자세한 건 [docs/strategy.md](docs/strategy.md).

- **게이트①** 시장 추세: 코스피가 MA 위일 때만 신규 매수
- **게이트②** 화이트리스트 전용 + 현금 비중 하한 + 종목당 비중 한도
- **게이트③** kill-switch·거래시간·일일 손실/주문 한도
- **진입**: 변동성 돌파(`시가 + k·전일변동폭` 돌파) ∧ 추세(MA 위)
- **청산**: 익절 +X% / 손절 −Y% / (옵션) 장마감 전 당일분 청산

---

## 🧪 로컬 개발

```bash
wrangler dev          # 로컬에서 워커 실행 (fetch API 테스트)
wrangler tail         # 배포된 워커 실시간 로그
```

수동 사이클 호출(인증 필요):
```bash
curl -X POST https://buchangi.<계정>.workers.dev/api/run \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

---

## 📌 알려진 한계 (V1)

- KIS **모의(VTS)는 시세·지수 조회가 제한**될 수 있음 → 실전 데이터 키를 넣거나, 없으면 해당 게이트/종목을 안전하게 스킵.
- **공휴일 미반영**(주말만 거름) — 휴장일엔 주문이 거부될 뿐 손해는 없음.
- 체결 추적/미체결 취소, Google Sheets 매매일지 연동, 백테스트, 알림은 **이후 확장** 예정(docs/strategy.md §7).
- 시장가 주문 기본 — 슬리피지 가능. 지정가 옵션은 추후.

---

*투챙이의 KIS 프록시·3단계 필터·매매일지 개념을 계승. 챙이 가족 자산 로드맵의 실행 엔진.*
