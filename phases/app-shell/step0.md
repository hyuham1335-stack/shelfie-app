# Step 0: contracts-debt — 세 런째 이월된 계약 부채를 정리한다

이 step은 **이전 런들이 보고만 하고 고치지 못한 것**을 받는다. 런 #2·#3·#4의 step들이 세 번 올렸고, 그때마다 step 파일의 금지사항이 `src/lib/` 수정을 막아 설계 단계에서 이미 불가능했다. **이번에는 고치는 것이 이 step의 목적이다.**

문서 쪽(`docs/**` · `vitest.config.ts`)은 **이미 갱신돼 있다.** 네가 할 일은 코드를 그 문서에 맞추는 것이다.

## 읽어야 할 파일

- `/docs/API_SPEC.md` — **에러 응답 규약 절 전문.** 방금 `INTERNAL_ERROR`(500) 자리가 열렸다. 500과 502를 왜 나누는지 함께 읽어라
- `/docs/UI_GUIDE.md` — 안내 문구 표. `unidentifiedOverflowCount` 문구가 새로 들어왔다
- `/docs/TRD.md` — 7번(환경변수), 10번 병목 표
- `/docs/ADR.md` — ADR-005(실패와 데이터 없음의 분리)
- `src/lib/env.ts` — 상수 전부. `MAX_PHOTOS`가 하드코딩돼 있다
- `src/lib/image.ts` — `MAX_OUTPUT_BYTES_PER_IMAGE`·`MAX_OUTPUT_BYTES_TOTAL`
- `src/app/api/analyze/route.ts` — **58~59행의 로컬 상수 2개**와 **62행 `ERROR_MESSAGES`**, 그리고 **267행 부근** "응답이 계약 스키마를 어겼습니다" 분기
- `src/lib/schemas.ts` — `errorCodeSchema`
- `src/components/common/ErrorBanner.tsx` — 여기에도 `Record<ErrorCode, string>` 맵이 있다
- `src/components/booklist/BookList.tsx` — "50권까지만" 문구
- `src/components/**/*.test.tsx` 아무거나 한 개 — 지금의 `afterEach(cleanup)` 패턴

## 작업

### A. `NEXT_PUBLIC_MAX_PHOTOS`를 실제로 읽는다

`src/lib/env.ts`의 `MAX_PHOTOS`가 `.env.example`에 선언된 `NEXT_PUBLIC_MAX_PHOTOS`를 무시하고 `5`로 박혀 있다. 환경변수를 읽되 **상한은 코드가 지킨다**:

```ts
const MAX_PHOTOS_CEILING = 5;   // FR-001. 환경변수가 넓힐 수 없다
export const MAX_PHOTOS: number = /* NEXT_PUBLIC_MAX_PHOTOS 를 파싱해 [1, CEILING] 로 클램프 */;
```

값이 없거나 숫자가 아니면 `MAX_PHOTOS_CEILING`으로 떨어진다. `NEXT_PUBLIC_` 값은 빌드 타임에 치환되므로 **정적 참조**(`process.env.NEXT_PUBLIC_MAX_PHOTOS`)로 써야 한다 — 계산된 키로 접근하면 Next가 치환하지 못한다.

### B. 이미지 크기 상수를 한 곳으로 모은다

같은 2MB·4MB가 `lib/image.ts`(브라우저용)와 `analyze/route.ts`(서버용)에 각각 정의돼 있다. `src/lib/env.ts`로 옮기고 두 곳이 그것을 쓴다. `lib/image.ts`의 기존 이름은 **재수출로 유지**한다 — 지우면 `image.test.ts`가 깨진다.

`MAX_SOURCE_BYTES`(10MB, 브라우저 전용 입력 상한)는 옮기지 않는다. 서버가 쓰지 않는 값이다.

### C. `INTERNAL_ERROR`를 추가한다

`errorCodeSchema`에 `INTERNAL_ERROR`를 넣는다. **`Record<ErrorCode, string>` 맵 두 곳이 즉시 컴파일 실패한다** — `analyze/route.ts`의 `ERROR_MESSAGES`와 `ErrorBanner.tsx`의 맵이다. 둘 다 채워라. 문구는 API_SPEC·UI_GUIDE를 따라 502와 같은 것을 쓴다:

