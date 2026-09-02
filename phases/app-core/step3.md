# Step 3: ui-common — 공통 UI 조각 (TR-011의 기반)

`src/components/`의 첫 파일들이다. 이 step이 만든 조각 위에 나머지 화면이 올라간다.

## 읽어야 할 파일

- `/docs/UI_GUIDE.md` — **전문이 이 step의 계약이다.** 특히 "Claude 생성 텍스트 블록" · "에러 배너" · "부분 실패 배너" · "안내 문구" · "배지" · "AI 슬롭 안티패턴" 표
- `/docs/ADR.md` — **ADR-002(사실과 해석의 분리)** · ADR-005(실패와 데이터 없음의 분리)
- `/docs/ARCHITECTURE.md` — 디렉토리 구조의 `components/` 노드, **레이어 의존 관계**, 상태 관리 절
- `/docs/PRD.md` — 5번 Edge Cases 표, US-001~US-004
- `/docs/TRD.md` — 3번 표의 TR-011 행(번들 200KB·LCP·INP), 6.4 관측성(requestId)
- `/docs/API_SPEC.md` — 에러 응답 규약(`error`·`code`·`requestId`)과 에러 코드 목록
- `src/app/globals.css` — **색상 토큰이 이미 Tailwind `@theme`으로 정의돼 있다.** `bg-page`·`bg-card`·`bg-muted-surface`·`border-line`·`text-ink`·`text-body`·`text-subtle`·`text-disabled`·`text-accent`·`text-unverified`·`text-danger`
- `src/app/layout.tsx` · `src/app/page.tsx` — 현재 형태. 레이아웃 폭(`max-w-md`)과 클래스 사용법을 여기에 맞춘다
- `src/lib/schemas.ts` — `errorCodeSchema` · `errorResponseSchema`

## 작업

`src/components/common/` 아래에 화면 공통 조각을 만든다. **화면(업로드·결과·기분·추천)은 만들지 않는다** — step 4와 다음 런이다.

만들 것:

| 컴포넌트 | 역할 |
|---|---|
| `ClaudeText` | **Claude 생성 텍스트 블록.** 한줄평·추천 이유는 반드시 이것으로만 렌더한다 |
| `ErrorBanner` | 에러 배너. `requestId` 노출 + 탭하면 클립보드 복사 |
| `Notice` | 안내 문구. 에러가 아니므로 색을 쓰지 않는다 |
| `Badge` | 배지 — 미확인 사유용·평점용 |
| `Skeleton` | 정적 스켈레톤 블록 (펄스 없음) |

### 왜 `ClaudeText`가 이 step의 핵심인가

**사실과 해석을 가르는 장치다.** 알라딘에서 온 사실(제목·저자·쪽수·평점)과 Claude가 쓴 해석(한줄평·추천 이유)이 같은 시각 층위로 렌더되는 순간 이 프로젝트의 전제가 무너진다 (ADR-002, CLAUDE.md CRITICAL). 사용자가 **라벨을 읽지 않고도** 구분할 수 있어야 한다.

UI_GUIDE가 정한 형태를 그대로 쓴다:
```
border-l-2 border-accent/40 pl-3 text-sm text-subtle italic
라벨: text-[11px] uppercase tracking-wide text-disabled not-italic — "AI 한줄평" / "추천 이유"
```

### 반드시 지킬 규칙

1. **UI_GUIDE의 안티패턴 표를 어기지 마라.** `backdrop-filter: blur()` · gradient-text · "Powered by AI" 배지 · box-shadow 글로우 애니메이션 · 보라/인디고 · 모든 카드에 동일한 `rounded-2xl` · 배경 gradient orb — **하나도 쓰지 마라.**
2. **색상은 `globals.css`의 토큰 클래스를 쓴다.** 원시 hex(`#2F5D50` 등)를 컴포넌트에 다시 박지 마라. 토큰이 이미 있다.
3. **에러 배너는 `requestId`를 반드시 노출한다.** 화면에 없으면 상관관계 ID 규칙이 무의미해진다 (TRD 6.4). 탭하면 클립보드에 복사된다. **클립보드 API가 없거나 실패해도 배너가 깨지면 안 된다.**
4. **`SERVICE_DISABLED`(503)일 때는 재시도 버튼을 감춘다.** 눌러도 달라지지 않는 버튼은 없느니만 못하다.
5. **모델이 생성한 문장이나 내부 에러 원문을 배너에 넣지 마라.** 에러 코드 → 정해진 문구 매핑만 쓴다.
6. **`lookup_failed` 배지는 앰버(`text-unverified`)가 아니라 중립(`text-subtle`)이다.** 사용자 책장의 문제가 아니라 우리 쪽 문제다 (ADR-005, UI_GUIDE).
7. **미확인을 색상만으로 구분하지 마라.** 배지에 텍스트를 항상 함께 넣는다 (색각 접근성).
8. **스켈레톤은 펄스 없이 정적이다.** 애니메이션은 `fade-in`(0.2s) 하나만 허용되고 그것도 결과·추천 카드 등장에만 쓴다.
9. **터치 타깃 최소 44×44px.** 한 손 사용이 기본 자세다.
10. **서버 전용 모듈을 import하지 마라.** `services/*` · `lib/proof.ts` · `lib/env.ts`는 클라이언트 번들에 들어가면 안 된다 (레이어 의존 관계). 필요한 타입은 `types/` 또는 `lib/schemas.ts`의 `z.infer`에서 가져온다.
11. **번들을 무겁게 만들지 마라.** 초기 JS 200KB(gzip) 예산이다 (TR-011). 아이콘은 SVG 인라인, `strokeWidth 1.5`, 크기 16 또는 20, 카메라·재시도·닫기·체크 4종으로 제한한다.

