# Step 3: booklist-props — 재검색으로 합류한 책이 한 목록에 들어오고, 재조회가 책 단위가 된다

두 건을 닫는다. 둘 다 `app-shell` 런의 조립 step이 보고했고 그 뒤 두 런째 이월됐다.

**① 목록이 갈라져 있다.** `BookListProps.result`가 `AnalyzeResponse`인데 그 안의 `identified`는 `photoIndex`를 요구한다. `/api/books/resolve`로 사용자가 직접 찾아낸 책에는 사진 출처가 없어 그 목록에 들어갈 수 없고, 지금 `src/app/page.tsx`는 **"직접 확인한 책"이라는 별도 섹션을 손으로 렌더해** 우회하고 있다. `photoIndex: 0`을 지어내지 않은 것은 옳은 판단이었다 — 없는 값을 채우면 출처를 위조하는 것이다. 다만 그래서 **사용자는 자기 책장이 두 목록으로 갈라진 화면을 본다.**

**② 재조회가 책 단위가 아니다.** `onRetryLookup?: () => void`가 책 인자를 받지 않아, `lookup_failed` 책 하나의 "다시 시도" 버튼이 `handleRetryPhotos([])` — **사진 전체 재분석**에 배선돼 있다. 알라딘 조회 한 번이 실패했을 뿐인데 모델에 사진을 전부 다시 태운다. 비용 문제이고, 사용자가 기대한 동작도 아니다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `/docs/UI_GUIDE.md` — 디자인 원칙과 **안티패턴 목록 전문**. 특히 "Claude 생성 텍스트 블록"과 색 사용 규칙
- `/docs/ARCHITECTURE.md` — 상태 관리 절(**"없는 값을 지어내지 않는다"** 가 어디서 왔는지) · 디렉토리 구조 · 레이어 의존 방향
- `/docs/API_SPEC.md` — `POST /api/books/resolve` 절(요청은 `sessionId`·`query`·`author?`) · `POST /api/analyze` 응답 스키마
- `/docs/ADR.md` — **ADR-002**(알라딘 사실과 Claude 해석을 같은 시각적 층위에 섞지 않는다) · **ADR-005**(`lookup_failed` ≠ `no_match`) · ADR-006(`proof`)
- `src/components/booklist/BookList.tsx` — 전문
- `src/components/booklist/BookList.test.tsx` — 기존 케이스 전부
- `src/components/booklist/UnidentifiedBookCard.tsx` — 전문. 특히 `showRetry`(`lookup_failed` 전용)와 `showResolve`의 갈림
- `src/components/booklist/UnidentifiedBookCard.test.tsx` — 기존 케이스 전부
- `src/app/page.tsx` — 전문. 특히 `books`/`photoBooks`/`resolvedBooks` 파생, `toAnalyzeView`, `openResolve`, `runResolve`, `handleRetryPhotos`, `BookList` 사용부와 그 아래 "직접 확인한 책" 섹션
- `src/types/book.ts` — `IdentifiedBook` · `ResolvedCandidate` · `UnidentifiedBook`의 차이

## 첨부하지 않은 것 — 직접 읽어라

- **세션 상태 모듈**(`lib/` 아래 `session`의 `.ts`) — `ShelfBook` 타입이 거기 정의돼 있다. 접두부 상한 때문에 첨부하지 못했다. 지금 형태는 이렇다:

  ```ts
  export type ShelfBook =
    | { origin: "photo"; book: IdentifiedBook }
    | { origin: "resolved"; book: ResolvedCandidate };
  ```

  `state.books`가 `ShelfBook[]`이고, `origin`으로 두 출처를 구분한다. **이 타입을 바꾸지 마라** — 다음 step이 같은 파일을 다룬다.
- **페이지 테스트 파일**(`app/` 아래 `page`의 `.test.tsx`) — 이 step이 고쳐야 한다. 첨부 상한 때문에 넣지 못했으니 직접 읽어라.

## 작업

### A. `BookList`가 두 출처를 한 목록으로 받는다

`BookListProps.result: AnalyzeResponse`를 `ShelfBook[]`을 받는 형태로 넓힌다. 나머지 필드(`unidentified` · `overflowCount` · `unidentifiedOverflowCount` · `failedPhotoCount` · `failedPhotoIndexes` · `photoCount`)는 지금 쓰임 그대로 필요하다 — props 모양은 재량이되 **`AnalyzeResponse`를 통째로 받는 지금 형태는 버려라.** 그것이 이 결함의 원인이다.

타입 의존: `ShelfBook`은 세션 상태 모듈에 있다. **`import type`으로만 가져와라.** 타입 전용 import는 컴파일 후 런타임 코드를 남기지 않으므로 `types/` → `lib/` 방향과 같은 취급이고, 컴포넌트가 리듀서·액션 같은 **런타임 값**을 세션 모듈에서 가져오는 것은 금지다 — 그 순간 화면이 상태 전이를 직접 하게 된다(ARCHITECTURE 상태 관리).

렌더 규칙:

- **한 섹션에 두 출처를 함께 세운다.** 헤더의 권수는 합계다
- **출처가 화면에서 사라지면 안 된다.** `resolved` 책은 `claudeNote`가 없고 `photoIndex`도 없다 — 사진에서 온 책과 **같은 정보를 가진 척하지 마라.** 사용자가 직접 확인했다는 사실은 그 책의 신뢰도에 대한 정보이지 숨길 결함이 아니다. 어떻게 드러낼지(작은 라벨·배지 등)는 재량이되 UI_GUIDE의 색 규칙을 따르고, **경고색을 쓰지 마라** — 재검색으로 확인한 책은 문제가 아니다
- **ADR-002를 지켜라.** 알라딘 사실(제목·저자·출판사·쪽수·평점)과 Claude 해석(`claudeNote`)은 같은 시각적 층위에 있으면 안 된다. `resolved` 책에는 `claudeNote`가 아예 없으므로 그 자리를 빈 문자열로 채워 렌더하지 마라 — 없는 것은 없는 것으로 둔다
- `MAX_IDENTIFIED_BOOKS` 초과 안내(`overflowCount`)의 의미가 바뀌지 않게 하라. 그것은 **사진에서 온 책**의 잘림이다

