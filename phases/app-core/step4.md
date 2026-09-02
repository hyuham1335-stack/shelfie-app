# Step 4: ui-booklist — 확인·미확인 책 목록 (TR-011)

`analyze` 응답이 처음으로 화면이 되는 지점이다. "못 한 일을 숨기지 않는다"는 원칙이 여기서 시험된다.

## 읽어야 할 파일

- `/docs/UI_GUIDE.md` — **전문.** 특히 "카드"(확인/미확인의 **모서리 반경이 다르다**) · **"미확인 사유 문구" 표** · "부분 실패 배너" · "안내 문구" 표 · 레이아웃(표지 `w-16`·`line-clamp`·표지 폴백)
- `/docs/ADR.md` — **ADR-005(실패와 데이터 없음의 분리)** · ADR-002
- `/docs/PRD.md` — **US-001·US-002**와 그 AC, FR-011, **5번 Edge Cases 표**
- `/docs/API_SPEC.md` — `POST /api/analyze` 응답 스키마(`identified`·`unidentified`·`failedPhotoIndexes`·`overflowCount`), `POST /api/books/resolve` 응답
- `/docs/ARCHITECTURE.md` — 데이터 흐름 1·3, 레이어 의존 관계
- `src/components/common/` — **step 3의 산출물. `ClaudeText`·`Badge`·`Notice`·`Skeleton`을 그대로 쓴다. 다시 만들지 마라**
- `src/lib/schemas.ts` — `identifiedBookSchema` · `unidentifiedBookSchema` · `unidentifiedReasonSchema`(4종) · `resolvedCandidateSchema`
- `src/app/globals.css` — 색상 토큰 클래스

## 작업

`src/components/booklist/` 아래에 책 목록 표시 조각을 만든다. **API를 부르지 마라** — 데이터는 props로 받는다. 상태 머신과 fetch는 다음 런이다.

만들 것:

| 컴포넌트 | 역할 |
|---|---|
| `IdentifiedBookCard` | 확인된 책 카드. 사실(제목·저자·출판사·쪽수·평점) + `ClaudeText`로 한줄평 |
| `UnidentifiedBookCard` | 미확인 책 카드. **사유 4종에 따라 배지·문구·가능한 행동이 다르다** |
| `BookCover` | 표지 이미지. 없거나 **로드 실패 시** 제목 첫 글자 폴백 |
| `BookList` | 확인 목록 + 미확인 섹션 + 부분 실패 배너 + 안내 문구를 배치 |

### 반드시 지킬 규칙

1. **미확인 사유 4종은 서로 다른 문장이다.** UI_GUIDE의 표를 **그대로** 쓴다:

   | `reason` | 배지 | 설명 문장 | 행동 |
   |---|---|---|---|
   | `unreadable` | 못 읽음 | "책등 글자를 읽지 못했어요" | 제목 직접 입력 |
   | `no_match` | 검색 결과 없음 | "알라딘에서 찾을 수 없는 책이에요 (원서·절판일 수 있어요)" | 제목 고쳐 재검색 |
   | `ambiguous` | 후보 여럿 | "비슷한 책이 여러 권이에요. 어느 쪽인가요?" | **후보 목록에서 바로 선택** (재검색 불필요) |
   | `lookup_failed` | 확인 못 함 | "지금 확인할 수 없었어요. 잠시 후 다시 시도해 주세요" | 재시도 |

   **`lookup_failed`에 절판·원서 안내를 쓰지 마라.** 알라딘이 멈춰서 못 찾은 책에 "절판일 수 있어요"라고 쓰는 것은 시스템 문제를 데이터 문제로 설명하는 것이고, 없는 책을 지어내는 것과 같은 종류의 거짓말이다 (ADR-005). **이 프로젝트에서 가장 조심할 지점이다.**

2. **`lookup_failed` 배지는 중립색이다.** 미확인 앰버가 아니다 — 우리 쪽 문제이므로 사용자에게 주의를 요구하지 않는다.
3. **미확인 책을 접거나 축소하지 마라.** 확인된 책과 **같은 화면**에 둔다. 실패를 드러내는 화면이 감추는 화면보다 신뢰를 얻는다 (UI_GUIDE 원칙 3).
4. **확인/미확인 카드의 모서리 반경을 다르게 한다.** 색뿐 아니라 **형태로도** 구분한다. 균일한 반경은 안티패턴이기도 하다.
   ```
   확인된 책:  rounded-md bg-card border border-line p-4
   미확인 책:  rounded-sm bg-muted-surface border border-dashed border-unverified/40 p-4
   ```
