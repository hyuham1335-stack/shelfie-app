# Step 4: mood-forced-path — 무관 판정 2회 연속 뒤 세 번째는 추천이 나온다

`/docs/PRD.md` US-003 의 AC 하나가 다섯 런 동안 **도달 불가**였다:

> Given 같은 세션에서 무관 판정이 **2회 연속** 나왔을 때, When 세 번째로 제출하면, Then 판정을 무시하고 추천이 생성된다 — 오탐으로 사용자를 입력 화면에 가두지 않는다

앞 step 들이 서버 쪽을 닫았다 — 요청이 `irrelevantStreak`를 싣고, 라우트가 `>= 2`면 `relevant: false`를 무시하고 추천을 진행한다. **이제 세 번째 제출은 실제로 추천을 받는다.** 남은 것은 화면이다: 지금 `MoodInput`은 2회째부터 예시를 강조하는 것까지만 하고, **세 번째에 무슨 일이 일어나는지 사용자에게 말하지 않는다.**

## 읽어야 할 파일

- `/docs/UI_GUIDE.md` — **전문.** 디자인 원칙 · 색상 토큰 · Notice 컴포넌트 · 안티패턴 목록. 특히 "비워 두는 것은 실패가 아니다"에 대응하는 톤 규칙
- `/docs/PRD.md` — US-003 의 AC 6개(특히 무관 입력 2건) · 5번 UX 의 "기분 입력" 화면 인벤토리 · 7번 이벤트 로그의 `mood_submitted`
- `/docs/API_SPEC.md` — `POST /api/recommend` 의 `IRRELEVANT_MOOD` 판정 규칙 불릿과 `irrelevantStreak` 파라미터
- `src/components/mood/MoodInput.tsx` — **전문.** `nextIrrelevantCount` · `IRRELEVANT_EMPHASIS_THRESHOLD` · `irrelevantCount` prop 을 쓰는 렌더 분기 2곳
- `src/components/mood/MoodInput.test.tsx`
- `src/app/page.tsx` — `irrelevantCount` state 와 `runRecommend`, `MoodInput`에 넘기는 props
- `src/app/page.test.tsx`
- `src/components/common/Notice.tsx` — 중립 안내의 표준 컴포넌트

## 작업

### A. 세 번째 제출이 무엇을 하는지 화면이 말한다

`irrelevantCount >= 2`일 때 지금은 예시 블록을 강조하고 문구를 바꾸는 것이 전부다. 여기에 **"이대로도 추천해 드릴게요"에 해당하는 안내**를 더한다 — 사용자가 같은 문장을 그대로 다시 눌러도 이번에는 결과가 나온다는 것을 **누르기 전에** 알아야 한다.

톤을 지켜라. 이 경로는 **사용자의 실패가 아니라 우리 판정의 오탐 가능성**을 인정하는 자리다:

- 경고색(`danger` 계열)을 쓰지 마라. `Notice`의 중립 톤이다 — 비운 채 진행하는 경로에 경고색을 쓰지 않는 것과 같은 이유다
- "다시 시도해 주세요" 류의 **요구를 반복하지 마라.** 두 번 말했고 통하지 않았다
- 억지 추천이 될 수 있다는 것을 숨기지도 마라. 결과 품질이 낮을 수 있음을 한 문장으로 인정하는 편이 정직하다

문구는 네가 정하되 UI_GUIDE 의 톤 규칙과 PRD 의 기존 문구("책 고르는 데 참고할 내용을 적어 주세요")와 이어지게 써라.

### B. 세 단계가 각각 다른 화면이 되게 한다

지금 `irrelevantCount`의 렌더 분기는 `=== 1`과 `>= 2` 둘이다. **0·1·2 이상이 각각 다른 화면**이 되도록 정리하라. `IRRELEVANT_EMPHASIS_THRESHOLD` 상수는 이미 있다 — 새 임계값을 매직 넘버로 박지 말고 이름을 붙여라.

