# Step 0: golden-manifest

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ARCHITECTURE.md` — 검증 경계 패턴, 레이어 의존 관계, `lib/golden-*.ts` 노드 3개
- `/docs/ADR.md` — **ADR-010**(골든 세트를 리포 밖에 두는 결정과 판정 규약)이 이 step의 근거다. ADR-002도 본다
- `/docs/TRD.md` — **8번의 "골든 인식률 계약" 절이 이 step의 계약이다.** 매니페스트 형식이 거기 있다. 4번 환경변수 표의 `GOLDEN_SET_DIR`도 본다
- `src/lib/schemas.ts` — zod 스키마 작성 관행. 이 리포가 스키마를 어떻게 쓰는지가 여기 있다
- `src/lib/env.ts` — 도메인 상수 단일 출처. 임계값 두 개가 여기로 들어간다
- `src/types/book.ts` — 타입을 스키마에서 파생시키는 방식(`z.infer`)

위 소스 파일은 **프롬프트에 이미 실려 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

## 작업

골든 인식률 세트의 **매니페스트 계약**을 만든다. 이 step은 순수 모듈 하나와 상수 두 개만 만든다 — 파일 시스템도 외부 API도 만지지 않는다.

### 1. `src/lib/env.ts`에 임계 상수 2종

TRD 8번 판정 규약 표의 두 값이다. 도메인 상수는 `env.ts` 한 곳에서만 정의한다(CLAUDE.md).

```ts
/** 골든 인식률의 재현율 하한 (TR-003 · ADR-010) */
export const GOLDEN_MIN_RECALL = 0.9;

/** 골든 세트에서 허용되는 오확인 건수 (TR-004 · ADR-010) */
export const GOLDEN_MAX_MISIDENTIFIED = 0;
```

`GOLDEN_SET_DIR`을 읽는 **접근자도 여기에 둔다.** 다른 서버 전용 접근자(`getAnthropicApiKey`)와 같은 형태로 만들고, 값이 없거나 공백이면 `null`을 돌려준다. 던지지 마라 — 세트가 없는 것은 오류가 아니라 skip 사유다.

### 2. `src/lib/golden-manifest.ts` (신규)

TRD 8번의 매니페스트 형식을 zod 스키마로 옮기고, 파싱 함수를 만든다.

```ts
export const goldenExpectedBookSchema = /* title(1자 이상) · author(1자 이상) · isbn13(선택, 13자리 숫자) */;
export const goldenPhotoSchema        = /* file(1자 이상) · sha256(64자리 hex) · books(1건 이상) */;
export const goldenManifestSchema     = /* version(양의 정수) · setId(1자 이상) · photos(1건 이상) */;

export type GoldenExpectedBook = z.infer<typeof goldenExpectedBookSchema>;
export type GoldenPhoto        = z.infer<typeof goldenPhotoSchema>;
export type GoldenManifest     = z.infer<typeof goldenManifestSchema>;

/** 이 코드가 이해하는 매니페스트 형식 버전. 스키마를 바꿀 때 함께 올린다 */
export const GOLDEN_MANIFEST_VERSION = 1;

export type ParseGoldenManifestOutcome =
  | { status: "ok"; manifest: GoldenManifest }
  | { status: "failed"; reason: GoldenManifestFailureReason; detail: string };

