# Step 0: original-photo-source

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ARCHITECTURE.md` — **"상태 관리" 절이 이 step의 계약이다.** 특히 `세션이 들고 있는 것은 원본 File 이다` 문단과 재시도 간격 문단, 그리고 상태도. 리듀서가 `lib/session.ts`에 순수 함수로 있고 화면에 `dispatch`를 넘기지 않는다는 규칙도 본다
- `/docs/PRD.md` — 5번 Edge Cases 표의 **"오프라인·네트워크 단절"**(고른 사진은 그대로 남는다) · **"부분 실패"**(이 사진만 다시 시도) · **"파노라마·초고해상도"**(짧은 변 600px 경고) · **"같은 사진 중복 선택"**. FR-010(재시도 상한과 간격)도 본다
- `/docs/UI_GUIDE.md` — 업로드 화면의 버튼·비활성 상태 규칙
- `src/app/page.tsx` — 세션 상태 머신과 재시도 경로 전부. 이 step이 고칠 파일이다
- `src/components/upload/UploadScreen.tsx` — 사진 선택·리사이즈·`onAnalyze` 호출. 이 step이 고칠 파일이다

위 소스 파일은 **프롬프트에 이미 실려 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

## 직접 읽어라 (첨부하지 않았다)

- `src/lib/image.ts` — **통독하지 마라.** 첨부하지 않은 것은 의도다. 네가 여기서 필요한 것은 `resizeToDataUri`·`checkOutputBudget`·`SelectedFileMeta`·`RejectReason`의 **시그니처와 반환 형태뿐**이고, 그 판정 로직을 고치지 않는다. `grep -n "^export"` 한 번이면 끝난다
- 네가 고칠 파일의 테스트(`src/app/page.test.tsx`·`src/components/upload/UploadScreen.test.tsx`)는 필요한 만큼 읽어라

## 작업

**런 #5가 올린 보고 ⑦을 닫는다 — 다섯 런째 이월된 항목이다.**

지금 세션이 들고 있는 것은 사용자가 고른 원본 `File`이 아니라 **이미 리사이즈된 data URI**다. `UploadScreen`이 선택 단계에서 `resizeToDataUri`를 돌려 `onAnalyze(dataUris, photoCount)`로 넘기고, `page.tsx`는 그 문자열 배열을 `photos` 상태에 담아 재시도에 재사용한다. 그래서 재업로드는 면했지만 **EXIF 보정·JPEG 품질·짧은 변 경고를 다시 고를 수 없다** — 그 판정은 전부 `lib/image.ts`가 원본 비트맵에서 내리는 것이고, 한 번 줄인 결과에는 되돌릴 근거가 남아 있지 않다.

`docs/ARCHITECTURE.md` 상태 관리 절이 이번에 계약을 명시했다:

> 세션은 사용자가 고른 **원본 `File[]`을 상태로 보존하고**, 전체 재분석도 "이 사진만 다시 시도"도 그 원본에서 `lib/image.ts`의 리사이즈를 **다시 태운다.** 리사이즈 결과는 그때그때 파생되는 값이지 세션이 기억하는 값이 아니다.

### 1. 업로드 → 페이지 경계를 원본으로 바꾼다

`UploadScreen`이 리사이즈 결과가 아니라 **선택된 원본 파일**을 페이지로 넘기게 한다. 시그니처는 네가 정하되 아래를 만족해야 한다:

```ts
// 지금:  onAnalyze: (dataUris: string[], photoCount: number) => void;
// 뒤:    페이지가 원본 File 을 받는다. 파생값(미리보기·해시·리사이즈 결과)을
//        함께 넘기는 것은 무방하지만, **원본이 없는 형태는 안 된다.**
```

- **선택 단계의 검증은 그대로 둔다.** 장수 상한·개별 파일 크기·MIME 거부·중복 해시·짧은 변 경고는 지금 `UploadScreen`이 하는 그대로다. 이 step은 **무엇을 들고 다니는가**만 바꾼다.
- **`checkOutputBudget`(요청 합계 4MB) 검사를 잃어버리지 마라.** 지금은 리사이즈 직후 한 번 돈다. 리사이즈가 페이지로 옮겨가면 그 검사도 함께 옮겨가야 하고, 옮기지 않으면 상한이 조용히 사라진다.
- 이미 그려진 썸네일을 위해 파생값을 곁에 캐시하는 것은 무방하다. 다만 **재시도의 입력은 언제나 원본이어야 한다.**

### 2. `page.tsx`의 세 경로가 전부 원본에서 출발한다

`handleAnalyze` · `startRetry` · `handleRetryPhotos` 셋이 지금은 `photos: string[]`를 돌려쓴다. 셋 다 원본에서 다시 리사이즈하도록 바꾼다.

**깨뜨리면 안 되는 불변식 넷** — 어기면 이 step이 고치려던 것보다 나쁜 상태가 된다:

1. **`photoIndex`의 의미가 흔들리면 안 된다.** 응답의 `photoIndex`는 **이번에 보낸 배열**을 기준으로 매겨진다(`startRetry`의 주석이 그것을 말한다). "이 사진만 다시 시도"가 부분집합을 보내면 다음 응답의 인덱스는 그 부분집합 기준이다. 원본 배열로 바꾸면서 이 대응이 어긋나면 사용자가 3번 사진을 고쳤는데 1번이 다시 도는 일이 생긴다.
2. **재시도 간격은 `handleRetryPhotos` 한 곳에서만 건다** (FR-010, 0→5→15초). 리사이즈가 비동기로 끼어들면서 간격 로직이 둘로 갈라지지 않게 하라 — 주석이 그 이유를 이미 적어 두었다.
3. **타이머 정리를 잃지 마라.** `RESTARTED`와 언마운트에서 반드시 정리한다. 정리하지 않으면 버려진 세션에 유령 분석 호출이 나가고 모델 비용이 든다.
4. **리사이즈는 이제 요청마다 도는 비동기 작업이다.** 재시도를 두 번 눌러 두 리사이즈가 겹치거나, 리사이즈 도중 사용자가 처음으로 돌아가는(`RESTARTED`) 경우에 **낡은 결과가 뒤늦게 도착해 상태를 덮지 않도록** 하라. 대기 중 재진입은 이미 `canRetryAnalyze`·`isWaitingRetry`로 막고 있으니 그 관문을 우회하지 마라.

### 3. 테스트

TDD다 — 테스트를 먼저 쓰고 통과하는 구현을 쓴다 (CLAUDE.md CRITICAL).

최소한 이것들을 덮어라:

- 전체 재분석과 "이 사진만 다시 시도"가 **원본에서 다시 리사이즈한다**(리사이즈 함수가 재시도마다 다시 호출된다 — 첫 호출 결과를 재사용하지 않는다)
- 실패한 사진만 재시도할 때 보내는 배열이 그 사진만 담고, 다음 응답의 `photoIndex`가 그 배열 기준으로 해석된다
- 재시도 상한 3회와 간격 0→5→15초가 그대로 산다
- `RESTARTED` 이후에 도착한 낡은 리사이즈·응답이 새 상태를 덮지 않는다
- 요청 합계 상한(`checkOutputBudget`) 위반이 여전히 잡힌다

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
   - 화면 컴포넌트에 `dispatch`를 넘기지 않았는가? (ARCHITECTURE 상태 관리 — 값은 props로, 행동은 콜백으로)
   - 상태 전이 규칙이 `lib/session.ts` 밖으로 새어 나가지 않았는가?
   - `components/`·`page.tsx`가 `services/*`·`lib/proof`·`lib/prompts`를 import하지 않았는가? (레이어 경계)
   - `localStorage`·`sessionStorage`·쿠키에 아무것도 남기지 않았는가? (ADR-003 무상태)
   - CLAUDE.md CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/deploy-ready/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에는 **다음 step이 알아야 할 것**을 담아라 — 바뀐 `onAnalyze` 시그니처, 원본을 담는 상태 필드 이름, 리사이즈가 이제 어디서 도는지.

## 금지사항

- **`src/lib/image.ts`를 고치지 마라.** 이유: 이 step은 리사이즈 **판정**을 바꾸지 않는다. 무엇을 들고 다니는가만 바꾼다. 그 파일의 규칙(EXIF·품질·짧은 변)이 바뀌면 TR-001의 기준선이 흔들리고 골든 인식률과도 얽힌다
- **알라딘 호출 상한·접근성·Edge Case 회귀에 손대지 마라.** 이유: 각각 step 1·2·3의 몫이다. 두 곳에서 고치면 한쪽만 고쳐지는 날이 온다
- **`docs/`·`harness/`·`scripts/`·`.claude/`·`.github/`·리포 루트의 `*.ts`·`*.json`·`*.mjs`를 고치지 마라.** 이유: 메인 소유 경로다. 이 step이 쓸 계약은 이미 `docs/ARCHITECTURE.md` 상태 관리 절에 적혀 있다. 부족하다고 느끼면 고치지 말고 `summary`에 적어라
- **새 npm 의존성을 넣지 마라.** 이유: CLAUDE.md CRITICAL — ADR이 먼저다. 아홉 런 동안 0건이었다
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다. 네가 쓰면 실측이 오염된다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
