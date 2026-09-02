# Step 2: recommend-route — 추천 엔드포인트 (TR-010)

이번 런에서 가장 무거운 step이다. 서명 검증·화이트리스트·재요청·오탐 방지가 한 라우트에서 만난다.

## 읽어야 할 파일

- `/docs/API_SPEC.md` — **`POST /api/recommend` 절 전문이 이 step의 계약이다.** 특히 서명 검증·재요청·`IRRELEVANT_MOOD` 문단. 에러 응답 규약과 문서 끝의 "무엇을 보장하고 무엇을 보장하지 못하는가" 표도 읽어라
- `/docs/PRD.md` — **US-003(기분으로 다음 책 고르기)** 와 그 AC, FR-006 · FR-009 · FR-010 · FR-011, 5번 Edge Cases
- `/docs/TRD.md` — 3번 표의 TR-010·TR-015 행, **6.5 보안(프롬프트 인젝션)**, 6.4 관측성
- `/docs/ADR.md` — **ADR-006(증명 동반)** · ADR-002 · ADR-005 · ADR-003(무상태)
- `/docs/ARCHITECTURE.md` — **데이터 흐름 2(추천 생성)의 시퀀스 다이어그램이 구현 순서다**
- `src/app/api/mood/questions/route.ts` — **step 1의 산출물. 서명 검증 처리와 에러 응답을 여기에 맞춘다**
- `src/services/anthropic.ts` — `generateRecommendations`와 `correction` 인터페이스 (step 0)
- `src/lib/proof.ts` — `verifyProof` · `filterVerified`
- `src/lib/schemas.ts` — `recommendRequestSchema` · `recommendResponseSchema` · `recommendBookSchema` · `recommendationSchema`
- `src/lib/analytics.ts` — `mood_submitted` · `recommend_viewed`의 필수 속성

## 작업

`src/app/api/recommend/route.ts`를 만든다.

### 순서가 곧 설계다

1. `SERVICE_ENABLED` 확인 → 2. 본문 파싱·`recommendRequestSchema` → 3. **`proof` 검증(`filterVerified`)** → 4. 통과 0권이면 400 `UNVERIFIED_BOOKS` → 5. `generateRecommendations` → 6. **`bookId` 화이트리스트 검증** → 7. 위반 시 **위반 ID를 명시한 1회 재요청** → 8. 그래도 위반이면 502 `RECOMMENDATION_VALIDATION_FAILED` → 9. `recommendResponseSchema` 검증 → 10. 200

**3번이 5번보다 먼저다.** 검증을 통과한 책이 0권이면 모델을 부르지 않는다 — 위조된 목록으로 45원짜리 호출을 하지 않는다.

### 반드시 지킬 규칙

1. **서명 검증이 화이트리스트보다 먼저다.** 화이트리스트는 **모델 출력이 입력과 일치하는지**만 본다. 입력 자체가 진짜인지는 서명만 답할 수 있다 (ADR-006). 둘 다 있어야 하고 순서가 있다.
2. **검증 실패는 그 책만 버린다.** 요청 전체를 실패시키지 마라. 남은 책이 0권일 때만 400 `UNVERIFIED_BOOKS`다.
3. **재요청은 같은 프롬프트를 반복하지 않는다.** step 0이 열어 둔 `correction`(위반한 `bookId` 목록)을 넘겨 허용 목록을 다시 제시한다. **1회만** 재요청한다. 동일 입력을 그대로 다시 보내면 같은 실패를 반복한다.
4. **`IRRELEVANT_MOOD`의 판정 주체는 모델이다.** 서버가 키워드로 판정하지 마라. `relevant: false`면 422다.
5. **그러나 "2회 연속이면 무시하고 진행한다"는 이 서버가 혼자 알 수 없다.** 무상태(ADR-003)라 세션별 카운터를 서버에 둘 수 없고, `recommendRequestSchema`에는 그 횟수를 담는 필드가 **없다**. 이것은 계약의 공백이다:
   - **스키마를 임의로 넓히지 마라.** `lib/schemas.ts`도 `/docs/API_SPEC.md`도 고치지 마라.
   - 서버는 매 요청 독립적으로 판정하고 `relevant: false`면 422를 반환한다.
   - **"2회 연속이면 무시"는 클라이언트 책임임을 코드 주석에 남기고, 계약 공백을 `summary`로 보고하라.** 이 공백을 어떻게 메울지(요청 필드 추가 vs 클라이언트 전담)는 문서 결정이지 이 step의 결정이 아니다.
