# Step 3: aladin — 알라딘 OpenAPI 래퍼와 요청 스코프 서킷 브레이커 (TR-004 서비스 부분)

## 읽어야 할 파일

- `/docs/TRD.md` — 3번 표의 **TR-004 행**, 7번의 **"Circuit Breaker 정책"**(요청 스코프 브레이커 [MVP] 표를 정확히 읽어라)과 **"시간 예산"**, 10번 병목 예상 지점
- `/docs/PRD.md` — **FR-003(확인/미확인 판정)** · FR-012(조회 전 후보 상한)
- `/docs/ADR.md` — **ADR-005(실패와 데이터 없음의 분리)** · ADR-002(대조를 통과하지 않은 책 금지)
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계, "검증 경계"·"강등"·"사유 보존" 패턴, 데이터 흐름 1
- `src/lib/schemas.ts` — `aladinCandidateSchema` · `aladinFactsSchema` · `unidentifiedReasonSchema`
- `src/lib/match.ts` — **이전 런의 산출물.** `LookupOutcome` 타입이 이 서비스의 출력 형태를 이미 정해 두었다
- `src/lib/budget.ts` · `src/lib/env.ts` — 이전 step 산출물
- `CLAUDE.md` — 알라딘 관련 CRITICAL 규칙

## 작업

`src/services/aladin.ts`를 새로 만든다. 알라딘 ItemSearch를 호출해 **`src/lib/match.ts`의 `judge()`가 먹을 수 있는 `LookupOutcome`을 돌려주는** 래퍼다.

**`src/services/` 디렉토리를 새로 만드는 첫 step이다.** `/docs/ARCHITECTURE.md`의 디렉토리 구조를 따른다.

### 역할 경계

이 모듈은 **네트워크만 담당한다.** 유사도 판정은 `match.ts`가 이미 한다 — 여기서 다시 구현하지 마라.

```ts
import { judge, type LookupOutcome } from "@/lib/match";
```

### 반드시 지킬 규칙

1. **`no_match`와 `lookup_failed`를 절대 섞지 마라.**
   - 알라딘이 200을 주고 결과가 0건 → `{ status: "ok", candidates: [] }` → `match.ts`가 `no_match`로 판정한다
   - 알라딘이 5xx·타임아웃·네트워크 오류 → `{ status: "failed" }` → `match.ts`가 `lookup_failed`로 판정한다

   이 둘을 뭉개는 것은 이 프로젝트에서 가장 심각한 결함 중 하나다. 시스템 문제를 데이터 문제로 설명하게 된다 (ADR-005, CLAUDE.md CRITICAL).

2. **응답은 반드시 zod를 통과한 뒤에만 도메인 타입으로 쓴다.** 알라딘 응답 필드가 바뀌면 파싱에서 잡혀야 한다. 파싱에 실패한 개별 레코드는 조용히 버리지 말고 **후보에서 제외했다는 사실이 드러나게** 하라 (CLAUDE.md CRITICAL, ADR-002).

3. **요청 스코프 서킷 브레이커 [MVP]** — TRD 7번이 정한 것을 그대로 구현한다.
   - 같은 요청 안에서 **연속 5회 실패**하면 Open
   - Open이면 남은 후보를 **조회하지 않고 전부 `lookup_failed`로 강등**하고 즉시 다음 단계로 넘어간다
   - 브레이커 상태는 **요청이 끝나면 사라진다.** 전역 변수·모듈 스코프에 두지 마라 — 무상태 전제(ADR-003)를 어기고, 서버리스 인스턴스 간에 공유되지도 않는다
   - 이것이 없으면 알라딘이 다운됐을 때 한 요청이 최대 160회의 실패 호출을 던지고 12s 예산을 타임아웃으로만 소진한다

4. **동시성 12로 제한한다** (TR-004). 상한 없이 80건을 동시에 던지지 마라.

5. **짧은 타임아웃 + 1회 재시도.** 재시도는 5xx·타임아웃에만 한다. 4xx는 재시도하지 마라 — 우리 요청이 잘못된 것이므로 반복해도 같다.

6. **데드라인을 인자로 받아라.** `budget.ts`의 `deadlineFor("lookup")` 결과를 받아 그 안에서만 산다. 자체 타임아웃 상수를 따로 두면 합이 총 예산을 넘긴다 (ADR-005).

7. **ISBN13이 없는 레코드를 후보로 올리지 마라** (TR-004). `aladinCandidateSchema`가 이미 강제하므로 파싱에서 걸러진다.

8. **`ALADIN_TTB_KEY`가 없으면 목업 모드다.** `.env.example`이 "비워 두면 `services/`가 목업 픽스처를 반환하는 로컬 개발 모드로 동작한다"고 정했다. 키가 없으면 네트워크를 치지 말고 고정 픽스처를 돌려주되, **목업이라는 사실이 드러나게** 하라(로그 또는 반환값). 조용한 목업은 "동작하는 줄 알았는데 아니었다"가 된다.

