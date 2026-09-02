# Step 1: share-layout

## 읽어야 할 파일

- `/docs/PRD.md` — 4번 FR-014(추천 결과 이미지 저장), 데이터 요구사항의 "보관 기간 0"
- `/docs/UI_GUIDE.md` — "저장 이미지 (추천 결과 PNG — FR-014)" 절, "Claude 생성 텍스트 블록", 색상표, "AI 슬롭 안티패턴"
- `/docs/ARCHITECTURE.md` — 레이어 의존 규칙 중 `lib/share-image.ts` 항목
- `/docs/ADR.md` — **ADR-009**(캔버스로 직접 그린다 · 레이아웃과 그리기를 가른다 · 측정 함수 주입), ADR-002(사실과 해석), ADR-003(무상태)

아래 소스는 **접두부에 이미 첨부돼 있다. 다시 읽지 마라.**

- `src/types/book.ts` · `src/types/api.ts` — 입력이 될 도메인 타입
- `src/lib/env.ts` — 도메인 상수의 단일 출처

## 작업

`src/lib/share-image.ts` 를 **새로 만든다.** 이 step 이 만드는 것은 **레이아웃 층뿐**이다 — 캔버스를 만들지도, `document` 를 만지지도, 이미지를 그리지도 않는다. 그리기는 step 2 가 같은 파일에 붙인다.

### 왜 가르는가 (여기를 이해하지 못하면 이 step 은 실패한다)

이 리포의 테스트는 jsdom 에서 돌고 **jsdom 에는 canvas 구현이 없다.** `getContext("2d")` 가 쓸 수 있는 컨텍스트를 주지 않으므로, 그리기와 판단이 한 덩어리면 "테스트를 먼저 쓴다"(CLAUDE.md CRITICAL)가 성립하지 않는다. 그래서 **좌표·줄바꿈·잘림·크기를 결정하는 판단을 전부 캔버스 밖으로 뺀다.** 이 층은 값을 넣으면 값이 나오는 평범한 순수 함수이고, 그래서 단정으로 고정할 수 있다 (ADR-009).

### 공개 API (시그니처 수준 — 내부 구현은 네 재량이다)

```ts
/** 저장 이미지에 그릴 책 한 권. 화면 타입을 그대로 받지 않고 필요한 것만 좁힌다 */
export interface ShareImageBook {
  title: string;
  author: string;
  publisher: string;
  coverUrl: string;
  /** Claude 가 쓴 추천 이유 — 사실이 아니다 */
  reason: string;
  position: 1 | 2 | 3;
}

/** 그리기 층이 그대로 실행할 명령. 판단은 전부 여기 들어오기 전에 끝나 있다 */
export type DrawCommand =
  | { kind: "rect"; x: number; y: number; width: number; height: number; color: string }
  | { kind: "text"; x: number; y: number; text: string; font: string; color: string }
  | { kind: "image"; x: number; y: number; width: number; height: number; src: string }
  ;
// 필요하면 명령 종류를 더 만들어도 된다(세로선 등). 다만 각 명령은 **좌표가 확정된 상태**여야 한다.

/** 글자 폭 측정기. 그리기 층이 ctx.measureText 를 넘긴다 */
export type MeasureText = (text: string, font: string) => number;

export interface ShareImageLayout {
  width: number;
  height: number;
  commands: readonly DrawCommand[];
}

export function buildShareImageLayout(
  books: readonly ShareImageBook[],
  measure: MeasureText,
): ShareImageLayout;
```

### 규칙

- **폭을 직접 계산하지 마라. `measure` 로만 재라. 이유**: 캔버스는 CSS 폰트 스택을 쓰지 않고 한글 글꼴은 로딩 시점에 따라 글자 폭이 달라진다. 글자 수 × 상수로 재면 화면마다 다른 곳에서 잘린다. 그리고 `measure` 를 주입받는 것이 이 층이 순수 함수일 수 있는 **유일한 조건**이다 (ADR-009)
- **캔버스 높이는 내용에 따라 결정된다.** 고정 높이로 잘라 내지 마라 — 3권일 때와 1권일 때 아래가 비거나 잘린다
- **긴 제목·저자·이유는 말줄임(`…`)으로 자른다.** 넘쳐서 잘린 글자가 그대로 나가면 안 된다 (UI_GUIDE 저장 이미지 표)
- **추천 이유는 다른 시각 층위로 그린다.** UI_GUIDE 의 규칙(왼쪽 세로선 + 들여쓰기 + 보조 텍스트 색 + "추천 이유" 라벨)을 명령으로 표현한다. **이 구분이 없으면 Claude 가 쓴 문장이 서지 사실처럼 읽히고, 그 그림은 우리 손을 떠나 유통된다** (ADR-002)
- 색·폭·톤은 UI_GUIDE 의 값을 쓴다. 안티패턴 표가 그대로 적용된다 — 그라데이션·글로우·장식 없음
- 표지 자리는 **명령으로만** 잡는다. 이미지를 실제로 불러오는 것은 step 2 다. 표지를 못 그리는 경우의 폴백(제목 첫 글자 블록)도 이 층이 명령으로 표현할 수 있어야 한다 — 그 분기를 어떤 형태로 표현할지는 네가 정하되, **step 2 가 "표지 실패"를 알았을 때 레이아웃을 다시 계산하지 않아도 되게** 하라