6. **`mood`는 데이터로만 다룬다.** step 0의 규약을 라우트가 깨지 않는지 확인하라 — 라우트에서 `mood`를 가공해 프롬프트에 이어 붙이지 마라 (TRD 6.5).
7. **책이 3권 미만이면 있는 만큼만 반환하고 `shortfall: true`.** 3권을 채우려고 목록 밖 책을 넣지 마라.
8. **`recommendations`의 모든 `bookId`는 검증 통과 목록의 `isbn13` 집합에 속한다.** 이 검증을 통과하지 못한 응답은 사용자에게 도달하지 않는다 (FR-009).
9. **타임아웃은 504.** 30s다. `lib/budget.ts`를 고치지 마라(step 1과 같은 이유).
10. **관측성**: `mood_submitted`(`input_mode`·`retry_index`)와 `recommend_viewed`(토큰 포함)를 남긴다. **실패 분기의 `usage`도 합산한다.** 재요청이 일어나면 두 호출의 토큰을 모두 세라 — 세션당 비용 가드레일이 실제보다 낮게 나오면 안 된다. `logEvent`는 try/catch로 감싼다.
11. **`runtime = "nodejs"`** (`node:crypto`).
12. **에러 응답에 `requestId`를 담는다.** 모델 문장·내부 에러 원문은 넣지 마라.

### 인터페이스

```ts
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request): Promise<Response>;
```

### 테스트 (먼저 작성한다)

`src/app/api/recommend/route.test.ts`. `services/`는 모킹하고 **`lib/`은 진짜를 쓴다**(특히 `proof`).

- 정상 → 200, 추천 3권, 모든 `bookId`가 요청 목록 안
- **위조된 서명의 책은 버려지고 나머지로 진행한다** (ADR-006 회귀 — 삭제하지 마라)
- **만료된 서명도 같다**
- **전부 위조 → 400 `UNVERIFIED_BOOKS`이고 모델을 부르지 않는다** (회귀 — 삭제하지 마라)
- **모델이 목록 밖 `bookId`를 반환 → 재요청이 일어나고, 재요청 프롬프트에 위반 ID가 들어간다** (같은 프롬프트 반복 금지 회귀)
- **재요청도 목록 밖 → 502 `RECOMMENDATION_VALIDATION_FAILED`** (목록 밖 책이 화면에 도달하지 않는다 — 삭제하지 마라)
- **버려진(서명 실패) 책의 `isbn13`을 모델이 반환하면 그것도 목록 밖이다** — 화이트리스트는 **검증 통과 목록** 기준이다
- `relevant: false` → 422 `IRRELEVANT_MOOD`
- 검증 통과 책 2권 → 추천 2권 + `shortfall: true`
- `mood`가 1자 → 400 / 501자 → 400
- `books` 51개 → 400
- 타임아웃 → 504
- `SERVICE_ENABLED=false` → 503, 모델을 부르지 않는다
- **재요청이 일어난 경우 두 호출의 토큰이 모두 집계된다**
- 에러 응답 본문에 `requestId`가 있다
- 테스트가 실제 Anthropic을 치지 않는다

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run audit
```

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 서명 검증이 모델 호출보다 **먼저** 일어나는가?
   - 화이트리스트 기준이 **검증 통과 목록**인가? (원본 요청 목록이 아니다)
   - 재요청이 정확히 1회이고 위반 ID를 명시하는가?
   - 목록 밖 책이 응답에 도달할 수 있는 경로가 하나도 없는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/app-core/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(계약 공백에 대한 판단과 보고를 반드시 포함하라)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** 실행기가 기록한다.
- **서명 검증 없이 화이트리스트만 하지 마라.** 이유: 이 프로젝트에서 가장 심각한 결함 유형이다 (ADR-006).
- **재요청을 2회 이상 하지 마라.** 이유: API_SPEC이 1회로 정했다. 실패는 502로 끊는다.
- **3권을 채우려고 목록 밖 책을 넣지 마라.** 이유: FR-009 위반이고 사용자가 갖고 있지 않은 책을 추천하게 된다.
- **`mood`를 키워드로 판정하지 마라.** 이유: 판정 주체는 모델이다 (API_SPEC).
- **`recommendRequestSchema`를 넓히지 마라.** 이유: API 계약은 `/docs/API_SPEC.md`가 단일 출처이고, 문서 갱신이 먼저다 (CLAUDE.md CRITICAL).
- **`src/lib/`·`src/services/`를 수정하지 마라.** 결함은 `summary`로 보고하라.
- **`src/components/`를 만들지 마라.** 이유: UI는 step 3~4다.
- **실제 Anthropic API를 호출하지 마라.**
- **새 npm 의존성을 추가하지 마라.**
- **`harness/` · `docs/` · `scripts/` · `.claude/` · 루트의 `*.ts`(`vitest.config.ts` 포함) · `.env*` 를 고치지 마라.** 이유: `main_owned_paths`다.
- **기존 테스트를 깨뜨리지 마라.**
