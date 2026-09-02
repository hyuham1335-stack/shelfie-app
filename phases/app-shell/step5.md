# Step 5: page-shell — 조립과 배선 (TR-011)

네 번의 런이 만든 조각(`services/` · `app/api/` · `lib/` · `components/`)이 **처음으로 한 화면에서 만난다.** 이 step은 새 기능을 만들지 않는다 — 이미 있는 것을 잇는다.

## 읽어야 할 파일

- `/docs/ARCHITECTURE.md` — **"상태 관리" 절 전문(상태도 포함)** · 데이터 흐름 1·2·3 · 레이어 의존 관계
- `/docs/API_SPEC.md` — **전문.** 특히 `POST /api/books/resolve`(후보에 `proof`가 붙는 이유)와 에러 응답 규약
- `/docs/PRD.md` — 5번 **Edge Cases 표 전체** · US-001~US-004의 AC · 7번 이벤트 표
- `/docs/ADR.md` — **ADR-003(무상태)** · **ADR-006(`proof`)** · ADR-002 · ADR-005
- `/docs/UI_GUIDE.md` — 에러 배너 · 안내 문구
- **step 1~4의 산출물 전부** — `src/lib/session.ts` · `src/lib/api-client.ts` · `src/components/upload/` · `src/components/mood/` · `src/components/recommend/`
- `src/components/booklist/BookList.tsx` — **props 시그니처.** 콜백 4개(`onResolve` · `onSelectCandidate` · `onRetryLookup` · `onRetryPhoto`)와 `photoCount`를 네가 채운다
- `src/app/layout.tsx` — metadata는 여기 있다

## 작업

`src/app/page.tsx`를 `"use client"`로 다시 쓴다. `useReducer(sessionReducer, ...)` **하나**로 세션 전체를 관리한다.

### 배선

- `sessionId`는 마운트 시 `crypto.randomUUID()`로 **한 번만** 만든다. 리듀서가 만들지 않는다(step 1이 순수하다)
- 상태별로 화면을 고른다. 전이는 전부 `dispatch`로만 일어난다 — `page.tsx`가 상태를 직접 계산하지 마라
- `BookList`에 **`photoCount`를 넘긴다.** step 3의 `onAnalyze(dataUris, photoCount)`에서 받아 상태에 넣어 둔 값이다. `analyze` 응답에는 없다
- `reviewing` 이후 상태에서 `beforeunload` 경고를 건다 (ARCHITECTURE: 의도된 소실과 사고로 인한 소실은 다르다)
- 선택한 원본 파일은 `error` 상태에서도 유지한다 — 재시도가 재업로드를 요구하면 안 된다

### `ambiguous` 후보 승격 — 이 런의 핵심

미확인 책의 `candidates`(`AladinCandidate`)에는 **`proof`가 없다.** 사용자가 후보를 골라도 그대로 목록에 넣으면 `recommend`·`questions`에서 그 책만 조용히 폐기된다 (ADR-006).

`onSelectCandidate(book, candidate)` 처리:

1. `resolveBook(sessionId, <고른 후보를 특정할 검색어>)`를 호출한다
2. 응답 후보 중 **`isbn13`이 일치하는 항목**을 찾는다
3. 찾으면 그 항목(= `proof`를 가진 `ResolvedCandidate`)을 `origin: "resolved"`로 목록에 합류시킨다
4. **못 찾으면 승격을 실패로 처리하고** 재검색 경로(`onResolve`)로 되돌린다

**응답의 첫 번째 후보로 대신하지 마라.** `resolve`는 검색어로 알라딘 순위 5건을 그대로 돌려주므로 사용자가 고른 책이 없을 수 있다. 다른 책을 사용자가 고른 것처럼 목록에 넣는 것은 이 프로젝트에서 가장 심각한 결함(없는 책을 확인된 책으로 표시)과 같은 종류다.

승격에 성공하면 `book_resolved` 이벤트를 보낸다.

