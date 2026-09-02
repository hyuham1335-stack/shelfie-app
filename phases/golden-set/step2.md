# Step 2: golden-report

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ARCHITECTURE.md` — 레이어 의존 관계, `lib/golden-*.ts` 노드 3개
- `/docs/TRD.md` — **8번 "골든 인식률 계약"**의 skip 사유 3종 표와 "결과 기록" 절이 이 step의 계약이다. **9번 배포 전 수동 체크리스트**도 반드시 본다 — 이 리포트가 그 체크리스트의 근거가 된다
- `src/lib/golden-score.ts` — step 1이 만든 판정 결과 타입
- `src/lib/golden-manifest.ts` — step 0이 만든 매니페스트 타입
- `src/lib/env.ts` — 임계 상수

위 소스 파일은 **프롬프트에 이미 실려 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

## 작업

골든 결과의 **표현**을 만든다. 순수 함수만이다 — 파일을 쓰지 않고 문자열과 객체를 돌려준다. 실제로 디스크에 쓰는 것은 step 3의 테스트 파일이 한다.

### `src/lib/golden-report.ts` (신규)

```ts
/** 골든이 돌지 못한 사유 (TRD 8번 skip 표) */
export type GoldenSkipReason = "no_set_dir" | "no_manifest" | "no_api_key";

/** 이 런이 무엇이었는가 — 잰 것이냐 못 잰 것이냐 */
export type GoldenOutcome =
  | { status: "scored"; score: GoldenSetScore }
  | { status: "skipped"; reason: GoldenSkipReason; detail: string };

/** 결과만 보고도 입력을 특정할 수 있게 하는 값들 (ADR-010) */
export interface GoldenRunContext {
  setId: string | null;
  manifestVersion: number | null;
  /** 사진 파일명 → sha256 */
  photoHashes: Record<string, string>;
  extractModel: string;
  ranAt: string;   // ISO 8601
}

/** 콘솔에 찍을 사람용 표 */
export function renderGoldenReport(outcome: GoldenOutcome, context: GoldenRunContext): string;