> "문제가 생겨 중단했어요. 잠시 후 다시 시도해 주세요."

그리고 **`analyze/route.ts`의 "응답이 계약 스키마를 어겼습니다" 분기를 502에서 500 `INTERNAL_ERROR`로 옮긴다.** 그 자리 주석이 이미 "정의된 코드 중 그 상황을 가장 덜 왜곡하는 것이 502다"라고 적고 있다 — 이제 왜곡하지 않는 코드가 생겼으므로 주석도 함께 고쳐라. 다른 라우트에도 같은 "우리 응답이 우리 스키마를 어겼다" 분기가 있으면 똑같이 옮긴다.

**502를 전부 500으로 바꾸는 것이 아니다.** 외부 API 장애는 502 그대로다. 바뀌는 것은 **우리 응답이 우리 계약을 어긴 경우**뿐이다.

### D. `BookList`의 하드코딩과 빠진 안내

- "50권까지만"의 `50`을 `MAX_IDENTIFIED_BOOKS` import로 바꾼다. `lib/env.ts`는 A 이후에도 클라이언트에서 import 가능해야 한다 — 모듈 최상위에서 `throw`하지 마라
- `unidentifiedOverflowCount > 0`이면 미확인 섹션 하단에 `Notice`를 그린다. 문구는 UI_GUIDE의 표를 **그대로** 쓴다

### E. 중복 `afterEach(cleanup)` 제거

`vitest.setup.ts`가 이미 jest-dom 매처와 RTL cleanup을 전역으로 건다. 컴포넌트 테스트 파일들의 **파일 상단 `afterEach(cleanup)` 한 줄만** 지운다. 테스트 본문 안에서 중간에 부르는 `cleanup()`은 그대로 두어라 — 한 테스트에서 여러 번 렌더하려고 일부러 부른 것이다.

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
   - `grep -rn "2 \* 1024 \* 1024\|4 \* 1024 \* 1024" src/` 가 `lib/env.ts` 한 곳만 잡는가?
   - 외부 API 장애 경로가 여전히 502인가? (500으로 뭉개면 남의 장애를 우리 결함으로 기록한다 — 이번 수정이 고치려는 오귀속의 정반대)
   - `MAX_PHOTOS`가 환경변수 없이도 5인가? 6을 넣어도 5로 클램프되는가?
3. 결과에 따라 `phases/app-shell/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 산출물 한 줄 요약 (**옮긴 상수의 새 이름과 export 위치를 반드시 포함하라** — step 2~5가 그것을 쓴다)
   - 수정 시도 후에도 실패 → `"status": "error"` + `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"` + `"blocked_reason"` 후 즉시 중단

## 금지사항

- **`src/lib/env.ts`·`schemas.ts`·`image.ts`를 고쳐라. 이것이 이 step의 목적이다.** 세 런 동안 "고치지 마라"가 목표와 어긋나 있었다
- **`docs/**` · `.env*` · 리포 루트의 `*.ts`(`vitest.config.ts` 포함)를 고치지 마라.** 이유: `main_owned_paths`다. 이 부채의 문서 쪽은 이미 처리됐으니 **다시 보고하지도 마라**
- **`src/app/page.tsx`를 만들거나 고치지 마라.** 이유: step 5다
- **`MAX_PHOTOS_CEILING`을 환경변수로 만들지 마라.** 이유: 환경변수 하나로 서버 상한이 넓어지면 FR-001이 방어가 아니게 된다
- **`lib/env.ts`에 모듈 최상위 부수효과(`throw` 등)를 넣지 마라.** 이유: 클라이언트가 상수를 import하는데 최상위에서 던지면 화면이 통째로 죽는다
- **새 에러 코드를 `INTERNAL_ERROR` 말고 더 만들지 마라.** 이유: 클라이언트 동작이 같은데 코드를 나누면 두 경로 중 하나는 반드시 덜 검증된다 (API_SPEC의 기존 판단)
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (`started_at`·`completed_at`·`failed_at`·`blocked_at`·`created_at`·`attempts`). `RUNNING` 파일도 읽지도 지우지도 마라
- 새 npm 의존성을 추가하지 마라
- 기존 테스트를 깨뜨리지 마라
