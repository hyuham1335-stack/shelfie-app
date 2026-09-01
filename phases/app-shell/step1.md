# Step 1: session-machine — 세션 상태 리듀서 (순수)

화면 전이 규칙은 React와 무관한 규칙이다. React 안에 두면 렌더링을 통해서만 검사할 수 있으므로, `lib/session.ts`에 **순수 함수로** 떼어 낸다 (ARCHITECTURE "상태 관리").

## 읽어야 할 파일

- `/docs/ARCHITECTURE.md` — **"상태 관리" 절 전문과 상태도(mermaid).** 이 step의 사양이다
- `/docs/PRD.md` — 5번 Edge Cases 표 · FR-010(재추천 상한) · US-001~US-004
- `/docs/API_SPEC.md` — 각 엔드포인트의 실패 응답과 에러 코드 표
- `/docs/ADR.md` — **ADR-003(무상태)** · ADR-006(`proof`)
- `src/types/api.ts` · `src/types/book.ts` — 기존 타입. **다시 만들지 마라**
- `src/lib/schemas.ts` — `bookReferenceSchema`·`recommendBookSchema`가 요청 경계에서 무엇을 요구하는지 확인하라
- step 0의 `src/lib/env.ts` — 상한 상수

## 작업

`src/lib/session.ts` 하나를 만든다. **순수 함수만 있다** — `fetch`·`useState`·`useEffect`·React import가 하나도 없다.

### 상태

ARCHITECTURE 상태도의 10개를 판별 유니온으로 만든다:

`idle` · `analyzing` · `reviewing` · `unidentifiedOnly` · `emptyShelf` · `moodInput` · `guidedQuestions` · `recommending` · `result` · `error`

**상태도에 없는 전이는 만들지 마라.** 리듀서는 정의되지 않은 (상태, 액션) 조합에서 **상태를 바꾸지 않고 그대로 돌려준다** — 던지지 않는다. 사용자가 느린 네트워크에서 버튼을 두 번 누르는 것은 예외 상황이 아니다.

### 세션 데이터

- `sessionId` — 밖에서 주입받는다. **리듀서가 `crypto.randomUUID()`를 부르지 마라** (순수하지 않다)
- `photoCount` — 업로드 장수. `analyze` 응답에 없으므로 상태가 들고 있어야 한다. `BookList`의 부분 실패 배너가 이것을 분모로 쓴다
- `books: ShelfBook[]` — 아래 참조
- `unidentified` · `overflowCount` · `unidentifiedOverflowCount` · `failedPhotoIndexes`
- `mood` · `inputMode`(`free_text` | `guided`) · `questions` · `recommendations` · `shortfall`
- `recommendCount` — 재추천 횟수. `MAX_RECOMMEND_ATTEMPTS`(FR-010, 5회)에 걸리면 더 못 누른다
- `errorCode` · `requestId` — `error` 상태에서 화면이 읽는다

### `ShelfBook` — 승격된 책을 어떻게 담는가

`/api/books/resolve`로 승격된 책은 알라딘 대조와 `proof`를 확인된 책과 **똑같이** 통과했지만 두 가지가 없다: `claudeNote`(Claude 해석이 없다)와 `photoIndex`(사진이 아니라 재검색에서 왔다).

```ts
type ShelfBook =
  | { origin: "photo"; book: IdentifiedBook }
  | { origin: "resolved"; book: ResolvedCandidate };
```

**`photoIndex`를 `0`으로 지어내지 마라.** 없는 출처를 있는 것처럼 적는 것이고, 이 프로젝트가 알라딘 미확인 책을 확인된 것처럼 표시하지 않는 것과 같은 종류의 규율이다. 요청 경계에서 쓰는 `bookReferenceSchema`·`recommendBookSchema`는 `photoIndex`를 요구하지 않으므로 계약상 문제도 없다.

`recommendBookSchema`는 `claudeNote`를 요구한다 — 승격분은 빈 문자열로 채운다(스키마가 허용한다). 화면에서는 **한줄평 블록 자체를 그리지 않는다.** 빈 `ClaudeText`를 그리면 Claude가 아무 말도 안 한 것을 말한 것처럼 만든다.

### 필요한 셀렉터

- `toBookReferences(state)` / `toRecommendBooks(state)` — 요청 경계용 최소 형태로 변환
- `canRecommendAgain(state)` — FR-010 상한 판정
- `hasVerifiedBooks(state)` — 확인 0권이면 추천 단계로 못 간다

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
   - `grep -n "fetch\|useState\|useReducer\|from \"react\"" src/lib/session.ts` 가 0건인가?
   - ARCHITECTURE 상태도의 전이를 **하나도 빠짐없이** 테스트가 덮는가?
   - 정의되지 않은 전이에서 상태가 그대로인가? (던지지 않는가)
3. 결과에 따라 `phases/app-shell/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 **export한 타입·액션 이름과 셀렉터 시그니처**를 담아라. step 5가 그대로 쓴다
   - 실패 → `"status": "error"` + `"error_message"` / 개입 필요 → `"status": "blocked"` + `"blocked_reason"`

## 금지사항

- **`fetch`·React·브라우저 API를 쓰지 마라.** 이유: 이 파일이 순수해야 jsdom 없이 전이 규칙을 검사할 수 있다
- **`crypto.randomUUID()`를 리듀서 안에서 부르지 마라.** 이유: 같은 입력에 같은 출력이 아니게 된다. `sessionId`는 주입받는다
- **`localStorage`·`sessionStorage`·쿠키에 세션을 저장하지 마라.** 이유: 새로고침 시 소실은 ADR-003의 의도된 결과다. 재추천 상한을 저장소로 지키려는 시도는 무상태 전제를 문서 없이 우회하는 것이다
- **`photoIndex`를 지어내지 마라.** 이유: 위 참조
- **`src/lib/`의 다른 파일을 고치지 마라.** 이유: step 0이 확정한 계약이다. 결함을 찾으면 `summary`로 보고하라
- **`src/app/`·`src/components/`를 건드리지 마라.** 이유: step 2~5다
- **전역 상태 라이브러리를 도입하지 마라.** 이유: ARCHITECTURE가 명시적으로 배제했다
- **`index.json`의 실행기 소유 필드와 `RUNNING` 파일을 건드리지 마라**
- 새 npm 의존성을 추가하지 마라
- 기존 테스트를 깨뜨리지 마라
