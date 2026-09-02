# Step 2: a11y-contract

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 설계 의도를 파악하라:

- `/docs/TRD.md` — **6.6 접근성 절이 이 step의 계약 전부다.** 다섯 항목(키보드 도달 · 대비 WCAG AA · 표지 `alt` · 미확인 배지의 텍스트 라벨 · `aria-live` 진행 상태)이 거기 있다. TR-011의 AC와 8번 테스트 범위(컴포넌트 레벨)도 본다
- `/docs/UI_GUIDE.md` — 색상표(대비 판정의 기준)와 컴포넌트 규칙, 안티패턴 목록, **"Claude 생성 텍스트 블록"**
- `/docs/PRD.md` — 5번 화면 인벤토리와 Edge Cases. 각 화면이 무엇을 그리기로 했는지가 접근성 판정의 대상 목록이다
- `/docs/ARCHITECTURE.md` — 레이어 경계와 상태 관리(화면에 `dispatch`를 넘기지 않는다)
- `/docs/ADR.md` — **ADR-005**(`lookup_failed` ≠ `no_match` — 미확인 사유를 색으로만 가르면 이 결정이 화면에서 무너진다) · **ADR-002**(사실과 해석의 시각 층위 분리)
- `src/components/booklist/BookList.tsx` · `src/components/booklist/UnidentifiedBookCard.tsx` · `src/components/booklist/BookCover.tsx`
- `src/components/upload/UploadScreen.tsx` · `src/components/upload/PhotoPicker.tsx` · `src/components/upload/PhotoThumbnails.tsx` · `src/components/upload/RejectedNotice.tsx` · `src/components/upload/CaptureGuide.tsx`
- `src/components/mood/MoodInput.tsx` · `src/components/mood/GuidedQuestions.tsx`
- `src/components/recommend/RecommendationList.tsx` · `src/components/recommend/RecommendationCard.tsx`
- `src/components/common/ErrorBanner.tsx` · `src/components/common/Badge.tsx` · `src/components/common/AladinLink.tsx` · `src/components/common/ClaudeText.tsx` · `src/components/common/Skeleton.tsx` · `src/components/common/Notice.tsx`

위 소스 파일은 **프롬프트에 이미 실려 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

**컴포넌트 18개가 전부 실려 있다.** 이 step의 작업 대상은 그 안에 있으니, 화면 전체를 다시 훑으려고 `src/`를 뒤지지 마라.

## 직접 읽어라 (첨부하지 않았다)

- `src/components/booklist/IdentifiedBookCard.tsx` — 첨부 상한(60,000자)에 걸려 유일하게 빠진 컴포넌트다. 접근성 5개 항목 중 이 카드에만 있는 것은 없다(`alt`는 `BookCover`, 배지는 `Badge`, 생성 텍스트는 `ClaudeText`가 그린다). **필요할 때만** 읽어라
- 네가 고칠 컴포넌트의 기존 테스트(`*.test.tsx`)는 필요한 만큼 읽어라

## 작업

**TRD 6.6 접근성 다섯 항목을 회귀 테스트로 잠근다.** 지금 이 다섯 줄은 문서에만 있고, 일부는 코드가 이미 지키고 있지만 **지켜지는지 검사하는 것이 없다.** 누가 `alt`를 지우거나 배지에서 텍스트를 빼도 아무 테스트도 깨지지 않는다.

이 step의 산출물은 **새 화면이 아니라 잠긴 계약**이다. 순서는 항상 같다: ① 계약을 검사하는 테스트를 먼저 쓴다 ② 실패하면 컴포넌트를 고쳐 통과시킨다 ③ 이미 통과하면 그대로 둔다. TDD다 (CLAUDE.md CRITICAL).

### 잠가야 하는 다섯 줄

**① 키보드만으로 모든 인터랙션에 도달한다.** TRD가 이름으로 지목한 셋은 반드시 덮어라 — 파일 선택(`PhotoPicker`) · 미확인 수정 입력(`UnidentifiedBookCard`) · 추천 수락 버튼(`RecommendationCard`). 문답 선택지(`GuidedQuestions`)와 기분 입력(`MoodInput`)도 같은 축이다.

- 검사는 **Tab 순서와 활성화**로 한다. `userEvent.tab()`으로 도달하고 `{Enter}`/`{Space}`로 눌리는지 본다. `fireEvent.click`만 쓰면 키보드 도달을 전혀 검사하지 못한다 — 마우스로만 되는 요소도 통과한다
- **`div`에 `onClick`을 달아 버튼처럼 쓰는 곳이 있으면 그것이 이 항목의 진짜 대상이다.** 고칠 때는 `role`·`tabIndex`를 덧붙이지 말고 **`<button type="button">`으로 바꿔라** — 시맨틱 요소가 이미 있는데 ARIA로 흉내 내는 것이 UI_GUIDE가 말하는 안티패턴이다
- 비활성 상태(재시도 대기 중 등)는 **감추지 않고 비활성**한다(ARCHITECTURE 상태 관리). 비활성 버튼이 포커스를 삼키지 않는지도 본다

**② 표지 이미지의 `alt`는 "{제목} 표지"다.** 장식이 아니라 정보이므로 빈 `alt`를 쓰지 않는다. `BookCover`가 이미 `label`을 받는다 — 그 값이 실제로 제목을 담아 렌더되는지, 제목이 비어 있을 때 `"undefined 표지"` 같은 문자열이 새지 않는지 검사하라. `PhotoThumbnails`의 미리보기도 같은 축에서 본다(그쪽은 사용자가 고른 사진이므로 문구가 다를 수 있다 — 지금 코드가 쓰는 문구를 계약으로 고정하면 된다).

