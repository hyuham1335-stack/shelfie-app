# Step 2: analyze-route — 사진 분석 엔드포인트 (TR-006)

이번 런의 핵심이다. 지금까지 따로 만든 모든 모듈이 여기서 처음으로 한꺼번에 만난다.

## 읽어야 할 파일

- `/docs/API_SPEC.md` — **`POST /api/analyze` 절 전문이 이 step의 계약이다.** 요청·응답 스키마와 상태 코드 규칙, 그리고 공통 규약과 에러 응답 규약도 읽어라
- `/docs/TRD.md` — **7번 "시간 예산" 표**(총 55s = 추출 30 / 대조 12 / 한줄평 8 / 여유 5), 3번 표의 TR-006 행, 6.1 성능, 9번 배포(함수 `maxDuration`)
- `/docs/PRD.md` — US-001, FR-003·FR-004·FR-005·FR-011·FR-012, 5번 Edge Cases
- `/docs/ADR.md` — **ADR-005(시간 예산·사유 분리)** · **ADR-006(증명 동반)** · ADR-002 · ADR-003(무상태)
- `/docs/ARCHITECTURE.md` — **데이터 흐름 1(사진 분석)의 시퀀스 다이어그램이 구현 순서다.** 레이어 의존 관계도 읽어라
- `src/lib/schemas.ts` — `analyzeRequestSchema` · `analyzeResponseSchema`가 이미 있다
- `src/lib/budget.ts` · `src/lib/merge.ts` · `src/lib/match.ts` · `src/lib/proof.ts` · `src/lib/analytics.ts` — 전부 이미 있다. **다시 만들지 마라**
- `src/services/anthropic.ts` · `src/services/aladin.ts` — 이전 step들의 산출물

## 작업

`src/app/api/analyze/route.ts`를 새로 만든다. **`src/app/api/` 디렉토리를 만드는 첫 step이다.**

### 구현 순서 (ARCHITECTURE 데이터 흐름 1)

1. 요청 본문을 `analyzeRequestSchema`로 검증 (장수·MIME·크기 재확인 — 클라이언트를 믿지 않는다)
2. `createBudget()`으로 총 55s 예산 시작
3. **사진마다 병렬**로 `extractFromPhoto` (예산 `deadlineFor("extract")`)
4. 실패한 사진은 `failedPhotoIndexes`에 담고 계속 진행
5. `reduceBeforeLookup` — `confidence` 0.3 미만 강등 · 정규화 키 병합 · 80건 절단
6. **동시성 12**로 알라딘 대조 (예산 `deadlineFor("lookup")`, 요청 스코프 브레이커 1개 생성)
7. `judge()`로 확인/미확인 판정 → 확인된 책은 `lookupFacts`로 사실 완성
8. `dedupeByIsbn` → `capIdentified` / `capUnidentified`
9. `generateNotes` (남은 예산 8s 미만이면 생략, 전원 빈 문자열)
10. **`issueProof`로 확인된 책마다 서명 발급**
11. `logEvent`로 `analyze_completed` 기록 (토큰 수 포함)
12. `analyzeResponseSchema`로 응답을 검증한 뒤 반환

### 상태 코드 — 틀려도 초록불로 통과하는 분기들

**이 표를 그대로 구현하고 테스트로 고정하라.** 여기가 이 step에서 가장 틀리기 쉬운 곳이다.

| 상황 | 올바른 응답 |
|---|---|
| 요청 스키마 위반(장수 초과·MIME·크기) | **400** |
| **추출 후보 자체가 0건** | **404 `EMPTY_SHELF`** |
| 후보는 있으나 **확인 0건** (알라딘 장애·전량 미확인) | **200** + `identified: []` + 미확인 목록. **`EMPTY_SHELF`가 아니다.** 클라이언트가 `unidentifiedOnly` 상태로 분기한다 |
| 일부 사진 실패 | **200** + `failedPhotoCount`·`failedPhotoIndexes` |
| **전** 사진 추출 실패 | **502** |
| 어느 단계든 예산 초과 | **200.** 그 단계의 산출물만 강등 — 대조는 `lookup_failed`, 한줄평은 빈 문자열 |

세 번째 줄을 `EMPTY_SHELF`로 처리하면 사용자에게 "책이 하나도 없네요"라고 말하게 되는데, 사실은 알라딘이 죽어서 확인을 못 한 것이다. **시스템 문제를 데이터 문제로 설명하는 것**이고 이 프로젝트가 가장 경계하는 실패다 (ADR-005).

### 반드시 지킬 규칙