### 에러 분기

`ApiResult`의 `code`로 가른다:

| code | 처리 |
|---|---|
| `EMPTY_SHELF` | `emptyShelf` — 다시 찍기 안내 |
| `UNVERIFIED_BOOKS` | **`idle`로 되돌리고** "사진을 다시 분석해 주세요". `proof`가 만료(2시간)됐다는 뜻이다 |
| `IRRELEVANT_MOOD` | `moodInput`으로 되돌리고 예시 문장을 강조. 연속 횟수는 화면이 센다 |
| `INTERNAL_ERROR` · `UPSTREAM_UNAVAILABLE` · `TIMEOUT` | `error` + `ErrorBanner` + 재시도. 사용자 입력 상태는 유지한다 |
| `SERVICE_DISABLED` | 점검 안내. **재시도 버튼을 숨긴다** |

**`proof` 문자열을 파싱하거나 만료를 예측하지 마라.** 만료는 서버의 `UNVERIFIED_BOOKS`로만 안다 — 클라이언트가 서명을 해석하기 시작하면 ADR-006이 막으려던 신뢰 경계가 무너진다.

### 이벤트

`recommend_accepted` · `book_resolved`만 보낸다.
**`recommend_viewed`를 보내지 마라** — `app/api/recommend/route.ts`가 정본이고, 둘 다 보내면 North Star 분모가 이중 계상된다.

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
2. 확인한다:
   - `grep -rn "services/\|lib/proof\|lib/prompts" src/app/page.tsx` 가 0건인가?
   - 승격 경로가 `isbn13` 일치로만 합류시키는가? 불일치 시 목록에 넣지 않는가?
   - `grep -n "recommend_viewed" src/app/page.tsx` 가 0건인가?
   - `photoCount`가 `BookList`에 실제로 전달되는가?
   - ARCHITECTURE 상태도의 전이가 화면에서 전부 도달 가능한가?
   - PRD 5번 Edge Cases 표의 각 행에 대응하는 분기가 있는가?
3. 결과에 따라 `phases/app-shell/index.json`의 step 5를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 산출물 요약과 **남은 결함·미해소 보고**를 담아라
   - 실패 → `"status": "error"` + `"error_message"` / 개입 필요 → `"status": "blocked"` + `"blocked_reason"`

## 금지사항

- **`proof` 없는 책을 목록에 넣지 마라.** 이유: ADR-006. 승격에 실패하면 실패로 남긴다
- **승격 실패를 첫 번째 후보로 때우지 마라.** 이유: 사용자가 고르지 않은 책을 고른 것처럼 만든다
- **`proof`를 파싱하거나 만료를 클라이언트에서 판정하지 마라.** 이유: 신뢰 경계가 서버에 있다
- **`recommend_viewed`를 보내지 마라.** 이유: 라우트가 정본이다
- **`localStorage`·`sessionStorage`·쿠키에 세션을 저장하지 마라.** 이유: ADR-003. 새로고침 시 소실은 의도된 결과다
- **전역 상태 라이브러리를 도입하지 마라.** 이유: ARCHITECTURE가 명시적으로 배제했다
- **`src/lib/` · `src/components/` · `src/app/api/`를 고치지 마라.** 이유: step 0~4와 런 #1~#4가 확정한 계약이다. 결함을 찾으면 **고치지 말고 `summary`로 보고하라** — 이 step은 조립이다
- **`services/*`를 import하지 마라.** 이유: 클라이언트 번들에 API 키가 새는 경로가 열린다
- **새 화면·새 기능을 만들지 마라.** 이유: 이 step의 범위는 배선이다
- **`docs/**` · 루트 `*.ts` · `.env*`를 고치지 마라.** 이유: `main_owned_paths`다
- **`index.json`의 실행기 소유 필드와 `RUNNING` 파일을 건드리지 마라**
- 새 npm 의존성을 추가하지 마라
- 기존 테스트를 깨뜨리지 마라
