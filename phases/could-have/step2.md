# Step 2: share-render

## 읽어야 할 파일

- `/docs/PRD.md` — 4번 FR-014, 데이터 요구사항의 "보관 기간 0"
- `/docs/UI_GUIDE.md` — "저장 이미지 (추천 결과 PNG — FR-014)" 절
- `/docs/ARCHITECTURE.md` — 레이어 의존 규칙 중 `lib/share-image.ts` 항목
- `/docs/ADR.md` — **ADR-009**(그리기 층은 판단하지 않는다 · 표지는 offscreen 으로 따로 받는다), ADR-003(만든 이미지를 저장하지 않는다)

아래 소스는 **접두부에 이미 첨부돼 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

- `src/lib/share-image.ts` · `src/lib/share-image.test.ts` — step 1 이 만든 레이아웃 층
- `src/components/booklist/BookCover.tsx` — 표지 실패를 폴백으로 흡수하는 기존 규율

## 작업

`src/lib/share-image.ts` 에 **그리기 층**을 붙인다. step 1 의 레이아웃 층은 그대로 두고, 그것이 만든 명령 목록을 캔버스에 적용해 PNG `Blob` 을 돌려주는 함수를 더한다.

### 공개 API (시그니처 수준)

```ts
export interface RenderShareImageOptions {
  /** 캔버스를 만드는 방법. 기본은 document.createElement("canvas") */
  createCanvas?: () => HTMLCanvasElement;
  /** 표지 한 장을 불러온다. 실패하면 reject 또는 null — 어느 쪽이든 저장은 계속된다 */
  loadImage?: (src: string) => Promise<CanvasImageSource | null>;
}

export async function renderShareImage(
  books: readonly ShareImageBook[],
  options?: RenderShareImageOptions,
): Promise<Blob>;
```

### 규칙

- **이 층은 판단하지 않는다.** 좌표·줄바꿈·잘림은 전부 `buildShareImageLayout` 이 이미 정했다. 여기서 `if` 로 위치를 조정하기 시작하면 그 판단은 테스트되지 않는 곳으로 옮겨간 것이다 (ADR-009)
- **`measure` 는 `ctx.measureText` 를 넘긴다.** 레이아웃 층이 요구하는 측정기가 여기서 채워진다 — 그래야 실제 글꼴 폭으로 잘린다
- **표지는 화면의 `<img>` 를 재사용하지 마라. 별도로 불러라.** 기본 `loadImage` 는 새 `Image` 를 만들고 **`crossOrigin = "anonymous"` 를 설정한 뒤** `src` 를 지정한다.
  - **이유(중요)**: 화면의 `BookCover` 에 `crossOrigin` 을 붙이면 CORS 헤더를 주지 않는 호스트의 표지가 **화면에서도 안 뜬다.** 지금 잘 뜨는 표지를 저장 기능 때문에 잃는 것은 명백한 회귀다. `crossOrigin` 없이 그린 이미지는 캔버스를 오염시켜(tainted) `toBlob` 이 SecurityError 로 실패하므로, 저장용은 따로 받는 것 말고 다른 답이 없다
  - **`src/components/booklist/BookCover.tsx` 를 고치지 마라** (아래 금지사항)
- **표지를 못 얻어도 저장은 성공한다.** 로드 실패·거부·`null` 어느 쪽이든 그 책만 step 1 이 정한 폴백(제목 첫 글자 블록)으로 그리고 계속 진행한다. **저장 전체를 실패시키지 마라. 이유**: 표지는 이 그림의 목적이 아니다. `BookCover` 가 "표지 없음과 로드 실패를 같은 폴백으로 흡수한다"고 정한 것과 같은 규율이다
- 표지 3장은 **함께 기다린다**(순차로 하나씩 기다리면 저장이 눈에 띄게 느려진다). 한 장의 실패가 나머지를 무너뜨리지 않게 하라
- `toBlob` 이 `null` 을 주면 그때는 **실패로 다룬다** — 부분적으로 그려진 캔버스를 성공으로 돌려주지 마라
- 만든 `Blob` 을 서버로 보내거나 저장하지 마라. 이 함수는 값을 돌려줄 뿐이다 (ADR-003). 다운로드 배선은 step 3 이다
- `getContext("2d")` 가 `null` 이면 명확한 에러로 실패한다. 조용히 빈 `Blob` 을 돌려주지 마라

### 테스트

TDD 다. **jsdom 에는 canvas 구현이 없으므로 진짜 캔버스로 검증하려 들지 마라** — 그것이 이 설계가 존재하는 이유다. `createCanvas` 와 `loadImage` 를 주입해 가짜로 검증한다.

최소한 아래를 고정한다.

- 레이아웃이 만든 명령이 **하나도 빠짐없이, 그 순서대로** `ctx` 에 적용된다 (가짜 `ctx` 의 호출 기록으로 단정)
- `measure` 로 `ctx.measureText` 가 실제로 넘어간다
- 기본 `loadImage` 가 아니라 주입된 것을 쓴다
- **표지 로드가 실패해도 `Blob` 이 나온다** — 그리고 그 책 자리에 폴백 명령이 적용된다
- 표지 3장 중 1장만 실패해도 나머지 2장은 그려진다
- `toBlob` 이 `null` 이면 reject 한다
- 성공 경로에서 `Blob` 의 타입이 `image/png` 다
- step 1 의 레이아웃 테스트가 하나도 깨지지 않는다

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
   - 그리기 층이 좌표를 스스로 결정하지 않는가? (판단은 전부 레이아웃 층에 있어야 한다)
   - 새 npm 의존성이 0건인가?
   - `lib/` → `services/` 금지를 지켰는가?
3. 결과에 따라 `phases/could-have/index.json` 의 step 2 를 업데이트한다 (성공 → `completed` + `summary`, 실패 → `error` + `error_message`, 개입 필요 → `blocked` + `blocked_reason`).

`summary` 에는 **`renderShareImage` 의 최종 시그니처와 표지 실패 시 동작, 주입 지점 이름**을 적어라. step 3 이 이 함수를 화면에 잇는다.

## 금지사항

- **`src/components/booklist/BookCover.tsx` 를 고치지 마라. 이유**: 화면의 표지에 `crossOrigin` 을 붙이면 CORS 헤더 없는 호스트의 표지를 화면에서 잃는다. 저장용 이미지는 따로 받는다 (ADR-009)
- **`src/components/**` · `src/app/**` 를 고치지 마라. 이유**: 화면 배선은 step 3 이다
- **step 1 의 레이아웃 층 시그니처를 바꾸지 마라. 이유**: 바꿔야 한다고 판단되면 바꾸지 말고 `summary` 에 적어 보고하라. 두 층의 경계가 이 설계의 전부다
- **새 npm 패키지를 넣지 마라** (특히 `canvas`·`html2canvas`). 이유: ADR-009 가 명시적으로 거부했다
- **`docs/**` 를 고치지 마라.** 이유: 메인 소유다
- **`index.json` 의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`)
- **`RUNNING` 파일을 읽지도 지우지도 마라.**
- 기존 테스트를 깨뜨리지 마라