/** `reports/golden/{ISO}.json`에 쓸 기계용 객체 */
export function toGoldenReportJson(outcome: GoldenOutcome, context: GoldenRunContext): unknown;
```

핵심 규칙 — 어기면 이 리포트가 거짓 안심을 준다:

1. **skip은 통과가 아니다. 리포트가 그렇게 말해야 한다.** `status: "skipped"`인 리포트의 **첫 줄**에 재지 않았다는 사실과 사유를 적어라. "PASS"·"OK"·체크마크처럼 통과로 읽히는 표시를 skip에 쓰지 마라. 이유: 배포 전 체크리스트(TRD 9번)가 "골든을 돌렸는가"를 묻는데, skip한 리포트가 초록색이면 사람이 돌렸다고 답하게 된다. **감지 수단이 없는 가드레일(TRD 6.4)에서 유일한 감지 장치가 스스로를 속이는 자리다** (ADR-010).
2. **`no_api_key` skip은 가장 크게 드러내라.** 사유 문구에 *왜* 이것이 위험한지를 한 줄로 담아라 — 키가 없으면 `services/`가 목업을 돌려주므로 그대로 재면 재현율이 100%로 나온다. 사유 코드만 찍으면 다음에 보는 사람이 "키 없어도 돌아가네"라고 읽는다.
3. **`GoldenRunContext`를 두 출력 모두에 실어라.** 세트가 버전 관리 밖에 있어(ADR-010) `setId`·`manifestVersion`·`photoHashes`·`extractModel`이 없으면 **결과만 남고 입력이 무엇이었는지 모르는 상태**가 된다. 두 리포트를 나란히 놓았을 때 같은 세트를 같은 모델로 잰 것인지가 보여야 한다.
4. **판정을 다시 하지 마라.** `passed`·`recall`·`misidentifiedCount`는 step 1이 계산한 값을 그대로 표시한다. 여기서 임계값과 다시 비교하면 판정이 두 곳에 생기고, 한쪽만 고쳐지는 날이 온다. 다만 **표시할 때 임계값을 함께 보여 줘라** — `recall 0.87 (기준 0.90)`처럼. 사람이 얼마나 모자란지 알아야 한다.
5. **놓친 책과 오확인을 이름으로 찍어라.** 숫자만 있으면 사람이 할 일이 없다. 사진별로 짝지어지지 않은 기대 항목의 제목과, 오확인된 책의 제목·ISBN을 목록으로 낸다. 많으면 잘라내되 **잘랐다는 사실과 전체 건수를 남겨라** — 조용히 자르면 그 아래가 없는 것이 된다.
6. **알라딘 사실과 우리 추정을 섞지 마라.** 오확인 목록의 제목·저자·ISBN은 알라딘이 준 사실이고, 유사도 점수는 우리가 만든 추정이다. 같은 층위로 나열하지 말고 구분되게 표시하라 (ADR-002).
7. 표는 **터미널에서 읽히는 폭**으로 만들어라. 이 리포트는 브라우저가 아니라 콘솔에서 읽힌다 — `/docs/UI_GUIDE.md`는 화면 규칙이고 여기에 적용되지 않는다.

### `src/lib/golden-report.test.ts`

TDD다 — 테스트를 먼저 쓰고 통과하는 구현을 쓴다(CLAUDE.md CRITICAL).

최소한 이것들을 덮어라: skip 리포트가 첫 줄에 사유를 담음 · **skip 리포트에 통과로 읽히는 표시가 없음**(문자열 단정으로 고정하라 — 이 테스트가 규칙 1을 지키는 장치다) · `no_api_key`의 문구가 목업 위험을 설명함 · 실패한 판정이 실패로 표시되고 기준값이 함께 나옴 · 놓친 책과 오확인이 이름으로 나옴 · 목록을 자를 때 전체 건수가 남음 · `GoldenRunContext`의 네 값이 두 출력 모두에 있음 · `toGoldenReportJson`의 결과가 `JSON.stringify`로 직렬화 가능함.

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
   - `lib/golden-report.ts`가 `services/`·`fs`·`process.env`를 import하지 않는가? (파일 쓰기는 step 3의 몫이다)
   - 임계값 비교를 다시 하지 않았는가? (판정은 `golden-score.ts` 한 곳)
   - CLAUDE.md CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/golden-set/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에는 **다음 step이 알아야 할 것**을 담아라 — `GoldenOutcome`·`GoldenSkipReason`·`GoldenRunContext`의 정확한 형태와 두 함수의 시그니처. step 3이 이것을 조립한다.

## 금지사항

- **파일을 쓰지 마라** (`fs` import 금지). 이유: 이 모듈이 디스크를 만지는 순간 값으로 검증할 수 없게 되고, `npm test`가 테스트 실행마다 `reports/`에 쓰레기를 남긴다. 경로 조립과 쓰기는 step 3이 한다 (ADR-010)
- **`process.env`를 읽지 마라.** 이유: 순수 층이다. `extractModel` 같은 값은 **인자로 받아라** — 그래야 테스트가 고정값으로 검증한다
- **`golden-score.ts`·`golden-manifest.ts`를 고치지 마라.** 이유: step 0·1의 산출물이다. 부족하면 `summary`에 적어라
- **`*.golden.test.ts` 파일을 만들지 마라.** 이유: step 3의 몫이다
- **색상 이스케이프 코드를 직접 박지 마라.** 이유: 이 문자열은 콘솔과 리다이렉트된 파일 양쪽으로 간다. 파일에 들어간 ANSI 코드는 다음에 읽는 사람에게 잡음이다
- **`docs/`·`package.json`·`vitest*.config.ts`·`CLAUDE.md`를 고치지 마라.** 이유: 메인 소유 경로이고 계약은 이미 적혀 있다
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