9. **TTB 키를 로그·에러 메시지·URL 로그에 남기지 마라.** 서버 전용 시크릿이다 (TRD 6.5).

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
export const ALADIN_CONCURRENCY = 12;
export const BREAKER_CONSECUTIVE_FAILURES = 5;

/** 요청 하나의 수명을 갖는 브레이커. 모듈 스코프에 두지 마라 */
export interface RequestBreaker {
  isOpen(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}
export function createRequestBreaker(threshold?: number): RequestBreaker;

export interface SearchOptions {
  deadlineMs: number;
  breaker?: RequestBreaker;
  fetchImpl?: typeof fetch;   // 테스트 주입점
}

/** 제목·저자로 조회한다. 실패를 예외가 아니라 판별 가능한 값으로 돌려준다 */
export function searchByTitle(title: string, author: string | null, options: SearchOptions): Promise<LookupOutcome>;

/** 후보 여러 건을 동시성 제한 아래 조회한다. 브레이커가 Open 되면 잔여는 조회하지 않는다 */
export function searchMany(
  queries: readonly { title: string; author: string | null }[],
  options: SearchOptions,
): Promise<LookupOutcome[]>;
```

### 테스트 (먼저 작성한다)

`src/services/aladin.test.ts`. **`fetch`를 주입하거나 `vi.stubGlobal`로 대체한다. 실제 알라딘을 호출하지 마라** (TRD 8번).

- 200 + 결과 2건 → `{ status: "ok", candidates: [...] }`이고 zod를 통과한 것만 담긴다
- 200 + 결과 0건 → `{ status: "ok", candidates: [] }` (`failed`가 **아니다**)
- **500 → `{ status: "failed" }`** — 이 테스트는 삭제하지 마라 (ADR-005 회귀)
- **타임아웃 → `{ status: "failed" }`**
- 4xx는 재시도하지 않고 5xx는 1회 재시도한다 (호출 횟수로 확인)
- ISBN13이 없거나 형식이 틀린 레코드는 후보에서 빠진다
- **연속 5회 실패 후 브레이커가 Open되고, 이후 쿼리는 `fetch`를 호출하지 않으며 전부 `failed`로 온다**
- 브레이커는 성공하면 연속 실패 카운터가 초기화된다
- `searchMany`의 동시 실행 수가 12를 넘지 않는다
- 데드라인이 0이면 호출하지 않고 즉시 `failed`
- `ALADIN_TTB_KEY`가 없으면 `fetch`를 호출하지 않고 목업을 돌려준다
- **에러 메시지·로그에 TTB 키가 들어 있지 않다** (시크릿 유출 회귀 테스트 — 삭제하지 마라)

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
   - `services/`가 `components/`를 import하지 않는가? (역방향 금지)
   - `no_match`와 `lookup_failed`가 코드 경로에서 끝까지 다른 값으로 나르는가?
   - 브레이커 상태가 모듈 스코프·전역에 남지 않는가? (무상태 전제, ADR-003)
   - 테스트가 실제 네트워크를 치지 않는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/services-core/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 함수·타입명 포함)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **실제 알라딘 API를 호출하지 마라.** 테스트는 `fetch`를 모킹한다. 이유: `/docs/TRD.md` 8번이 "외부 API 실제 호출 금지"를 정했고, 유일한 예외인 골든 테스트는 CI에서 분리돼 있다.
- **새 npm 의존성을 추가하지 마라** (`axios` · `p-limit` · `xml2js` 등 포함). 이유: 내장 `fetch`로 충분하고, 스택 확장은 ADR이 먼저다 (CLAUDE.md CRITICAL).
- **`no_match`와 `lookup_failed`를 같은 값으로 뭉개지 마라.** 이유: 시스템 문제를 데이터 문제로 설명하게 된다 (ADR-005).
- **브레이커 상태를 모듈 스코프·전역 변수에 두지 마라.** 이유: 무상태 전제(ADR-003)를 문서 없이 우회하는 것이고, 서버리스 다중 인스턴스에서 공유되지도 않는다.
- **zod를 통과하지 않은 값을 도메인 타입으로 쓰지 마라.** 이유: CLAUDE.md CRITICAL이 정한 검증 경계다.
- **유사도 판정을 여기서 다시 구현하지 마라.** `src/lib/match.ts`의 `judge()`를 쓴다. 이유: 두 벌이 되면 판정 기준이 소리 없이 갈린다.
- **`src/app/api/`를 만들지 마라.** 이유: 라우트는 다음 런이다.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.** 이유: `main_owned_paths`다.
- **이전 step이 만든 `env.ts` · `budget.ts` · `prompts.ts`와 이전 런의 `lib/` 모듈을 수정하지 마라.** 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **기존 테스트를 깨뜨리지 마라.**
