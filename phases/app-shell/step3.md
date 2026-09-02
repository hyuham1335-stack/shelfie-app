# Step 3: ui-upload — 업로드 화면 (US-001, FR-001·FR-002)

첫 행동까지의 마찰이 이 제품의 전환율을 정한다. 그리고 **거부는 전부 서로 다른 이유로 일어난다** — 그것을 한 문장으로 뭉개면 사용자는 무엇을 고쳐야 할지 모른다.

## 읽어야 할 파일

- `/docs/UI_GUIDE.md` — **전문.** 디자인 원칙 · 색상 토큰 · 버튼 · 안내 문구 표 · **안티패턴 목록**
- `/docs/PRD.md` — US-001 · 5번 Edge Cases 표(권한 거부·파노라마·중복 선택·HEIC) · 화면 인벤토리의 "업로드" 행
- `/docs/TRD.md` — TR-001(클라이언트 리사이즈), 6.1 성능 목표
- `src/lib/image.ts` — **전문.** `validateSelection` · `hashBytes` · `resizeToDataUri` · `checkOutputBudget` · `isTooSmallAfterResize` · `RejectReason` 5종
- `src/lib/image.test.ts` — **Canvas API를 어떻게 모킹했는지 먼저 읽어라.** jsdom에는 캔버스가 없다
- `src/components/common/` — `Notice` · `ErrorBanner` · `Skeleton` · `Badge`. **다시 만들지 마라**
- step 0의 `src/lib/env.ts` — `MAX_PHOTOS`(이제 환경변수를 읽는다)

## 작업

`src/components/upload/` 아래에 업로드 화면 조각을 만든다. **`fetch`를 부르지 마라** — 콜백으로 위임한다.

만들 것:

| 컴포넌트 | 역할 |
|---|---|
| `PhotoPicker` | 촬영·선택 버튼. `accept`는 `SUPPORTED_MIME_TYPES`에서 만든다 |
| `PhotoThumbnails` | 선택된 사진 썸네일(최대 `MAX_PHOTOS`)과 개별 제거 |
| `RejectedNotice` | 거부된 파일의 **사유별 문구** |
| `UploadScreen` | 위를 배치 + 촬영 팁 한 줄 + "사진은 저장되지 않아요" + 분석 CTA |

### 반드시 지킬 규칙

1. **판정 로직을 다시 만들지 마라.** `validateSelection`·`hashBytes`(중복)·`checkOutputBudget`·`isTooSmallAfterResize`가 이미 있다. 화면은 그 결과를 **문장으로 옮기기만** 한다.

2. **`RejectReason` 5종은 서로 다른 문장이다.** 무엇을 고쳐야 하는지가 각각 다르기 때문이다:

   | reason | 사용자가 할 수 있는 일 |
   |---|---|
   | `too_many` | 장수를 줄인다 |
   | `too_large` | 다른 사진을 고른다 (10MB 초과) |
   | `unsupported_type` | JPG·PNG·WEBP로 바꾼다 |
   | `duplicate` | 아무것도 안 해도 된다 — 이미 골랐다는 안내다 |
   | `decode_failed` | 사진 앱에서 JPG로 내보낸다 (HEIC일 가능성) |

   **`decode_failed`를 `unsupported_type`과 같은 문장으로 쓰지 마라.** 앞의 것은 브라우저가 못 읽은 것이고 뒤의 것은 우리가 안 받는 것이다 — 시스템 문제와 정책 문제를 뭉개는 것이며, ADR-005가 `lookup_failed`와 `no_match`에 대해 금지한 것과 같은 구조다.

3. **분석 중에는 진행 상태를 보인다.** `Skeleton`을 쓴다. `animate-pulse`는 UI_GUIDE 안티패턴이다.

4. 리사이즈는 `resizeToDataUri`로 하고, 합계가 예산을 넘으면 `checkOutputBudget` 결과로 **보내기 전에** 막는다. 413을 서버에서 받는 것은 마지막 방어선이지 설계가 아니다.

5. CTA는 확인된 장수가 1장 이상일 때만 활성화한다. 콜백은 `onAnalyze(dataUris: string[], photoCount: number)`다 — **`photoCount`가 여기서 나온다.** `analyze` 응답에는 없고, 부분 실패 배너의 분모라 뒤 단계가 반드시 받아야 한다.

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
   - `RejectReason` 5종이 **각각 다른 문장**으로 나오는가?
   - `grep -rn "fetch(" src/components/upload/` 가 0건인가?
   - `grep -rn "services/\|lib/proof\|lib/prompts" src/components/upload/` 가 0건인가?
   - UI_GUIDE 안티패턴(`backdrop-blur` · `bg-gradient-to` · `rounded-2xl` · `animate-pulse`)이 0건인가?
3. 결과에 따라 `phases/app-shell/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 **export한 컴포넌트명과 콜백 props 시그니처**를 담아라. step 5가 배선한다
   - 실패 → `"status": "error"` + `"error_message"` / 개입 필요 → `"status": "blocked"` + `"blocked_reason"`

## 금지사항

- **`fetch`를 부르거나 `lib/api-client.ts`를 import하지 마라.** 이유: 배선은 step 5다. 행동은 콜백으로 위임한다
- **`services/*` · `lib/proof.ts`를 import하지 마라.** 이유: 서버 전용 모듈이다 (ARCHITECTURE)
- **파일 검증·리사이즈 판정을 다시 구현하지 마라.** 이유: `lib/image.ts`가 이미 하고, 두 벌이 되면 반드시 갈라진다
- **`decode_failed`와 `unsupported_type`을 같은 문장으로 쓰지 마라.** 이유: 위 참조
- **`src/lib/`을 고치지 마라.** 이유: step 0·1·2가 확정했다. 결함은 `summary`로 보고하라
- **`src/app/page.tsx`를 고치지 마라.** 이유: step 5다
- **`vitest.config.ts`·`vitest.setup.ts`를 고치지 마라.** 이유: `main_owned_paths`다. jest-dom 매처와 RTL cleanup은 **이미 등록돼 있다** — 파일마다 `afterEach(cleanup)`을 다시 부르지 마라
- **UI_GUIDE 안티패턴을 쓰지 마라**
- **새 최상위 디렉토리를 만들지 마라.** 이유: 소유 경계 밖 경로가 생기면 `doctor`가 깨진다
- **`index.json`의 실행기 소유 필드와 `RUNNING` 파일을 건드리지 마라**
- 새 npm 의존성을 추가하지 마라 (HEIC 폴리필 포함 — PRD Q3에서 명시적으로 배제했다)
- 기존 테스트를 깨뜨리지 마라
