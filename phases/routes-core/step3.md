# Step 3: resolve-route — 미확인 책 재검색 엔드포인트 (TR-008)

## 읽어야 할 파일

- `/docs/API_SPEC.md` — **`POST /api/books/resolve` 절 전문이 이 step의 계약이다.** 공통 규약과 에러 응답 규약, 그리고 문서 끝의 "무엇을 보장하고 무엇을 보장하지 못하는가" 표도 읽어라
- `/docs/PRD.md` — **US-002(못 읽어낸 책을 직접 고쳐 찾기)** 와 그 AC, FR-011
- `/docs/TRD.md` — 3번 표의 TR-008 행, 7번 환경변수·시간 예산
- `/docs/ADR.md` — **ADR-006(증명 동반)** · ADR-002 · ADR-005
- `/docs/ARCHITECTURE.md` — 데이터 흐름 3(미확인 책 재검색), 레이어 의존
- `src/lib/schemas.ts` — `resolveRequestSchema` · `resolveResponseSchema` · `resolvedCandidateSchema`가 이미 있다
- `src/lib/proof.ts` — `issueProof`
- `src/services/aladin.ts` — `searchByTitle` · `lookupFacts` (step 0에서 확장됨)
- `src/app/api/analyze/route.ts` — 이전 step 산출물. **라우트 구조를 맞춘다**

## 작업

`src/app/api/books/resolve/route.ts`를 새로 만든다. 사용자가 고친 제목으로 알라딘을 다시 찾아 후보를 돌려준다.

### 왜 이 경로에 서명이 필요한가 (이해한 뒤 구현하라)

`API_SPEC`이 명시했다: *"후보에도 `proof`를 붙인다. 사용자가 고른 책이 추천 요청에 합류할 때 확인된 책과 동등한 증명을 갖고 있어야 하기 때문이다. **이 경로에 서명이 없으면 US-002가 곧 검증 우회 통로가 된다.**"*

`recommend`가 `proof`를 검증하는데 `resolve`가 서명 없는 책을 돌려주면, 공격자는 `analyze`를 거치지 않고 `resolve`로 아무 책이나 받아 추천에 밀어 넣을 수 있다. **`analyze`만 막고 `resolve`를 열어 두면 자물쇠를 달고 옆문을 열어 두는 것이다.**

### 계약 (API_SPEC)

**요청**: `sessionId`(UUID v4) · `query`(1~200자) · `author`(선택)

**응답 200**: `candidates[]` — 각 항목은 `isbn13`·`title`·`author`·`publisher`·`coverUrl`·`pages`·`aladinRating`·`aladinLink`·**`proof`**

| 상황 | 응답 |
|---|---|
| 빈 문자열 또는 200자 초과 | **400** |
| 검색 결과 0건 | **404 `NOT_FOUND_IN_ALADIN`** |
| 알라딘 5xx·타임아웃 | **502** (`no_match`가 아니다 — ADR-005) |
| 10s 초과 | **504** |

### 반드시 지킬 규칙

1. **후보 전원에 `proof`를 발급한다** (ADR-006). 하나라도 빠지면 검증 우회 통로가 열린다.
2. **최대 5건을 알라딘 검색 순위 그대로 반환한다.** 서버가 임의로 1건을 고르지 마라 — 선택은 사용자에게 맡긴다는 것이 US-002의 설계다. 상한은 `MAX_ALADIN_CANDIDATES`(`env.ts`)를 쓴다.
3. **이 응답의 책에는 `claudeNote`가 없다.** 사용자가 확정한 뒤 클라이언트가 목록에 합류시키며 한줄평은 비워 둔다. Claude를 부르지 마라.
4. **`resolvedCandidateSchema`는 `aladinFactsSchema` + `proof`다.** 즉 `pages`·`aladinRating`·`aladinLink`가 필요하므로 step 0의 `lookupFacts`를 써야 한다.
5. **검색 결과 0건(404)과 조회 실패(502)를 구분하라.** 전자는 "알라딘에 없다", 후자는 "지금 못 찾았다"다 (ADR-005).
6. **ISBN13이 없는 레코드는 후보에 넣지 마라.** 스키마가 이미 강제한다.
7. **응답을 `resolveResponseSchema`로 검증한 뒤 반환하라.**
8. **저장소를 만들지 마라** (ADR-003). 요청 스코프 브레이커도 요청마다 새로 만든다.
9. **`export const maxDuration`을 설정하라** — 이 라우트의 타임아웃은 10s다.
10. **`analyze` 라우트와 구조를 맞춰라** — 검증 → 처리 → 응답 스키마 검증의 형태를 통일한다.

### 테스트 (먼저 작성한다)

`src/app/api/books/resolve/route.test.ts`. `services/aladin.ts`를 모킹한다.

- 정상: 후보 3건이 오고 응답이 `resolveResponseSchema`를 통과한다
- **후보 전원에 `proof`가 있고 `verifyProof`로 검증된다** — 이 테스트는 삭제하지 마라 (ADR-006 회귀, US-002 검증 우회 차단)
- 빈 문자열 `query` → 400
- 201자 `query` → 400
- **검색 결과 0건 → 404 `NOT_FOUND_IN_ALADIN`**
- **알라딘 5xx → 502이고 404가 아니다** (삭제 금지 — ADR-005 회귀)
- 후보가 6건 이상 와도 **5건만** 반환한다
- 알라딘 검색 순위가 보존된다 (서버가 재정렬하지 않는다)
- `pages`·`aladinRating`이 `null`인 책도 정상 반환된다
- 응답에 `claudeNote` 필드가 없다
- `author`를 생략해도 동작한다

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
   - 후보 전원에 `proof`가 있는가? (US-002가 검증 우회 통로가 되지 않는가)
   - 404와 502를 구분하는가? (ADR-005)
   - `analyze` 라우트와 구조가 일관되는가?
   - 서버 상태를 남기지 않았는가? (ADR-003)
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/routes-core/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** 실행기가 기록한다.
- **후보를 `proof` 없이 내보내지 마라.** 이유: `recommend`가 서명을 검증하는데 이 경로가 열려 있으면 검증 전체가 무의미해진다 (ADR-006, API_SPEC 명시).
- **서버가 후보 1건을 임의로 고르지 마라.** 이유: 선택을 사용자에게 맡기는 것이 US-002의 설계다.
- **Claude를 호출하지 마라.** 이유: 이 응답에는 `claudeNote`가 없다.
- **검색 결과 0건과 조회 실패를 같은 응답으로 뭉개지 마라.** 이유: ADR-005.
- **실제 알라딘 API를 호출하지 마라.** 테스트는 모킹한다 (TRD 8번).
- **새 npm 의존성을 추가하지 마라.**
- **저장소를 추가하지 마라** (ADR-003, CLAUDE.md CRITICAL).
- **`mood/questions`·`recommend` 라우트를 만들지 마라.** 이유: 다음 런이다.
- **`components/`를 만들지 마라.**
- **`src/lib/`·`src/services/` 파일을 수정하지 마라.** 결함을 발견하면 `summary`에 적어 보고하라.
- **`harness/` · `docs/` · `scripts/` · `.claude/` · `.env.example` 을 고치지 마라.**
- **기존 테스트를 깨뜨리지 마라.**