### 테스트 (먼저 작성한다)

`src/components/common/*.test.tsx`. **`@testing-library/react`와 `jsdom`은 이미 설치돼 있다 — 새로 추가하지 마라.**

> ⚠ **`@testing-library/jest-dom` 매처(`toBeInTheDocument` 등)는 등록돼 있지 않다.** `vitest.config.ts`에 `setupFiles`가 없고 **그 파일은 고칠 수 없다**(`main_owned_paths`). `expect(el).not.toBeNull()` · `expect(el.textContent).toContain(...)` · `expect(el.className).toContain(...)` 처럼 **표준 `expect`로 단언하라.** 매처를 등록하려 하지 말고, 필요하면 `summary`로 보고하라.

- `ClaudeText`가 라벨과 본문을 렌더하고, **왼쪽 보더와 italic이 적용된다**(사실과 해석의 시각적 분리 — 이 테스트를 삭제하지 마라)
- `ClaudeText`에 빈 문자열을 넘기면 **블록 자체를 렌더하지 않는다**(한줄평 생성 실패는 빈 문자열로 온다 — 빈 인용 블록을 그리지 마라)
- `ErrorBanner`가 `requestId`를 화면에 노출한다 (회귀 — 삭제하지 마라)
- `ErrorBanner`의 복사 버튼이 클립보드를 호출하고, **클립보드가 없어도 던지지 않는다**
- `SERVICE_DISABLED`면 재시도 버튼이 없다
- 알 수 없는 에러 코드에도 정해진 기본 문구가 나오고 **원문이 새어나오지 않는다**
- `Badge`의 `lookup_failed` 변형이 **중립색**이고 앰버가 아니다 (ADR-005 회귀 — 삭제하지 마라)
- 모든 배지가 색 외에 **텍스트를 함께** 담는다
- `Skeleton`에 `animate-pulse`가 없다
- 안티패턴 회귀: 렌더된 클래스에 `backdrop-blur` · `bg-gradient-to` · `animate-pulse` · `rounded-2xl`이 **없다** (삭제하지 마라)

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
   - `components/`가 `services/`·`lib/proof.ts`·`lib/env.ts`를 import하지 않는가?
   - Claude 생성 텍스트가 사실과 **다른 시각 층위**로 렌더되는가? (ADR-002)
   - UI_GUIDE 안티패턴 표의 항목이 하나도 없는가?
   - 색상을 토큰 클래스로 쓰는가? (원시 hex 재입력 0건)
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/app-core/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 컴포넌트명과 props 형태를 포함하라. step 4가 그대로 쓴다)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** 실행기가 기록한다.
- **`vitest.config.ts`를 고치지 마라** (jest-dom 매처 등록 포함). 이유: `main_owned_paths`다. 표준 `expect`로 단언하라.
- **새 최상위 디렉토리를 만들지 마라**(`src/test/` 등). 이유: 소유 경계에 없는 경로가 생기면 `doctor`의 소유 검사가 깨진다. 새 최상위 디렉토리는 ADR이 먼저다 (ARCHITECTURE).
- **UI_GUIDE 안티패턴 표의 항목을 쓰지 마라.** 이유: 그 표가 금지 목록이다.
- **Claude 생성 텍스트를 사실과 같은 층위로 렌더하지 마라.** 이유: 이 프로젝트의 전제다 (ADR-002, CLAUDE.md CRITICAL).
- **`services/*` · `lib/proof.ts` · `lib/env.ts`를 import하지 마라.** 이유: 서버 전용이고 클라이언트 번들에 들어가면 안 된다.
- **화면 컴포넌트(업로드·결과·기분·추천)를 만들지 마라.** 이유: step 4와 다음 런이다.
- **`src/app/page.tsx`를 고치지 마라.** 이유: 상태 머신은 다음 런이다.
- **새 npm 의존성을 추가하지 마라.** 이유: 스택 확장은 ADR이 먼저다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · 루트의 `*.ts` · `.env*` 를 고치지 마라.** 이유: `main_owned_paths`다.
- **기존 테스트를 깨뜨리지 마라.**
