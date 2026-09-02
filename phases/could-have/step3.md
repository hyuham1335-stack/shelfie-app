# Step 3: share-button

## 읽어야 할 파일

- `/docs/PRD.md` — 4번 FR-014, 5번 화면 인벤토리(추천 결과), 7번 이벤트 로그의 "FR-013·FR-014·FR-015 는 이벤트를 만들지 않는다"
- `/docs/UI_GUIDE.md` — "저장 이미지 (추천 결과 PNG — FR-014)" 절 마지막 문단(트리거 버튼), "버튼", "안내 문구 (Notice)"
- `/docs/ARCHITECTURE.md` — 레이어 의존 규칙, "상태 관리"(`dispatch` 를 화면에 넘기지 않는다)
- `/docs/ADR.md` — ADR-003(무상태 · 저장하지 않는다), ADR-009(저장 이미지)

아래 소스는 **접두부에 이미 첨부돼 있다. 다시 읽지 마라.**

- `src/lib/share-image.ts` — step 1·2 가 만든 저장 이미지 모듈
- `src/components/common/Notice.tsx`

## 직접 읽어라 — 첨부하지 않은 파일

아래 두 파일은 **접두부에 없다. 작업 전에 반드시 직접 읽어라.** 이 step 이 고치는 것은 이 둘(과 그 테스트)이다.

- `src/app/page.tsx` — 세션 상태 머신과 화면 전환. `handleAccept` 주변이 이 step 이 붙을 자리다
- `src/components/recommend/RecommendationList.tsx` — 추천 결과 화면. 그 테스트도 함께 읽어라

## 작업

추천 결과를 PNG 한 장으로 내려받는 경로를 붙인다 (FR-014).

### 배선

- `RecommendationList` 에 **"이미지로 저장" Secondary 버튼**을 더한다. 위치는 "다시 추천받기" 근처이고, 정확한 배치는 UI_GUIDE 의 저장 이미지 절과 기존 화면 구조를 보고 정하라
- **화면은 이미지를 만들지 않는다.** 사용자의 행동을 콜백으로 위에 알리고, `page.tsx` 가 `renderShareImage` 를 부르고 다운로드까지 처리한다.
  - **이유**: `components/` 는 표현 층이고, 저장은 브라우저 API(`URL.createObjectURL`·`<a download>`)를 만지는 부수 효과다. 화면이 그것을 직접 하면 추천 카드 테스트가 매번 그 API 를 흉내 내야 한다
  - 단 "저장 중인가"·"실패했는가" 같은 **표시 상태**를 어디에 둘지는 네 재량이다. `page.tsx` 의 리듀서에 새 상태를 넣을지, 화면의 지역 상태로 둘지 판단하라 — 판단 근거를 `summary` 에 적어라
- **`dispatch` 를 화면에 넘기지 마라. 이유**: ARCHITECTURE 의 상태 관리 규칙이다. 필요한 값만 개별 props 로 주고 행동은 콜백으로 받는다

### 다운로드

- `renderShareImage` 가 준 `Blob` 을 `URL.createObjectURL` 로 열고 `<a download>` 로 내려받은 뒤 **`revokeObjectURL` 로 반드시 회수한다. 이유**: 회수하지 않으면 재추천을 반복하는 세션에서 blob 이 계속 쌓인다
- 파일명은 결정적으로 짓는다. **날짜·시각을 파일명에 넣을지는 네가 정하되, 넣는다면 테스트가 시각에 의존하지 않게 하라**
- **Blob 을 서버로 보내지 마라. 어디에도 저장하지 마라** (ADR-003 · PRD 보관 기간 0)

### 상태와 문구