/** 원시 값(JSON.parse 결과)을 매니페스트로 판정한다. **던지지 않는다** */
export function parseGoldenManifest(raw: unknown): ParseGoldenManifestOutcome;
```

핵심 규칙 — 어기면 이 모듈의 존재 이유가 사라진다:

1. **던지지 마라.** 파싱 실패는 예외가 아니라 판별 가능한 실패 값이다(ARCHITECTURE 검증 경계 패턴). 호출부는 이 실패를 **skip 사유**로 바꿔야 하는데, 예외로 던지면 그것이 테스트 실패가 되고 "세트가 잘못됐다"와 "모델이 나빠졌다"가 같은 빨간불이 된다.
2. **`detail`에 무엇이 왜 틀렸는지 남겨라.** TRD 8번 skip 표가 "파싱 실패는 사유 문자열에 이유를 남긴다"고 못 박았다. zod의 `error.issues`를 사람이 읽을 수 있는 한 줄로 접어라. 세트는 리포 밖에 있어 다른 사람이 고쳐야 하고, 그 사람이 가진 단서는 이 문자열뿐이다.
3. **사유를 뭉개지 마라.** `GoldenManifestFailureReason`을 최소 두 종으로 가른다 — `schema`(형식이 계약을 어겼다)와 `version`(우리가 모르는 형식 버전이다). 둘은 사람이 할 일이 다르다: 앞은 매니페스트를 고치는 것이고 뒤는 코드를 올리는 것이다. 이 리포가 `lookup_failed`와 `no_match`를 끝까지 다른 값으로 나르는 것과 같은 규율이다(ADR-005).
4. **`version`이 `GOLDEN_MANIFEST_VERSION`보다 크면 `version` 실패로 거부한다.** 모르는 형식을 아는 척 파싱하면 없는 필드가 조용히 빠진 채 재현율이 계산된다.
5. `books[].isbn13`은 **선택**이다. 필수로 만들지 마라 — TRD 8번이 "20장 전부에 ISBN을 적는 것은 부담이므로 강제하지 않는다"고 정했다. 다만 **있으면 13자리 숫자여야 한다.**
6. `photos[].sha256`은 **필수**다. 세트가 버전 관리 밖에 있어(ADR-010) 리포트가 입력을 특정할 유일한 수단이다.

### 3. `src/lib/golden-manifest.test.ts`

TDD다 — 테스트를 먼저 쓰고 통과하는 구현을 쓴다(CLAUDE.md CRITICAL).

최소한 이것들을 덮어라: 정상 매니페스트 통과 · `version`이 미래값이면 `version` 실패 · 형식 위반 각각이 `schema` 실패이고 `detail`이 비어 있지 않음 · `isbn13` 없는 책도 통과 · `isbn13`이 12자리면 거부 · `photos`가 빈 배열이면 거부 · `raw`가 `null`·문자열·배열이어도 던지지 않음.

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run audit
```

다섯 줄이 한 세트다 (TRD 8번). 하나라도 빼지 마라.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - `lib/golden-manifest.ts`가 `services/`·`fs`·`process.env`를 import하지 않는가? (순수 모듈이어야 한다 — ARCHITECTURE 레이어 규칙)
   - 타입을 손으로 다시 선언하지 않고 `z.infer`로만 파생시켰는가? (TR-002)
   - 임계 상수가 `lib/env.ts` **한 곳에만** 있는가? (CLAUDE.md)
   - CLAUDE.md CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/golden-set/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에는 **다음 step이 알아야 할 것**을 담아라 — 내보낸 타입·함수 이름, 실패 사유 어휘, 상수 이름.

## 금지사항

- **파일 시스템을 읽지 마라** (`fs`·`path` import 금지). 이유: 이 모듈은 순수 층이다. 세트 디렉토리를 뒤지는 것은 step 3의 테스트 파일이 한다 — 그 분리가 없으면 이 모듈을 jsdom 없이 값으로 검증할 수 없다 (ADR-010)
- **`services/`를 import하지 마라.** 이유: `lib/` → `services/`는 ARCHITECTURE가 금지한다
- **판정 로직(재현율·오확인)을 여기에 쓰지 마라.** 이유: step 1이 `lib/golden-score.ts`에 쓴다. 두 곳에 생기면 한쪽만 고쳐지는 날이 온다
- **리포트 렌더를 여기에 쓰지 마라.** 이유: step 2가 `lib/golden-report.ts`에 쓴다
- **`*.golden.test.ts` 파일을 만들지 마라.** 이유: step 3의 몫이다. 지금 만들면 `npm run test:golden`이 세트 없이 실패하고, 그 실패가 이 step의 AC를 통과시키지 못한다
- **`docs/`·`package.json`·`vitest*.config.ts`·`CLAUDE.md`를 고치지 마라.** 이유: 메인 소유 경로이고, 이 step이 쓸 계약은 **이미 다 적혀 있다**(ADR-010 · TRD 8번). 문서가 부족하다고 느끼면 고치지 말고 `summary`에 적어라
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다. 네가 쓰면 실측이 오염된다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