### B. `page.tsx`의 "직접 확인한 책" 섹션을 걷어낸다

A가 끝나면 그 섹션은 중복이다. 섹션과 그 위의 우회 주석을 지우고, `toAnalyzeView`가 `photoBooks`만 넘기던 구조도 함께 정리한다.

**`state.books`를 그대로 넘기면 된다** — 우회하느라 갈라 두었던 `photoBooks`/`resolvedBooks` 파생이 더 필요한지 다시 보라. 필요 없어졌으면 지워라(쓰지 않는 파생을 남기면 다음 사람이 갈라진 목록이 아직 있는 줄 안다).

### C. `onRetryLookup`이 책을 받는다

```ts
onRetryLookup?: (book: UnidentifiedBook) => void;
```

`BookList`와 `UnidentifiedBookCard` 양쪽의 시그니처를 넓히고, `UnidentifiedBookCard`가 자기 `book`을 넘겨 부르게 한다.

`page.tsx`의 배선을 **사진 전체 재분석에서 책 단위 재조회로** 옮긴다. 이 버튼은 `lookup_failed`에만 뜬다 — 알라딘 조회가 5xx·타임아웃으로 **실패**한 경우이지 검색 결과가 없는 경우가 아니다(ADR-005). 그러므로 올바른 재시도는 **같은 질의를 다시 보내는 것**이다. 사용자에게 제목을 고치라고 요구하는 입력 패널(`openResolve`)로 보내지 마라 — 고칠 것이 없다. 이미 있는 `runResolve` 경로를 그 책의 `rawText`로 곧장 태워라.

**재분석(`handleRetryPhotos`)을 부르지 마라.** 이유: 알라딘 한 건의 실패에 모델 비용 전체를 다시 낸다. 이 항목이 보고된 이유가 정확히 그것이다.

`onRetryPhoto`(부분 실패 배너의 "이 사진만 다시 시도")는 **다른 경로다.** 건드리지 마라.

### D. 테스트

- `BookList.test.tsx` — 두 출처가 한 목록에 함께 서고 권수가 합계다 · `resolved` 책의 출처가 화면에 드러난다 · `resolved` 책에 `claudeNote` 자리를 지어내지 않는다 · `onRetryLookup`이 **책 인자와 함께** 불린다 · 기존 케이스(부분 실패 배너 · 빈 확인 목록 · overflow 안내 · 미확인 섹션)가 그대로 통과한다
- `UnidentifiedBookCard.test.tsx` — `lookup_failed`에만 재시도 버튼이 뜬다(기존) · 그 버튼이 자기 `book`을 넘긴다
- 페이지 테스트 — `lookup_failed`의 "다시 시도"가 **재분석을 부르지 않고** 그 책의 재조회를 부른다 · 재검색으로 합류한 책이 한 목록에 나타난다 · "직접 확인한 책" 별도 섹션이 더 이상 없다
- 안티패턴 회귀 테스트가 있다면 그대로 통과시켜라

## Acceptance Criteria

```bash
npm run typecheck              # 컴파일 에러 없음
npm run lint                   # ESLint 통과
npm test                       # 전부 통과 (앞 step까지의 누적 + 추가분)
npm run build                  # 프로덕션 빌드 성공
npm audit --audit-level=high   # high 이상 0건
```

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 컴포넌트가 `services/*`·`lib/proof`·`lib/prompts`를 import하지 않는가? 세션 모듈에서 **런타임 값**을 가져오지 않는가? (레이어 경계 — ARCHITECTURE)
   - 알라딘 사실과 Claude 생성 텍스트가 같은 층위에 섞이지 않았는가? (ADR-002 · UI_GUIDE)
   - `lookup_failed`와 `no_match`의 문구·색·행동이 여전히 갈라지는가? (ADR-005)
   - `localStorage`·쿠키에 상태를 남기지 않았는가? (ADR-003)
3. 결과에 따라 `phases/forced-path/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 자가 교정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`ShelfBook` 타입을 바꾸지 마라.** 이유: 다음 step이 같은 세션 모듈을 다룬다. 지금 형태로 충분하다
- **`resolved` 책에 `photoIndex`를 지어내지 마라.** 이유: 없는 값을 채우는 것은 출처 위조다 (ARCHITECTURE 상태 관리). 이 결함이 생긴 원인이 그것을 피한 것이었고, 그 판단은 옳았다
- **`claudeNote`가 없는 책에 빈 문자열을 넣어 렌더하지 마라.** 이유: 없는 해석을 있는 것처럼 만든다 (ADR-002)
- **`lookup_failed`의 재시도를 `handleRetryPhotos`에 배선한 채로 두지 마라.** 이유: 이 step이 닫기로 한 보고가 정확히 그것이다
- **`onRetryPhoto`(부분 실패 배너)를 건드리지 마라.** 이유: 다른 경로다
- **`src/app/api/**`·`src/services/**`를 고치지 마라.** 이유: 이 step은 화면 계층이다. 라우트가 부족해 보이면 고치지 말고 `summary`에 보고하라
- **재검색으로 합류한 책을 추천 후보에서 빼거나 넣는 판단을 하지 마라.** 이유: 그 책은 `proof`를 갖고 있고 자격 판정은 서버의 일이다 (ADR-006)
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
