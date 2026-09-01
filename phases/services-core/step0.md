# Step 0: env-zod — 환경변수 검증을 조용한 폴백에서 zod로 (TRD 7번·8번 미이행 해소)

## 읽어야 할 파일

- `/docs/TRD.md` — **7번 "환경변수" 표가 이 step의 계약이다.** 8번 테스트 전략 끝의 "미이행 항목"도 읽어라. 이 step이 그것을 해소한다
- `/docs/ADR.md` — ADR-006(증명 동반), ADR-007(Supabase 예약)
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계
- `src/lib/env.ts` — **현재 구현.** 상수와 `process.env.X ?? 기본값` 폴백만 있다
- `src/lib/env.test.ts` — 기존 테스트 8건. 깨뜨리지 마라
- `src/lib/proof.ts` — **이전 런의 산출물. 시크릿을 다루는 방식의 본이다.** 같은 패턴으로 간다
- `.env.example` — 이 리포가 기대하는 환경변수 목록 (읽기만 하라)

## 작업

`src/lib/env.ts`를 고쳐 **서버 전용 환경변수를 zod로 검증**한다. TRD 7번이 "필수 환경변수는 `lib/env.ts`에서 zod로 검증하고, 없으면 즉시 실패시킨다(런타임 중 조용한 실패 금지)"고 정했는데 현재는 그냥 `??` 폴백이다.

### 왜 지금인가

`/docs/TRD.md` 8번이 이 미이행 항목을 **"`services/` 첫 구현(TR-003) 착수 전에 해소한다"**고 못박아 뒤 뒀다. 다음 step들이 `ANTHROPIC_API_KEY`·`ALADIN_TTB_KEY`를 쓰기 시작하므로 지금이 그 시점이다. 조용한 폴백을 남겨 두면 키가 빠진 채 배포돼도 아무도 모르고, 첫 사용자 요청에서야 드러난다.

### 구조 — 이 지시를 반드시 따르라

**검증을 모듈 최상위 부수효과로 만들지 마라.** `env.ts`는 `match.ts`·`merge.ts`·`image.ts`·`analytics.ts`가 상수(`MAX_PHOTOS` 등)를 가져가려고 import한다. 최상위에서 `throw`하면 **그 테스트들이 전부 깨진다.**

`src/lib/proof.ts`가 `BOOK_PROOF_SECRET`을 다룬 방식과 같게 간다 — 값을 읽는 **함수 안에서** 평가한다.

```ts
// 상수는 지금처럼 그대로 export 한다. 클라이언트도 쓰고 순수 함수도 쓴다.
export const MAX_PHOTOS = 5;   // ... 기존 상수 전부 유지

/** 서버 전용 시크릿 접근자. 첫 호출 시 zod 로 검증한다 */
export function getAnthropicApiKey(): string | null;
export function getAladinTtbKey(): string | null;
export function isServiceEnabled(): boolean;

/**
 * 서버 진입점이 부팅 시 한 번 호출한다.
 * 필수값이 빠져 있으면 여기서 던진다 — 런타임 중 조용한 실패를 막는 지점이다.
 */
export function assertServerEnv(): void;
```

### 반드시 지킬 규칙

