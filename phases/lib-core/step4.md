# Step 4: image — 파일 검증과 전송 전 축소 (TR-001)

## 읽어야 할 파일

- `/docs/PRD.md` — **FR-001 (업로드 제한) · FR-002 (전송 전 축소)** 가 이 step의 계약이다. 5번 Edge Cases 표도 함께 읽어라
- `/docs/TRD.md` — 3번 표의 TR-001 행 (엣지 케이스가 길다. 전부 읽어라), 6.1 성능, 8번 테스트 전략
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계. **`lib/image.ts`만 브라우저 API(Canvas)에 의존하며 서버 코드에서 import하지 않는다**
- `/docs/ADR.md` — ADR-001 (이미지 토큰 예측 가능성)
- `src/lib/schemas.ts` — `imageDataUriSchema`
- `src/lib/env.ts` — `MAX_PHOTOS`(5)

## 작업

`src/lib/image.ts`를 새로 만든다. 사용자가 고른 파일을 검증하고, 전송 전에 클라이언트에서 축소한다.

### 규칙 (FR-001 · FR-002 · TR-001)

**검증**
- 1~5장(`MAX_PHOTOS`). 6장 이상이면 차단
- 장당 원본 10MB 이하. 초과한 **개별 파일만** 제외하고 나머지는 진행한다 (전체 차단이 아니다)
- `image/jpeg` · `image/png` · `image/webp`만 허용. 그 외 MIME은 거부
- 같은 파일을 두 번 고르면 **해시로 중복 제거**
- HEIC는 캔버스 디코드를 시도하고 실패하면 **명시적으로 거부**한다 (조용히 무시하지 않는다)

**축소**
- **EXIF orientation을 적용해 정립시킨 뒤** 긴 변 1568px로 리사이즈. 회전 보정을 빠뜨리면 세로 사진이 누워 판독률이 급락하므로 **테스트로 고정**한다
- JPEG 품질 0.85로 인코딩, base64 data URI 반환
- 산출물은 **장당 2MB · 요청 합계 4MB 이하**
- 리사이즈 후 **짧은 변이 600px 미만**이면(파노라마·초고해상도) 책등 글자가 판독 불가 수준이므로 **경고**하고 나눠 찍도록 안내한다. 차단이 아니라 경고다

### 구조 — 이 지시를 반드시 따르라

`vitest.config.ts`의 test environment는 `jsdom`인데 **jsdom은 canvas 렌더링을 구현하지 않는다.** 그래서 다음과 같이 나눈다.

1. **DOM에 손대지 않는 순수 함수**로 최대한 분리한다. 여기서 테스트 대부분이 닫힌다.
   - 장수·크기·MIME 검증
   - 중복 판정 (해시 계산은 바이트 배열을 받는 함수로)
   - 목표 치수 계산 (원본 w/h → 긴 변 1568 기준 결과 치수)
   - 짧은 변 600px 미만 경고 판정
   - 산출물 크기 상한(2MB/4MB) 검사
2. **실제 캔버스 인코딩 경로**는 얇게 유지하고, 테스트에서는 `createImageBitmap` · `HTMLCanvasElement.prototype.toBlob` 등을 `vi.stubGlobal` / `vi.spyOn`으로 대체해 검증한다.

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
export const MAX_LONG_EDGE = 1568;
export const MIN_SHORT_EDGE = 600;
export const JPEG_QUALITY = 0.85;
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_BYTES_PER_IMAGE = 2 * 1024 * 1024;
export const MAX_OUTPUT_BYTES_TOTAL = 4 * 1024 * 1024;

export type RejectReason =
  | "too_many"
  | "too_large"
  | "unsupported_type"
  | "duplicate"
  | "decode_failed";

/** 순수 — 파일 메타데이터만 보고 판정한다 */
export function validateSelection(
  files: readonly { name: string; type: string; size: number; hash: string }[],
): { accepted: ...[]; rejected: Array<{ index: number; reason: RejectReason }> };

/** 순수 — 목표 치수 계산 */
export function targetDimensions(width: number, height: number): { width: number; height: number };

/** 순수 — 짧은 변 경고 */
export function isTooSmallAfterResize(width: number, height: number): boolean;

/** DOM 의존 — 얇게 유지한다 */
export async function resizeToDataUri(file: File): Promise<string>;
```

### 테스트 (먼저 작성한다)

`src/lib/image.test.ts`.

- 6장 선택 시 6번째가 `too_many`로 거부되고 앞 5장은 통과한다
- 10MB 초과 파일 **하나만** 제외되고 나머지는 통과한다 (전체 차단이 아님)
- `image/gif` · `image/heic`는 `unsupported_type`으로 거부된다
- 같은 해시 파일이 두 번 들어오면 두 번째가 `duplicate`
- 3000x2000 → 긴 변 1568 기준 치수가 정확히 계산된다 (세로 사진 2000x3000도)
- 이미 1568 이하인 이미지는 확대하지 않는다
- 짧은 변 600px 미만이 경고 판정을 받는다 (경계값: 599 / 600)
- **EXIF orientation 6(90도 회전)인 이미지가 정립된 치수로 나온다** — 이 테스트는 삭제하지 마라. TR-001이 "회전 보정을 테스트로 고정한다"고 명시한 항목이다
- 캔버스 디코드가 실패하면 `decode_failed`로 명시적으로 거부된다 (예외가 그대로 새어 나가지 않는다)

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
   - `image.ts`가 서버 코드(`app/api/`·`services/`)에서 import되지 않는가?
   - 순수 함수와 DOM 의존 함수가 분리돼 있는가?
   - **새 의존성이 추가되지 않았는가?** (`package.json`을 `git diff`로 확인하라)
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/lib-core/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(생성한 파일과 export한 함수명)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용 — 특히 jsdom 캔버스 제약 때문이면 그 사실을 명시하라"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **새 npm 의존성을 절대 추가하지 마라.** `canvas` · `node-canvas` · `jsdom` 확장 · `exif-js` · `sharp` 같은 패키지를 설치하지 마라. 이유: `/docs/ADR.md`와 `/docs/TRD.md` 2번이 정한 스택을 벗어나려면 ADR을 먼저 써야 한다 (CLAUDE.md CRITICAL). jsdom이 캔버스를 렌더하지 못하는 것은 **모킹으로 푸는 문제이지 의존성으로 푸는 문제가 아니다.**
- **`vitest.config.ts`의 `environment`나 `include`를 바꾸지 마라.** 이유: 설정 파일은 `main_owned_paths`에 속하고, 테스트 환경을 바꾸면 기존 테스트 전체의 전제가 달라진다. 테스트가 환경 때문에 안 된다면 그것은 `blocked` 사유이지 설정을 고칠 근거가 아니다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` 를 고치지 마라.** 이유: `main_owned_paths`가 메인 에이전트 단독 소유로 정한 곳이다.
- **`src/services/`나 `src/app/api/`를 만들거나 import하지 마라.** 이유: 레이어 경계이고 이번 파일럿 범위 밖이다.
- **EXIF 회전 보정을 생략하지 마라.** 이유: 세로 사진이 누워 들어가면 판독률이 급락한다. TR-001이 테스트로 고정하라고 명시한 항목이다.
- **이전 step이 만든 파일(`proof.ts` · `analytics.ts` · `match.ts` · `merge.ts`)을 수정하지 마라.** 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **기존 테스트를 깨뜨리지 마라.**
