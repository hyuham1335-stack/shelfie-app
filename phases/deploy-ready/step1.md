# Step 1: aladin-call-budget

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 설계 의도를 파악하라:

- `/docs/TRD.md` — **10번 병목 표와 그 아래 "세션당 260회는 산문의 계산식이 아니라 코드가 잠그는 계약이다" 절이 이 step의 계약 전부다.** 6.2 확장성 표의 알라딘 일일 호출 행, TR-004(조회 동시성 12·`lookup_failed`), TR-005(조회 전 80건·확인 50권 상한과 **결정적** 절단 순서)도 반드시 본다
- `src/lib/env.ts` — 도메인 상수 단일 출처. 새 상수가 여기로 들어간다

위 소스 파일은 **프롬프트에 이미 실려 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

## 직접 읽어라 (첨부하지 않았다)

- `src/lib/merge.ts` · `src/lib/merge.test.ts` — **이 step이 고칠 파일이다.** 첨부하지 않았으니 직접 읽어라. `reduceBeforeLookup`이 조회 전 후보를 어떻게 자르는지, 확인 상한이 어디서 걸리는지를 정확히 알아야 한다
- `src/services/aladin.ts` — **통독하지 마라.** 네가 필요한 것은 한 책을 조회할 때 실제로 몇 번의 HTTP 호출이 나갈 수 있는지(ItemSearch → ItemLookUp, 재시도 포함)뿐이다. `grep -n "^export\|retry\|ItemLookUp\|ItemSearch"` 로 그 지점만 확인하라. 이 파일은 고치지 않는다

## 작업

**런 #3이 올린 보고를 닫는다 — "메인이 TRD에서 갱신했고 코드 쪽 소비처가 없다"로 세 런째 이월된 항목이다.**

TRD 10번이 세션당 알라딘 호출 상한을 **260회**로 적고 있다. 그런데 그 값은 지금 **산문 안의 계산식일 뿐 코드 어디에도 없다.** 상한을 실제로 만드는 것은 `lib/env.ts`의 두 상수이고, 260은 거기서 유도된 결과다:

```
(MAX_CANDIDATES_FOR_LOOKUP(80) + MAX_IDENTIFIED_BOOKS(50)) × 2 = 260
```

누군가 80을 200으로 올리는 순간 알라딘 일일 한도(5,000회)가 세션 8회에 소진되는데, 지금 그것을 막는 것은 이 표의 산문뿐이다. **문서에만 있는 상한은 검증되지 않은 상한이다.**

### 1. `src/lib/env.ts`에 상한과 유도값을 이름으로 둔다

```ts
/** 한 요청(세션 1회 분석)이 알라딘에 낼 수 있는 호출 수의 상한 (TRD 10번) */
export const MAX_ALADIN_CALLS_PER_SESSION = 260;

/** 조회 한 건이 낼 수 있는 최대 HTTP 호출 수 — ItemSearch/ItemLookUp 각각의 재시도 포함 */
export const ALADIN_CALLS_PER_LOOKUP = 2;
```

이름과 값은 위 형태를 지키되, **유도값을 상수로 다시 박아 넣지 마라.** `260`을 손으로 적은 상수와 `(80 + 50) × 2`를 계산한 값이 따로 존재하면 한쪽만 고쳐지는 날이 온다 — 그것이 CLAUDE.md가 도메인 상수를 한 곳에서만 정의하라고 적은 이유다. **하나는 선언(상한)이고 하나는 유도(현재 구성이 내는 값)이며, 둘을 잇는 것은 상수가 아니라 테스트다.**

`src/services/aladin.ts`를 읽어 `ALADIN_CALLS_PER_LOOKUP = 2`가 **실제 구현과 맞는지 확인하라.** 한 조회가 최악의 경우 3회를 낼 수 있다면 값을 3으로 올리고 그 근거를 주석에 남겨라 — 그러면 유도값이 상한을 넘게 되고, 그때 할 일은 테스트를 통과시키려고 상한을 올리는 것이 **아니라** `summary`에 보고로 올리는 것이다. 유도값이 상한을 넘는다는 것은 이 프로젝트가 알라딘 한도를 계산보다 빨리 태운다는 뜻이고, 그 판단은 사람의 몫이다(`[Scale]` 캐시 도입 — ADR-007).