1. **기존 상수 export를 하나도 지우거나 이름을 바꾸지 마라.** `MAX_PHOTOS` · `MAX_IDENTIFIED_BOOKS` · `MAX_UNIDENTIFIED_BOOKS` · `MAX_CANDIDATES_PER_PHOTO` · `MAX_CANDIDATES_FOR_LOOKUP` · `MAX_ALADIN_CANDIDATES` · `MAX_RECOMMENDATIONS` · `DEFAULT_MODEL` · `getExtractModel` · `getRecommendModel`이 이미 다른 모듈에서 쓰이고 있다. 지우면 `match`·`merge`·`image` 테스트가 깨진다.
2. **키가 없는 것과 잘못된 것을 구분하라.** `.env.example`이 "비워 두면 `services/`가 목업 픽스처를 반환하는 로컬 개발 모드로 동작한다"고 정했다. 그러므로 `ANTHROPIC_API_KEY`·`ALADIN_TTB_KEY`는 **부재가 곧 오류가 아니다** — 접근자가 `null`을 돌려주고 다음 step의 서비스가 목업 모드로 간다. 반면 **형식이 명백히 틀린 값**(빈 문자열이 아닌 공백만 있는 값 등)은 zod가 거부한다.
3. **`assertServerEnv()`는 프로덕션에서만 필수값을 강제한다.** `process.env.NODE_ENV === "production"`일 때 `ANTHROPIC_API_KEY`·`ALADIN_TTB_KEY`·`BOOK_PROOF_SECRET`이 없으면 던진다. 그 외 환경에서는 경고만 남기고 통과시킨다 — TRD 9번의 "로컬에서 키 없이도 전 구간을 돌릴 수 있어야 한다"는 목업 모드 원칙 때문이다.
4. **`NEXT_PUBLIC_` 접두사를 서버 전용 값에 붙이지 마라.** `NEXT_PUBLIC_MAX_PHOTOS`만 공개 대상이고 나머지는 전부 서버 전용이다 (TRD 6.5).
5. **검증 실패 메시지에 값을 넣지 마라.** 변수 이름만 적는다. 시크릿이 로그로 새는 가장 흔한 경로다.
6. **`zod`는 이미 의존성에 있다.** `src/lib/schemas.ts`가 쓰는 것과 같은 `zod`를 import한다.

### 테스트 (먼저 작성한다)

`src/lib/env.test.ts`를 **확장**한다(기존 8건은 유지). 환경변수는 `process.env`를 테스트 안에서 바꾸고 반드시 원복하라.

- 기존 8건이 그대로 통과한다
- 키가 없으면 접근자가 `null`을 돌려준다 (예외를 던지지 않는다 — 목업 모드가 성립해야 한다)
- 공백만 있는 값은 zod가 거부한다
- `NODE_ENV=production` + 필수 키 부재 → `assertServerEnv()`가 던진다
- `NODE_ENV=production` + 키가 전부 있으면 던지지 않는다
- 개발 환경 + 키 부재 → 던지지 않는다
- **검증 실패 메시지에 값이 들어 있지 않다** (시크릿 유출 회귀 테스트 — 이 테스트를 삭제하지 마라)
- `SERVICE_ENABLED=false`면 `isServiceEnabled()`가 `false`, 미설정이면 `true`
- **모듈을 import하는 것만으로는 아무 예외도 나지 않는다** (최상위 부수효과 금지 회귀 테스트)

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
   - `env.ts`를 import하는 기존 모듈(`match`·`merge`·`image`·`analytics`·`proof`)의 테스트가 전부 통과하는가?
   - 서버 전용 값에 `NEXT_PUBLIC_`을 붙이지 않았는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/services-core/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 함수명을 반드시 포함하라. 다음 step들이 쓴다)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **새 npm 의존성을 추가하지 마라.** `zod`는 이미 있다. 이유: 스택 확장은 `/docs/ADR.md`에 ADR을 먼저 써야 한다 (CLAUDE.md CRITICAL).
- **`.env.example`을 고치지 마라.** 이유: `.env*`는 `harness/config.json`의 `main_owned_paths`에 속한다. 부족한 항목이 보이면 고치지 말고 `summary`에 적어 보고하라.
- **`harness/` · `docs/` · `scripts/` · `.claude/` 를 고치지 마라.** 이유: 위와 같다.
- **`src/services/`나 `src/app/api/`를 만들지 마라.** 이유: 이 step은 `env.ts` 하나만 다룬다.
- **`src/lib/schemas.ts`의 기존 스키마를 바꾸지 마라.** 이유: TR-002가 확정한 계약이고 테스트 56건이 걸려 있다.
- **이전 런이 만든 `proof.ts` · `analytics.ts` · `match.ts` · `merge.ts` · `image.ts`를 수정하지 마라.** 결함을 발견하면 고치지 말고 `summary`에 적어 보고하라.
- **검증을 모듈 최상위에서 실행하지 마라.** 이유: `env.ts`를 import하는 모든 테스트가 환경변수 없이는 못 돌게 된다.
- **기존 테스트를 깨뜨리지 마라.**
