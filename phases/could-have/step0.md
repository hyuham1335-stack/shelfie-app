# Step 0: aladin-link

## 읽어야 할 파일

먼저 아래를 읽고 이 프로젝트가 **사실과 해석을 어떻게 가르는지** 파악하라. 그 경계가 이 step 의 유일한 위험이다.

- `/docs/PRD.md` — 4번 FR-013(알라딘 상품 링크), 5번 화면 인벤토리
- `/docs/UI_GUIDE.md` — "외부 링크 (알라딘 상품 페이지 — FR-013)" 절, "Claude 생성 텍스트 블록", "버튼", "아이콘"
- `/docs/ARCHITECTURE.md` — 레이어 의존 규칙
- `/docs/ADR.md` — ADR-002(사실은 알라딘에서만, Claude 는 해석만)

아래 소스는 **접두부에 이미 첨부돼 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

- `src/components/booklist/IdentifiedBookCard.tsx` · `src/components/booklist/IdentifiedBookCard.test.tsx`
- `src/components/recommend/RecommendationCard.tsx` · `src/components/recommend/RecommendationCard.test.tsx`
- `src/components/booklist/BookList.tsx` · `src/components/booklist/BookList.test.tsx`
- `src/types/book.ts`

## 작업

확인된 책 카드와 추천 책 카드에서 알라딘 상품 페이지로 나가는 링크를 제공한다 (FR-013).

**대상 카드는 셋이다.** 세 곳 모두에 같은 표현으로 넣는다.

1. `IdentifiedBookCard` — 사진에서 확인된 책
2. `BookList.tsx` 안의 로컬 `ResolvedBookCard` — 재검색으로 승격된 책. **같은 목록에 나란히 서는 카드가 한쪽만 링크를 가지면 사용자는 그것을 "이 책은 알라딘에 없다"로 읽는다**
3. `RecommendationCard` — 추천 3권

### URL 의 출처

`AladinFacts.aladinLink` 를 **그대로** 쓴다.

- **ISBN 으로 URL 을 조립하지 마라. 이유**: 조립한 링크는 우리가 만든 사실이다. 알라딘이 준 값과 형태가 같아 보여도 그것을 보증하는 것은 아무것도 없고, 이 프로젝트에서 가장 심각한 결함은 정확히 "우리가 만든 것을 알라딘 사실처럼 보여 주는 것"이다 (ADR-002).
- `aladinLink` 는 `aladinFactsSchema` 에서 `absoluteUrlSchema` 라 **항상 존재한다.** 세 카드의 `book` prop 은 전부 `AladinFacts` 를 만족하므로 값이 없는 경우는 타입으로 배제돼 있다.
- **`aladinLink` 를 옵셔널이나 nullable 로 넓히지 마라. 이유**: 도달하지 않는 화면을 만들면 그것을 고정하는 테스트가 붙고, 그 테스트가 다음 사람에게 "이 값은 없을 수 있다"는 거짓 사실을 가르친다. UI_GUIDE 의 "링크가 없는 책에는 자리를 비운다"는 값이 없을 때의 **원칙**이지 분기를 만들라는 지시가 아니다.

### 표현

`/docs/UI_GUIDE.md` 의 "외부 링크" 절을 그대로 따른다. 요점만 옮기면:

- `<a>` 로 렌더하고 `target="_blank"` · `rel="noopener noreferrer"` 를 반드시 붙인다
- 문구는 **"알라딘에서 보기"**
- Text 버튼 스타일 (밑줄 + 보조 텍스트 색). 이 리포는 Tailwind 토큰을 쓰므로 첨부된 카드들이 이미 쓰는 토큰 이름을 따라라 — 헥스 값을 새로 박지 마라
- **`ClaudeText` 블록 안에 두지 마라. 이유**: 그 블록은 Claude 가 쓴 문장의 자리이고 링크는 알라딘 사실이다. 한 블록 안에 섞이면 사실·해석 구분이 시각적으로 무너진다 (ADR-002)
- **새 아이콘을 만들지 마라. 이유**: UI_GUIDE 가 아이콘을 카메라·재시도·닫기·체크 4종으로 제한한다. 외부로 나간다는 것은 문구로 알린다

### 접근성

- 링크 텍스트만으로 어디로 가는지 알 수 있어야 한다. 카드마다 같은 문구가 반복되므로 **책을 구별할 수 있는 접근성 이름**을 준다 (예: `aria-label` 에 제목을 포함). 어떤 방식으로 할지는 네 재량이되, 스크린리더 사용자가 "알라딘에서 보기" 3개를 구분할 수 없는 상태로 두지 마라 (TRD 6.6)
- 링크는 키보드 포커스를 받아야 한다. `onClick` + `div` 로 만들지 마라

### 이벤트

**이벤트를 만들지 마라. 이유**: PRD 7번이 "FR-013·FR-014·FR-015 는 이벤트를 만들지 않는다"고 명시한다. 링크 클릭은 어느 지표에도 연결되지 않고, 지표 없는 이벤트는 로그를 늘려 실제 신호를 묻는다.

### 테스트

TDD 다 — 먼저 실패하는 테스트를 쓰고 통과시켜라 (CLAUDE.md CRITICAL). 최소한 아래를 고정한다.

- 세 카드 각각에서 `href` 가 `book.aladinLink` 와 **정확히 같다** (조립 금지의 회귀 방어)
- `target="_blank"` 와 `rel` 에 `noopener` · `noreferrer` 가 둘 다 있다
- 링크가 `ClaudeText` 블록 **밖**에 있다 (추천 카드에서 특히)
- 기존 카드 테스트가 하나도 깨지지 않는다

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - ARCHITECTURE.md 레이어 경계를 지켰는가? (`components/` → `services/` 금지)
   - 새 npm 의존성이 0건인가?
   - CLAUDE.md CRITICAL 규칙을 위반하지 않았는가? 특히 사실·해석 층위 분리
3. 결과에 따라 `phases/could-have/index.json` 의 step 0 을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 3회 시도 후에도 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단

`summary` 에는 **세 카드 각각에 무엇을 넣었는지와 링크의 접근성 이름을 어떻게 지었는지**를 적어라. 다음 step 들이 같은 표현을 저장 이미지와 업로드 화면에서 재사용한다.

## 금지사항

- **`src/lib/**` · `src/services/**` · `src/app/api/**` 를 고치지 마라. 이유**: 이 step 은 표현 층만 만진다. `aladinLink` 는 이미 응답에 실려 화면까지 도달해 있고 계약 변경이 필요 없다
- **`src/app/page.tsx` 를 고치지 마라. 이유**: 세 카드는 이미 필요한 `book` 을 받고 있다. 페이지를 건드리면 이 step 의 회귀 표면이 상태 머신까지 넓어진다
- **`docs/**` 를 고치지 마라. 이유**: 메인 소유다. 문서가 틀렸다고 판단되면 고치지 말고 `summary` 에 적어 보고하라
- **새 npm 패키지를 넣지 마라. 이유**: 새 의존성은 ADR 이 먼저다 (CLAUDE.md CRITICAL)
- **`index.json` 의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다. 네가 쓰면 실측이 오염된다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