### 2. 관계를 회귀 테스트로 잠근다

`src/lib/merge.test.ts`(또는 `src/lib/env.test.ts`)에 **관계를 검사하는** 테스트를 넣는다. 값을 복창하는 테스트가 아니다 — `expect(MAX_ALADIN_CALLS_PER_SESSION).toBe(260)` 하나만 있으면 아무것도 막지 못한다.

잠가야 하는 것:

1. **유도값이 상한을 넘지 않는다** — `(MAX_CANDIDATES_FOR_LOOKUP + MAX_IDENTIFIED_BOOKS) × ALADIN_CALLS_PER_LOOKUP <= MAX_ALADIN_CALLS_PER_SESSION`. 누가 80을 200으로 올리면 **이 테스트가 깨진다.** 그것이 이 step의 전부다
2. **`reduceBeforeLookup`이 실제로 그 상한 안에서 자른다** — 후보를 300건 넣어도 조회 대상이 `MAX_CANDIDATES_FOR_LOOKUP`을 넘지 않는다(TR-005의 기존 AC를 상수로 다시 잇는다)
3. 테스트가 **왜** 존재하는지 파일 안에 한 줄로 남겨라. 이 테스트는 지우면 안 되는 종류다 — TRD 8번의 "삭제하지 않는다" 목록과 같은 성격이다

`merge.ts`가 상한을 리터럴로 갖고 있다면 `env.ts` 상수를 import하도록 바꿔라. 이미 그렇게 되어 있으면 그대로 두고 테스트만 더한다 — **이 step의 산출물은 새 동작이 아니라 잠긴 관계다.**

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
   - 도메인 상수가 `lib/env.ts` **한 곳에만** 있는가? 같은 값이 두 곳에 생기지 않았는가? (CLAUDE.md)
   - `lib/`이 `services/`를 import하지 않았는가? (ARCHITECTURE 레이어 규칙)
   - 서버 전용 접근자를 `lib/env.ts`에서 새로 부르지 않았는가? (상수는 클라이언트도 가져간다)
   - 파일 시스템·전역 변수·쿠키로 호출 수를 세려 하지 않았는가? **인스턴스 간 카운터는 이 step의 범위가 아니다** (ADR-003 무상태 · ADR-007)
3. 결과에 따라 `phases/deploy-ready/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에 **`ALADIN_CALLS_PER_LOOKUP`을 실제 구현에서 확인한 결과**를 반드시 적어라 — 2가 맞았는지, 아니면 더 컸는지. 그 숫자가 이 계약의 근거 전부다.

## 금지사항

- **런타임 카운터를 만들지 마라.** 이유: 서버리스 다중 인스턴스에서 카운터를 공유하려면 외부 스토어가 필요하고, 그것은 무상태 전제(ADR-003)를 문서 없이 우회하는 것이다. 일일 누적 카운트는 `[Scale]`이고 Supabase 도입 시점의 몫이다 (ADR-007). 이 step이 만드는 것은 **한 요청 안의 구조적 상한**이다
- **`src/services/aladin.ts`를 고치지 마라.** 이유: 읽기만 한다. 조회 래퍼의 동작을 바꾸면 TR-004의 `lookup_failed` 판정과 서킷 브레이커가 함께 흔들린다
- **상한을 올려서 테스트를 통과시키지 마라.** 이유: 유도값이 상한을 넘으면 그것이 발견이지 조정 대상이 아니다. `summary`에 보고로 올려라
- **`docs/`·`harness/`·`scripts/`·`.claude/`·`.github/`·리포 루트의 `*.ts`·`*.json`·`*.mjs`를 고치지 마라.** 이유: 메인 소유 경로다. 계약은 이미 TRD 10번에 적혀 있다
- **새 npm 의존성을 넣지 마라.** 이유: CLAUDE.md CRITICAL — ADR이 먼저다
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