### C. 페이지 배선을 확인한다

`irrelevantCount`가 `MoodInput`에 흐르는 경로는 이미 있다. 확인하고 필요하면 고칠 것:

- 추천이 **성공하면** `irrelevantCount`가 0 으로 돌아가는가 (강행 경로로 성공한 경우 포함)
- `IRRELEVANT_MOOD`가 아닌 실패에서 0 으로 돌아가는가 (`nextIrrelevantCount`의 규칙)
- **`nextIrrelevantCount`의 규칙 자체는 바꾸지 마라.** 연속이 아니면 의미가 없다는 것이 그 함수의 설계다

### 테스트

- `MoodInput`: `irrelevantCount`가 0 · 1 · 2 · 3 일 때 렌더가 각각 다르고, 2 이상에서 강행 안내가 보인다
- `MoodInput`: 어느 경우에도 제출 버튼이 비활성화되지 않는다 — **입력 화면에 가두지 않는 것이 이 경로의 목적이다**
- 페이지 통합: **US-003 AC 를 그대로 재현한다.** 422 를 두 번 받은 뒤 세 번째 제출이 `irrelevantStreak: 2`를 싣고, 200 응답에서 추천 화면으로 간다
- 페이지 통합: 강행 경로로 성공한 뒤 `irrelevantCount`가 0 으로 돌아간다
- UI_GUIDE 안티패턴 회귀 검사(`src/components/common/antipatterns.test.tsx` 패턴)를 새 문구가 위반하지 않는다

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --audit-level=high
```

## 검증 절차

1. 위 AC 커맨드를 순서대로 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `MoodInput`이 여전히 네트워크를 모르는가? (`fetch` · `lib/api-client` import 0건)
   - 원시 hex 색상을 쓰지 않고 UI_GUIDE 토큰만 쓰는가? 안티패턴 목록 위반 0건인가?
   - Claude 생성 텍스트와 사실을 섞지 않았는가? (이 화면에는 둘 다 없지만 새 문구가 그 경계를 만들지 않는지 본다)
   - `localStorage`·쿠키에 카운터를 남기지 않았는가? (ADR-003)
3. 결과에 따라 `phases/contract-wiring/index.json`의 step 4 를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

이 step 은 런 #6 의 마지막이다. **`summary`에 ROADMAP 23 의 배선 6건이 전부 닫혔는지, 닫히지 않은 것이 있으면 무엇인지 남겨라.**

## 금지사항

- **제출 버튼을 비활성화하거나 입력을 막지 마라.** 이유: 오탐으로 사용자를 입력 화면에 가두지 않는 것이 이 경로의 존재 이유다
- **경고색을 쓰지 마라.** 이유: 사용자의 실패가 아니라 우리 판정의 오탐 가능성을 인정하는 자리다 (UI_GUIDE)
- **화면이 서버 판정을 대신하지 마라.** 이유: 세는 것은 클라이언트, 판정하는 것은 서버다 (API_SPEC). 화면이 "이건 무관하지 않다"고 자체 판단해 요청을 바꾸면 같은 규칙이 두 곳에 생긴다
- **`nextIrrelevantCount`의 연속 규칙을 바꾸지 마라.** 이유: 연속이 아닌 누적으로 세면 판정을 무시하는 시점이 앞당겨져 억지 추천이 늘어난다
- **`localStorage`·쿠키에 카운터를 남기지 마라.** 이유: 새로고침 시 소실은 의도된 결과다 (ADR-003). 이 상한은 남용 방어가 아니다
- **`src/app/api/**` · `src/lib/schemas.ts` · `src/lib/analytics.ts`를 고치지 마라.** 이유: 앞 step 들이 닫았다. 모자란 것이 있으면 고치지 말고 `summary`에 보고하라
- **기존 테스트를 지우거나 `skip` 하지 마라.**
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- `docs/**` · `harness/**` · `scripts/**` 를 고치지 마라. 이유: 메인 소유 경계다