- 저장 중에는 버튼을 **감추지 말고 비활성으로 둔다** — 사라지는 버튼은 사용자가 자기가 뭘 눌렀는지 잃게 만든다. 이 리포는 재시도 대기(FR-010)에서 이미 같은 규율을 쓴다
- 실패하면 `Notice` 로 알리고 **화면 상태를 바꾸지 마라** — 추천 결과가 사라지면 안 된다. 경고색·`role="alert"` 를 쓰지 마라 (UI_GUIDE 안내 문구)
- 진행 상태는 눈으로만 알리지 않는다 (TRD 6.6 접근성)

### 재추천과의 관계

- 저장은 **재추천 횟수(FR-010 세션당 5회)를 소모하지 않는다.** 모델을 부르지 않기 때문이다. `recommendCount` 를 건드리지 마라
- 추천 묶음이 바뀌면 저장 상태도 초기화돼야 한다 — 이전 묶음의 실패 메시지가 새 추천 위에 남으면 안 된다

### 이벤트

**이벤트를 만들지 마라. 이유**: PRD 7번이 명시한다. 저장 클릭은 어느 지표에도 연결되지 않는다. 특히 `recommend_accepted` 근처를 만지면서 그 옆에 새 이벤트를 끼워 넣지 마라 — North Star 의 분자를 건드리는 것이다

### 테스트

TDD 다. 먼저 실패하는 테스트를 쓰고 통과시켜라. `renderShareImage` 는 **가짜로 갈아 끼워** 검증한다 (jsdom 에 canvas 가 없다).

최소한 아래를 고정한다.

- 버튼을 누르면 `renderShareImage` 가 **정확히 한 번** 불리고, 넘어간 책 목록이 화면에 뜬 추천 3권과 일치한다
- 저장 중 버튼이 비활성이고, **감춰지지 않는다**
- 실패하면 안내가 뜨고 **추천 목록이 그대로 남는다**
- `revokeObjectURL` 이 불린다
- 저장이 `recommendCount` 를 늘리지 않는다
- 새 이벤트가 전송되지 않는다 (`/api/events` 호출이 늘지 않는다)
- `page.tsx` · `RecommendationList` 의 기존 테스트가 하나도 깨지지 않는다

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
   - `components/` 가 `services/`·`lib/proof`·`lib/prompts` 를 import 하지 않는가?
   - `dispatch` 가 화면 컴포넌트로 넘어가지 않았는가?
   - `localStorage`·`sessionStorage`·쿠키를 쓰지 않았는가? (ADR-003)
   - 새 npm 의존성이 0건인가?
3. 결과에 따라 `phases/could-have/index.json` 의 step 3 을 업데이트한다 (성공 → `completed` + `summary`, 실패 → `error` + `error_message`, 개입 필요 → `blocked` + `blocked_reason`).

`summary` 에는 **저장 상태를 어디에 두었고 왜 그렇게 정했는지, 파일명 규칙, 새 props 의 이름**을 적어라.

## 금지사항

- **`src/lib/share-image.ts` 를 고치지 마라. 이유**: step 1·2 가 만든 계약이다. 고쳐야 한다고 판단되면 고치지 말고 `summary` 에 적어 보고하라
- **`src/app/api/**` · `src/services/**` 를 고치지 마라. 이유**: 저장은 서버를 부르지 않는다. 서버가 등장하는 순간 "이미지를 저장하지 않는다"는 성질이 흔들린다
- **새 이벤트를 만들지 마라** (`lib/analytics.ts` · `app/api/events` 무변경). 이유: PRD 7번
- **`localStorage`·`sessionStorage`·쿠키를 쓰지 마라. 이유**: 무상태 전제를 문서 없이 우회하는 것이다 (ADR-003 · CLAUDE.md CRITICAL)
- **새 npm 패키지를 넣지 마라.** 이유: 새 의존성은 ADR 이 먼저다
- **`docs/**` 를 고치지 마라.** 이유: 메인 소유다
- **`index.json` 의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`)
- **`RUNNING` 파일을 읽지도 지우지도 마라.**
- 기존 테스트를 깨뜨리지 마라