1. **모든 API 로직은 라우트 핸들러 안에서만.** 새 레이어를 만들지 마라 (CLAUDE.md CRITICAL).
2. **데드라인 전파**: 각 단계는 `min(단계 예산, 남은 예산)`을 쓴다. `budget.ts`의 `deadlineFor()`가 이미 그렇게 계산한다 — 직접 빼기 계산을 다시 하지 마라.
3. **확인된 책은 반드시 `proof`를 달고 나간다** (ADR-006, FR-011). 하나라도 빠지면 다음 요청에서 그 책이 검증에 실패한다.
4. **`no_match`·`lookup_failed`·`unreadable`·`ambiguous` 4종을 끝까지 다른 값으로 나른다** (ADR-005).
5. **`candidates`는 `reason`이 `ambiguous`일 때만 채운다.** `unidentifiedBookSchema`의 `.refine`이 강제한다.
6. **응답을 `analyzeResponseSchema`로 검증한 뒤 반환하라.** 우리가 만든 응답도 계약을 지키는지 기계로 확인한다.
7. **저장소를 만들지 마라.** 파일·전역 변수·쿠키에 상태를 남기지 마라 (ADR-003, CLAUDE.md CRITICAL). 브레이커도 요청마다 새로 만든다.
8. **`analytics.logEvent`를 부르되 로깅 실패가 응답을 막지 않게 하라.**
9. **`export const maxDuration`을 설정하라** — Vercel 함수 상한 60s (TRD 9번).
10. **이미지 base64를 로그에 남기지 마라** (PRD 7번).

### 테스트 (먼저 작성한다)

`src/app/api/analyze/route.test.ts`. **`services/`를 전부 모킹한다** (TRD 8번 — 통합 테스트는 서비스를 모킹하고 요청→응답 계약과 에러 코드를 검증한다).

- 정상 경로: 사진 2장 → 확인 3권 + 미확인 2건, 응답이 `analyzeResponseSchema`를 통과한다
- **확인된 책 전원에 `proof`가 있고 `verifyProof`로 검증된다** (삭제 금지 — ADR-006 회귀)
- 장수 6장 / 지원하지 않는 MIME / 크기 초과 → **400**
- **추출 후보 0건 → 404 `EMPTY_SHELF`**
- **후보 있음 + 확인 0건 → 200이고 `EMPTY_SHELF`가 아니다** (삭제 금지 — ADR-005 회귀)
- 사진 1장 실패 → 200 + `failedPhotoCount: 1` + `failedPhotoIndexes: [n]`
- 전 사진 실패 → **502**
- **알라딘이 5xx를 낸 책의 `reason`이 `no_match`가 아니라 `lookup_failed`다** (삭제 금지 — ADR-005 회귀, TRD 8번이 명시한 필수 테스트)
- 대조 예산 소진 → 잔여 후보가 `lookup_failed`이고 응답은 200
- **남은 예산 8s 미만 → 한줄평 호출 없이 `claudeNote`가 전원 빈 문자열이고 응답은 200** (가짜 타이머)
- 확인 51권 → 50권 + `overflowCount: 1`, 절단 순서가 결정적이다
- 미확인 101건 → 100건 + `unidentifiedOverflowCount: 1`
- 같은 책이 여러 사진에 등장 → 1권이고 `photoIndex`는 최초값
- `analyze_completed` 이벤트가 토큰 수와 함께 기록된다
- 로깅이 실패해도 200이 나간다

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
   - 로직이 라우트 핸들러 안에 있는가? 새 레이어를 만들지 않았는가?
   - `lib/`·`services/`의 기존 함수를 재사용했는가? (중복 구현 0건)
   - 확인된 책 전원에 `proof`가 있는가?
   - 서버 상태를 어디에도 남기지 않았는가? (ADR-003)
   - 테스트가 실제 외부 API를 치지 않는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/routes-core/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(상태 코드 분기와 예산 처리 방식을 명시하라)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** 실행기가 기록한다.
- **실제 외부 API를 호출하지 마라.** 테스트는 `services/`를 모킹한다 (TRD 8번).
- **새 npm 의존성을 추가하지 마라.**
- **저장소를 추가하지 마라.** 파일 시스템·전역 변수·쿠키에 서버 상태를 남기지 마라. 이유: 무상태 전제(ADR-003)를 문서 없이 우회하는 것이며 CLAUDE.md CRITICAL이다.
- **`lib/`·`services/`의 로직을 라우트에 다시 구현하지 마라.** 이유: 두 벌이 되면 판정 기준이 소리 없이 갈린다.
- **확인된 책을 `proof` 없이 내보내지 마라.** 이유: ADR-006. 다음 요청에서 검증 우회 통로가 된다.
- **후보 있음 + 확인 0건을 `EMPTY_SHELF`로 처리하지 마라.** 이유: 사용자에게 사실이 아닌 설명을 하게 된다 (ADR-005).
- **단계별로 독립된 타임아웃을 두지 마라.** 이유: 합이 함수 상한을 넘겨 504조차 못 돌려준다.
- **`mood/questions`·`recommend` 라우트를 만들지 마라.** 이유: 다음 런이다.
- **`components/`를 만들지 마라.** 이유: TR-011이고 `vitest.config.ts`의 `setupFiles` 선결과제가 걸려 있다.
- **`src/lib/` 파일을 수정하지 마라.** 결함을 발견하면 `summary`에 적어 보고하라.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.**
- **기존 테스트를 깨뜨리지 마라.**
