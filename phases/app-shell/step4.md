# Step 4: ui-mood-recommend — 기분 입력 · 문답 · 추천 결과 (US-003, US-004)

가치가 실제로 전달되는 화면이다. 그리고 **추천 이유는 Claude가 지어낸 문장**이라 사실과 같은 층위에 놓이면 안 된다 (ADR-002).

## 읽어야 할 파일

- `/docs/UI_GUIDE.md` — **전문.** 특히 **카드 반경 3종이 서로 다르다**(확인 `rounded-md` · 미확인 `rounded-sm` · **추천 `rounded-lg`**), "Claude 생성 텍스트 블록", 버튼, 안내 문구 표, 안티패턴
- `/docs/PRD.md` — US-003 · US-004 · FR-006(shortfall) · FR-007(문답 폴백) · FR-010(재추천 5회) · 화면 인벤토리
- `/docs/ADR.md` — **ADR-002(사실과 해석의 분리)**
- `/docs/API_SPEC.md` — `mood/questions`(200 + 빈 배열 폴백) · `recommend`(422 `IRRELEVANT_MOOD` · `shortfall`)
- `src/components/common/ClaudeText.tsx` — **`label`은 `"AI 한줄평" | "추천 이유"` 둘뿐이다.** 빈 문자열 처리는 이미 돼 있다
- `src/components/booklist/` — 런 #4의 카드들. 반경·레이아웃의 기준
- `src/lib/schemas.ts` — `moodQuestionSchema` · `recommendationSchema`
- step 1의 `src/lib/session.ts` — `canRecommendAgain` 등 셀렉터

## 작업

`fetch`를 부르지 않는다. 전부 props와 콜백이다.

### `src/components/mood/`

| 컴포넌트 | 역할 |
|---|---|
| `MoodInput` | 자유 텍스트 입력창(2~500자) · **예시 문장 3개** · 비운 채 진행하는 경로 |
| `GuidedQuestions` | 질문 2~3개, 각 선택지 3~4개 · 건너뛰기 |

- 입력을 **비운 채 진행**하면 문답으로 간다 (FR-007). 이것은 에러가 아니라 설계된 경로다 — 빨간 문구를 쓰지 마라
- 문답 응답이 **빈 배열**로 오면(생성 실패·모델 장애 모두 200이다) 조용히 자유 입력으로 돌아간다. "질문을 만들지 못했어요"를 에러 배너로 띄우지 마라 — 사용자가 할 일이 없는 실패다
- 답변은 합성해 `mood` 문자열로 만든다. `inputMode`는 `"guided"`다

### `src/components/recommend/`

| 컴포넌트 | 역할 |
|---|---|
| `RecommendationCard` | 추천 1권. 사실(표지·제목·저자·쪽수) + **`ClaudeText label="추천 이유"`** |
| `RecommendationList` | 3권 배치 · `shortfall` 안내 · "다시 추천받기" |

- 카드는 `rounded-lg border-[#2F5D50]/30 p-5`다. **확인·미확인 카드와 반경이 달라야 한다** — UI_GUIDE가 "모든 카드에 동일한 `rounded-2xl`"을 안티패턴으로 명시한다
- **추천 이유는 반드시 `ClaudeText`로 감싼다.** 서지 사실과 같은 문단·같은 색으로 흘리지 마라 (ADR-002). 이 프로젝트에서 가장 조심할 지점이다
- "이거 읽을래요" 버튼 → `onAccept(bookId, position)` 콜백. 이벤트 전송은 step 5가 한다
- `shortfall: true`면 UI_GUIDE 문구를 **그대로** 쓴다
- 재추천이 5회에 소진되면 버튼을 **비활성 상태로 남기고**(숨기지 말고) "기분을 바꿔 적어 보세요"를 붙인다

### 무상태라서 화면이 져야 하는 책임

서버에는 세션이 없다 (ADR-003). 따라서:

- **`relevant: false`(422 `IRRELEVANT_MOOD`)가 2회 연속이면 무시한다**는 API_SPEC 규칙을 서버가 셀 수 없다. 화면이 연속 횟수를 상태로 들고, 2회째에는 재입력을 요구하는 대신 **예시 문장을 강조해 다시 받는다**
- 새로고침하면 그 카운터가 사라진다. **`localStorage`로 지키려 하지 마라** — 무상태 전제를 문서 없이 우회하는 것이고, 이 상한은 남용 방어가 아니라 비용 누수 방지라 그 정도로 충분하다

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
   - 추천 이유가 `ClaudeText`를 거치는가? (`grep -n "reason" src/components/recommend/*.tsx`로 직접 렌더가 없는지 본다)
   - 추천 카드 반경이 확인·미확인 카드와 **다른가**?
   - 빈 질문 배열에서 에러 배너가 아니라 자유 입력으로 가는가?
   - `grep -rn "fetch(\|localStorage\|sessionStorage" src/components/mood src/components/recommend` 가 0건인가?
   - UI_GUIDE 안티패턴 0건인가?
3. 결과에 따라 `phases/app-shell/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 **export한 컴포넌트명과 콜백 props 시그니처**를 담아라. step 5가 배선한다
   - 실패 → `"status": "error"` + `"error_message"` / 개입 필요 → `"status": "blocked"` + `"blocked_reason"`

## 금지사항

- **추천 이유를 사실과 같은 시각 층위로 렌더하지 마라.** 이유: ADR-002. 알라딘에서 온 사실과 Claude가 지어낸 해석을 섞으면 사용자가 무엇을 믿어야 할지 알 수 없다
- **`fetch`를 부르거나 `lib/api-client.ts`를 import하지 마라.** 이유: 배선은 step 5다
- **`localStorage`·`sessionStorage`·쿠키를 쓰지 마라.** 이유: ADR-003 무상태 전제. 재추천 상한을 저장소로 지키려는 시도가 특히 그렇다
- **문답 생성 실패를 에러 배너로 띄우지 마라.** 이유: 사용자가 할 일이 없는 실패이고, API_SPEC이 200+빈 배열로 흡수하기로 결정한 이유가 그것이다
- **모든 카드를 같은 반경으로 만들지 마라.** 이유: UI_GUIDE 안티패턴 1번
- **`src/lib/` · `src/components/common/` · `src/components/booklist/`를 고치지 마라.** 이유: step 0~2와 런 #4가 확정한 계약이다. 결함은 `summary`로 보고하라
- **`src/app/page.tsx`를 고치지 마라.** 이유: step 5다
- **별점 아이콘·장식 아이콘을 넣지 마라.** 이유: UI_GUIDE 안티패턴
- **`vitest.config.ts`·`vitest.setup.ts`를 고치지 마라.** 이유: `main_owned_paths`다. cleanup은 이미 전역으로 걸려 있다
- **`index.json`의 실행기 소유 필드와 `RUNNING` 파일을 건드리지 마라**
- 새 npm 의존성을 추가하지 마라
- 기존 테스트를 깨뜨리지 마라
