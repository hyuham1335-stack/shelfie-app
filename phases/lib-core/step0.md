# Step 0: proof — 확인된 책의 서버 서명 (TR-015)

## 읽어야 할 파일

먼저 아래를 읽고 프로젝트의 설계 의도를 파악하라. 특히 왜 서명이 필요한지(ADR-006)를 이해하지 못하면 이 step의 핵심을 놓친다.

- `/docs/ARCHITECTURE.md` — "증명 동반 (proof-carrying)" 패턴, 레이어 의존 관계
- `/docs/ADR.md` — ADR-006 (증명 동반), ADR-003 (무상태)
- `/docs/TRD.md` — 3번 표의 TR-015 행, 7번 "환경변수"의 `BOOK_PROOF_SECRET` 항목
- `/docs/API_SPEC.md` — `proof` 필드가 나오는 곳과 문서 끝의 "무엇을 보장하고 무엇을 보장하지 못하는가" 표
- `/docs/PRD.md` — FR-009, FR-011
- `src/lib/schemas.ts` — `identifiedBookSchema` · `resolvedCandidateSchema`의 `proof` 필드
- `src/types/book.ts` — `IdentifiedBook` · `BookReference` · `RecommendBook`

## 작업

`src/lib/proof.ts`를 새로 만든다. Node 내장 `node:crypto`의 HMAC-SHA256으로 확인된 책 1권당 서명을 발급하고 검증한다.

### 왜 필요한가 (이 문단을 이해한 뒤 구현하라)

이 앱은 무상태다. 알라딘 대조를 통과했다는 판정은 응답과 함께 클라이언트로 나갔다가 다음 요청(`/api/recommend`, `/api/mood/questions`)에 다시 들어온다. 서버는 그 목록이 **자기가 내준 것인지 알 수 없다.** 형식 검사(zod)는 값이 그럴듯한지만 보고, 화이트리스트 검사(FR-009)는 모델 출력이 입력과 일치하는지만 본다. 둘 다 통과해도 입력이 처음부터 지어낸 것이면 가짜 책이 추천까지 도달한다. `proof`가 그 간극을 메운다.

### 인터페이스 (시그니처 수준. 내부 구현은 재량이다)

```ts
/** 서명 대상. isbn13은 반드시 포함한다 */
export interface ProofSubject {
  isbn13: string;
  title: string;
  author: string;
}

/** 발급. now는 테스트를 위한 주입점이며 기본값은 Date.now() */
export function issueProof(subject: ProofSubject, now?: number): string;

/** 검증 결과. 실패 사유를 구분 가능한 값으로 돌려준다 */
export type ProofVerdict =
  | { ok: true }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export function verifyProof(subject: ProofSubject, proof: string, now?: number): ProofVerdict;

/** 확인된 책 목록에서 검증 통과분만 남긴다. 실패한 책만 버리고 나머지는 살린다 */
export function filterVerified<T extends ProofSubject & { proof: string }>(
  books: readonly T[],
  now?: number,
): { verified: T[]; rejected: Array<{ book: T; reason: string }> };
```

### 반드시 지킬 규칙

1. **TTL은 2시간이다.** 만료된 서명은 통과시키지 않는다.
2. **서명 대상에 최소한 `isbn13`과 만료 시각을 포함한다.** 어떤 필드를 서명에 넣었는지와 그 근거를 파일 상단 주석에 남겨라. 한 책의 `proof`를 다른 책에 붙여 쓰면 반드시 실패해야 한다.
3. **서명 비교는 `crypto.timingSafeEqual`을 쓴다.** 문자열 `===` 비교는 타이밍 공격에 노출된다. 길이가 다른 버퍼를 넘기면 예외가 나므로 길이를 먼저 확인하고 `bad_signature`로 처리하라.
4. **실패 사유를 뭉개지 마라.** 형식이 깨진 것(`malformed`)·서명 불일치(`bad_signature`)·만료(`expired`)는 서로 다른 값이다. 이 프로젝트는 "왜 실패했는지를 끝까지 나른다"는 사유 보존 패턴을 따른다.
5. **검증 실패는 요청 전체가 아니라 그 책만 폐기한다** (fail-soft). `filterVerified`가 그 규약을 코드로 고정하는 함수다.
6. **시크릿 처리** — `BOOK_PROOF_SECRET` 환경변수를 쓴다.
   - 값이 있으면 그것을 쓴다.
   - 없고 `process.env.NODE_ENV === "production"`이면 **예외를 던진다.** 조용한 폴백은 서명 없는 서명이 되어 ADR-006을 무력화한다.
   - 없고 프로덕션이 아니면 고정된 개발용 값으로 대체하고 `console.warn`을 **한 번만** 남긴다. 로컬에서 키 없이도 전 구간을 돌릴 수 있어야 한다(TRD 9번 목업 모드 원칙).
   - 이 판정을 **모듈 최상위 부수효과로 만들지 마라.** 함수 안에서 평가해야 테스트가 환경변수를 바꿔가며 검증할 수 있다.

### 테스트 (먼저 작성한다)

`src/lib/proof.test.ts`. 최소한 아래를 덮어라.

- 발급한 서명이 같은 책에 대해 검증을 통과한다
- 서명 문자열을 1글자 바꾸면 `bad_signature`
- 형식이 아예 다른 문자열(빈 문자열·구분자 없음)은 `malformed`
- `now`를 2시간 + 1초 뒤로 주면 `expired`, 2시간 - 1초면 통과
- **A 책의 proof를 B 책에 붙이면 실패한다** (교차 사용 차단)
- `filterVerified`가 위조 1권 + 정상 2권 입력에서 정상 2권만 남기고, 버린 책의 사유를 함께 돌려준다
- `BOOK_PROOF_SECRET`이 없고 `NODE_ENV`가 `production`이면 예외가 난다
- 시크릿이 바뀌면 이전 서명이 전부 실패한다 (TRD 7번의 교체 주의사항이 사실인지 고정)

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
   - `lib/`는 외부 호출을 하지 않는 순수 함수만 담는가? (`services/` import 금지)
   - `/docs/ADR.md`가 정한 기술 스택을 벗어나지 않았는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/lib-core/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(생성한 파일과 export한 함수명)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **새 npm 의존성을 추가하지 마라.** 이유: 서명은 Node 내장 `node:crypto`로 충분하고, 스택을 벗어나려면 `/docs/ADR.md`에 ADR을 먼저 써야 한다 (CLAUDE.md CRITICAL).
- **`harness/**` · `docs/**` · `scripts/**` · `.claude/**` 를 고치지 마라.** 이유: `harness/config.json`의 `main_owned_paths`가 메인 에이전트 단독 소유로 정한 곳이다.
- **`src/services/`를 만들거나 import하지 마라.** 이유: `lib/`는 외부 호출을 하지 않는 순수 함수만 담는다는 레이어 경계다. 서비스 계층은 이번 파일럿 범위 밖이다.
- **`src/lib/env.ts`의 zod 검증 미이행 항목을 고치지 마라.** 이유: `/docs/TRD.md` 8번이 TR-003 착수 전 해소로 잡아 둔 별건이다. 이 step은 `proof.ts` 안에서 자기 시크릿만 다룬다.
- **`src/lib/schemas.ts`의 기존 스키마를 바꾸지 마라.** 이유: TR-002가 이미 확정한 계약이고, 바꾸면 `schemas.test.ts` 56건이 깨진다. 필요한 타입은 import해서 쓴다.
- **기존 테스트를 깨뜨리지 마라.**