5. **한줄평은 `ClaudeText`로만 렌더한다.** 사실 필드와 같은 층위에 두지 마라 (ADR-002). 빈 문자열이면 블록 자체가 없다.
6. **평점은 "독자 8.6" 형태로 출처를 드러낸다.** 별 아이콘을 쓰지 마라.
7. **표지 폴백**: 표지가 없거나 **URL이 있어도 로드에 실패하면**(404·네트워크) 제목 첫 글자를 `bg-muted-surface`에 표시한다. **깨진 이미지 아이콘을 노출하지 마라.** `alt`는 "{제목} 표지" — 정보이므로 빈 `alt`를 쓰지 않는다.
8. **긴 텍스트를 자른다.** 제목 `line-clamp-2`, 저자·출판사 `line-clamp-1`. 전체 제목은 `title` 속성으로 남긴다.
9. **미확인 원문은 `font-mono`** — 읽힌 그대로임을 형태로 알린다.
10. **부분 실패 배너는 목록 위에 둔다.** 결과를 다 본 뒤에 실패를 알리면 이미 목록이 전부인 줄 안다. 문구는 **분모를 함께** 밝힌다("사진 3장 중 1장은 읽지 못했어요").
11. **안내 문구**(UI_GUIDE 표): `overflowCount > 0` → "50권까지만 보여드려요 ({n}권 더 있음)", 확인 0건·미확인만 → "읽어낸 책을 알라딘에서 확인하지 못했어요"(중앙 정렬 빈 상태).
12. **`ambiguous`는 재검색이 아니라 선택이다.** 후보가 함께 왔으면 그 목록에서 바로 고르게 한다. 다른 3종과 같은 UI로 뭉개지 마라.
13. **행동은 props 콜백으로 위임한다.** 이 step은 fetch하지 않는다. `onResolve`·`onRetryPhoto`·`onSelectCandidate` 같은 콜백을 받는다.
14. **UI_GUIDE 안티패턴 표를 어기지 마라.** 카드 hover 시 이동·확대·그림자 변화도 금지다.
15. **서버 전용 모듈을 import하지 마라** (`services/*` · `lib/proof.ts` · `lib/env.ts`).

### 테스트 (먼저 작성한다)

`src/components/booklist/*.test.tsx`.

> ⚠ **`@testing-library/jest-dom` 매처는 등록돼 있지 않다**(`vitest.config.ts`는 고칠 수 없다 — `main_owned_paths`). 표준 `expect`로 단언하라.

- 확인된 책 카드가 제목·저자·출판사·쪽수·평점을 렌더한다
- 평점이 **"독자 8.6" 형태**이고 별 아이콘이 없다
- `pages`·`aladinRating`이 `null`이면 그 줄을 그리지 않는다 (없는 값을 0으로 표시하지 않는다)
- 한줄평이 `ClaudeText`로 렌더되고, **빈 문자열이면 블록이 없다**
- **미확인 사유 4종이 각각 다른 문장을 렌더한다** (ADR-005 회귀 — 삭제하지 마라)
- **`lookup_failed` 문구에 "절판"·"원서"가 들어 있지 않다** (ADR-005 회귀 — **절대 삭제하지 마라**)
- **`lookup_failed` 배지가 중립색이고 `text-unverified`가 아니다**
- 확인 카드와 미확인 카드의 **모서리 반경 클래스가 다르다**
- 표지 URL이 없으면 제목 첫 글자 폴백이 나온다
- **표지 `img`에 `error` 이벤트가 나면 폴백으로 바뀐다** (깨진 이미지 회귀 — 삭제하지 마라)
- 표지 `alt`가 "{제목} 표지"이고 빈 문자열이 아니다
- 긴 제목에 `line-clamp-2`가 걸리고 `title` 속성에 전체 제목이 있다
- 부분 실패 배너가 **목록보다 앞에** 렌더되고 분모를 포함한다
- `overflowCount > 0`이면 안내 문구가 나온다
- 확인 0건·미확인만이면 빈 상태 문구가 나온다
- `ambiguous`에 후보가 있으면 **선택 UI**가 나오고, 콜백이 선택한 후보를 넘긴다
- 안티패턴 회귀: `backdrop-blur` · `bg-gradient-to` · `rounded-2xl` · hover 이동/확대 클래스가 없다

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
   - **`lookup_failed`가 `no_match`와 다른 문장·다른 색으로 나오는가?** (ADR-005)
   - 한줄평이 사실과 다른 시각 층위인가? (ADR-002)
   - 미확인 책이 접히거나 축소되지 않고 같은 화면에 있는가?
   - `components/`가 서버 전용 모듈을 import하지 않는가?
   - `CLAUDE.md`의 CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/app-core/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(export한 컴포넌트명과 콜백 props를 포함하라. 다음 런의 상태 머신이 쓴다)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- **`index.json`의 타임스탬프 필드를 쓰지 마라.** 실행기가 기록한다.
- **`lookup_failed`에 절판·원서·"찾을 수 없다"류 문구를 쓰지 마라.** 이유: 시스템 문제를 데이터 문제로 설명하는 것이고, ADR-005가 금지한 바로 그것이다.
- **미확인 책을 접거나 별도 화면으로 숨기지 마라.** 이유: "못 한 일을 숨기지 않는다"가 이 제품의 신뢰 근거다.
- **한줄평을 사실과 같은 층위로 렌더하지 마라.** 이유: ADR-002.
- **API를 부르지 마라(fetch 금지).** 이유: 상태 머신과 데이터 흐름은 다음 런이다. 행동은 콜백으로 위임한다.
- **`src/app/page.tsx`를 고치지 마라.** 이유: 같은 이유다.
- **`src/components/common/`을 다시 만들거나 고치지 마라.** 이유: step 3이 확정한 계약이다. 결함은 `summary`로 보고하라.
- **`vitest.config.ts`를 고치지 마라**(jest-dom 매처 등록 포함). 이유: `main_owned_paths`다.
- **새 최상위 디렉토리를 만들지 마라.** 이유: 소유 경계 밖 경로가 생기면 `doctor`가 깨진다.
- **새 npm 의존성을 추가하지 마라.**
- **`harness/` · `docs/` · `scripts/` · `.claude/` · 루트의 `*.ts` · `.env*` 를 고치지 마라.** 이유: `main_owned_paths`다.
- **기존 테스트를 깨뜨리지 마라.**