### 상수를 어디에 두는가

- **저장 이미지의 레이아웃 규격(캔버스 폭·여백·글꼴 크기·줄 높이)은 이 파일 안에 둔다.** 이유: 이것은 도메인 상한이 아니라 이 모듈의 렌더 규격이고, 환경변수로 좁힐 수 있는 값도 아니다. `lib/env.ts` 는 "권수·장수·크기·횟수 **상한**"의 자리다
- **이미 `lib/env.ts` 에 있는 값을 다시 적지 마라.** 추천 권수 상한은 `MAX_RECOMMENDATIONS` 다 — 3 을 리터럴로 박지 말고 import 하라 (CLAUDE.md 상수 단일 출처)
- `lib/env.ts` 에서 가져오는 것은 **상수뿐**이다. 서버 전용 접근자(`getAnthropicApiKey` 등)를 부르지 마라

### 테스트

TDD 다. 먼저 실패하는 테스트를 쓰고 통과시켜라. 이 층은 순수 함수이므로 **값으로 전부 단정할 수 있다** — 고정 폭 측정기(예: 글자당 10px 을 돌려주는 가짜 `measure`)를 써서 좌표를 결정적으로 만들어라.

최소한 아래를 고정한다.

- 같은 입력 + 같은 측정기 → **완전히 같은 `commands`** (결정성)
- 3권 / 1권 / 0권에서 `height` 가 다르고, 0권에서도 던지지 않는다
- 아주 긴 제목이 말줄임으로 잘리고 `…` 로 끝난다
- 추천 이유가 책 사실과 **다른 명령 조합**으로 표현된다 (색·들여쓰기·세로선 중 무엇으로 가르든, "사실과 같은 모양이 아니다"를 단정하라)
- `measure` 가 실제로 호출된다 (글자 수 × 상수로 대체하지 않았다는 회귀 방어)
- `document` · `HTMLCanvasElement` 를 만지지 않는다 — jsdom 없이도 통과해야 한다

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
   - `lib/` → `services/` 금지를 지켰는가?
   - 새 npm 의존성이 0건인가?
   - 이 파일이 `document`·`canvas` 를 만지지 않는가?
3. 결과에 따라 `phases/could-have/index.json` 의 step 1 을 업데이트한다 (성공 → `completed` + `summary`, 실패 → `error` + `error_message`, 개입 필요 → `blocked` + `blocked_reason`).

`summary` 에는 **정확한 export 시그니처와 `DrawCommand` 의 최종 형태, 표지 폴백을 어떤 명령으로 표현했는지**를 적어라. step 2 가 그것을 그대로 소비한다.

## 금지사항

- **`document` · `window` · `HTMLCanvasElement` 를 만지지 마라. 이유**: 이 층이 순수해야 jsdom 없이 검증되고, 그것이 이 분리의 목적 전부다 (ADR-009)
- **PNG 를 만들거나 `toBlob` 을 부르지 마라. 이유**: step 2 의 일이다. 여기서 하면 이 step 의 테스트가 jsdom canvas 부재에 걸린다
- **`src/components/**` · `src/app/**` 를 고치지 마라. 이유**: 화면 배선은 step 3 이다
- **`src/lib/env.ts` 에 저장 이미지 규격 상수를 추가하지 마라. 이유**: 위 "상수를 어디에 두는가"를 본다. `env.ts` 는 도메인 **상한**의 자리다
- **새 npm 패키지를 넣지 마라** (특히 `canvas`·`html2canvas`·`dom-to-image`). 이유: ADR-009 가 명시적으로 거부한 선택지다
- **`docs/**` 를 고치지 마라.** 이유: 메인 소유다
- **`index.json` 의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`)
- **`RUNNING` 파일을 읽지도 지우지도 마라.**
- 기존 테스트를 깨뜨리지 마라