**③ 미확인 배지는 색상만으로 구분하지 않는다.** 텍스트 라벨을 함께 표시한다. **이 항목이 ADR-005와 직접 맞물린다** — `lookup_failed`(지금 확인 못 함)와 `no_match`(알라딘에 없음)는 사용자에게 **다른 사실**인데, 그 차이가 배지 색으로만 표현되면 색을 구분하지 못하는 사용자에게는 두 사유가 같은 것이 된다. 사유별 문구가 텍스트로 존재하는지 검사하라. `Badge`의 각 `kind`에 대해 접근 가능한 이름이 비어 있지 않은지도 본다.

**④ 분석 진행 상태를 `aria-live="polite"`로 알린다.** 이미 여러 곳에 `role="status"`가 있다. 검사할 것은 존재가 아니라 **전이**다 — 분석이 시작될 때 라이브 영역에 실제로 텍스트가 들어오고, 끝나면 그 자리가 낡은 문구를 남기지 않는지. 진행 표시가 `Skeleton`처럼 장식인 경우 스크린 리더에서 숨겨져 있는지도 본다(장식과 정보를 둘 다 읽어 주면 소음이 된다).

**⑤ 텍스트 대비 WCAG AA(4.5:1).** 실제 렌더 색을 계산하는 테스트는 Tailwind 클래스만으로는 성립하지 않는다. **없는 검사를 있는 척 만들지 마라.** 대신 잠글 수 있는 것을 잠근다 — 본문·보조 텍스트·배지에 쓰는 **색 조합이 UI_GUIDE 색상표가 허용한 쌍인지**를 검사하는 형태다(예: 허용 쌍 목록을 테스트가 들고 있고, 컴포넌트가 그 밖의 조합을 쓰면 실패). 이 방식으로 덮이지 않는 부분은 **`summary`에 무엇이 남았는지 적어라** — 재지 못한 것을 통과로 적지 않는 것이 이 리포의 규율이다(골든 세트의 `skip`과 같다).

### 어디에 쓰는가

컴포넌트별 테스트 파일에 나눠 넣어도 되고, 계약 하나를 여러 컴포넌트에 걸쳐 검사하는 파일을 새로 만들어도 된다. **선택했으면 그 이유를 `summary`에 적어라.** 다만 **각 테스트가 TRD 6.6의 어느 줄을 잠그는지 이름으로 알 수 있어야 한다** — 다음 사람이 깨진 테스트를 보고 어떤 계약이 무너졌는지 즉시 알아야 하기 때문이다.

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
   - 시맨틱 요소로 될 일을 ARIA 속성으로 흉내 내지 않았는가? (UI_GUIDE 안티패턴)
   - 사실(알라딘)과 해석(Claude)의 시각 층위를 섞지 않았는가? 생성 텍스트가 `ClaudeText` 밖으로 새지 않았는가? (ADR-002 · CLAUDE.md CRITICAL)
   - 미확인 사유 두 종(`lookup_failed`·`no_match`)이 문구로 갈리는가? (ADR-005)
   - `components/`가 `services/*`·`lib/proof`·`lib/prompts`를 import하지 않았는가?
   - CLAUDE.md CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/deploy-ready/index.json`의 step 2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에 **다섯 항목 각각이 어떻게 잠겼는지**와 **⑤에서 덮지 못한 부분**을 적어라.

## 금지사항

- **화면의 정보 구조를 바꾸지 마라.** 이유: 이 step은 접근성 계약을 잠그는 것이지 화면을 다시 만드는 것이 아니다. 접근성을 이유로 목록을 가르거나 섹션을 옮기면 런 #6·#7이 닫은 결정(두 출처가 한 목록으로 선다)이 되돌아간다
- **스타일 토큰을 새로 만들지 마라.** 이유: 색은 `UI_GUIDE`가 단일 출처다. 대비가 모자라면 새 색을 만들지 말고 **`summary`에 보고로 올려라** — 색상표 변경은 메인이 문서에서 한다
- **`src/app/page.tsx`·`src/lib/`·`src/services/`·`src/app/api/`를 고치지 마라.** 이유: step 0이 `page.tsx`를, step 1이 `lib/`을 이미 고쳤다. 이 step의 대상은 `src/components/**`다. 컴포넌트 밖을 고쳐야 접근성이 완성된다고 판단되면 고치지 말고 `summary`에 적어라
- **없는 검사를 있는 척 만들지 마라.** 이유: `expect(true).toBe(true)`나 항상 통과하는 대비 검사는 **통과를 찍는 skip**이다. 이 리포에서 가장 나쁜 실패는 워커가 규칙을 못 본 채 지켰다고 보고하는 것이다
- **`docs/`·`harness/`·`scripts/`·`.claude/`·`.github/`·리포 루트의 `*.ts`·`*.json`·`*.mjs`를 고치지 마라.** 이유: 메인 소유 경로다
- **새 npm 의존성을 넣지 마라** (접근성 검사 라이브러리 포함). 이유: CLAUDE.md CRITICAL — ADR이 먼저다. 필요하다고 판단되면 `summary`에 근거와 함께 적어라
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
