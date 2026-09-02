# Step 3: golden-runner

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/TRD.md` — **8번 "골든 인식률 계약"이 이 step의 계약 전부다.** 세트 구조·매니페스트·판정 규약·skip 사유 3종·결과 기록 위치·실행 명령. **9번 배포 전 수동 체크리스트**와 목업 모드 절도 반드시 본다
- `/docs/ARCHITECTURE.md` — 레이어 의존 관계와 **"골든 러너는 프로덕션 코드가 아니라 테스트 코드다"** 규칙. 흐름 1(사진 분석)이 추출 → 대조 순서를 보여 준다
- `/docs/ADR.md` — **ADR-010**이 이 step의 근거다. ADR-002(오확인이 왜 치명적인가) · ADR-005(`lookup_failed` ≠ `no_match`)도 본다
- `/docs/PRD.md` — FR-003(확인/미확인 판정)과 리스크 표의 "책등 인식률이 목표 미달"
- `src/services/aladin.ts` — 알라딘 래퍼. `searchByTitle`·`createRequestBreaker`·`SearchOptions`
- `src/lib/match.ts` — `judge`·`LookupOutcome`·`MatchVerdict`
- `src/lib/golden-manifest.ts` — step 0 산출물
- `src/lib/golden-score.ts` — step 1 산출물
- `src/lib/golden-report.ts` — step 2 산출물

위 소스 파일은 **프롬프트에 이미 실려 있다. 다시 읽지 마라.** 단 네가 고친 뒤의 내용은 첨부본에 반영되지 않는다.

## 직접 읽어라 (첨부하지 않았다)

- `src/services/anthropic.ts` — **반드시 읽어라.** 첨부하지 않은 것은 의도다: 이 파일은 39,233자인데 네가 여기서 쓰는 것은 `extractFromPhoto`와 `ExtractOptions`·`ExtractOutcome`뿐이다. **통독하지 말고 그 세 심볼과 목업 분기(`getAnthropicApiKey()`가 `null`일 때의 동작)만 확인하라.** grep이 통독보다 싸다

## 작업

골든 인식률 러너를 만든다. **이것은 테스트 파일 하나다** — 프로덕션 코드가 아니다 (ADR-010 · ARCHITECTURE 레이어 규칙).

### `src/services/shelf.golden.test.ts` (신규)

이 파일만 만든다. `npm test`는 이 파일을 돌리지 않고(`vitest.config.ts`가 exclude한다), `npm run test:golden`이 `vitest.golden.config.ts`로 돌린다.

흐름:

1. **세트를 찾는다.** `lib/env.ts`의 접근자로 `GOLDEN_SET_DIR`을 읽는다. 없으면 `no_set_dir`로 skip.
2. **매니페스트를 읽고 판정한다.** `{dir}/manifest.json`을 `fs`로 읽어 `JSON.parse` → `parseGoldenManifest`. 파일이 없거나 `JSON.parse`가 던지거나 파싱이 `failed`면 `no_manifest`로 skip하고 **`detail`에 이유를 남긴다.**
3. **키를 확인한다.** `ANTHROPIC_API_KEY`와 `ALADIN_TTB_KEY` 중 하나라도 없으면 `no_api_key`로 skip. **이 검사를 빼지 마라 — 이 step에서 가장 중요한 한 줄이다** (아래 규칙 1).
4. **사진마다**: 파일을 읽어 data URI로 만들고 → `extractFromPhoto` → 후보를 알라딘으로 대조(`searchByTitle` + `judge`) → 확인 승격분을 모은다.
5. **판정한다.** `scorePhoto` → `aggregateScores`.
6. **기록한다.** `renderGoldenReport`를 콘솔에 찍고, `toGoldenReportJson`을 `reports/golden/{ISO8601}.json`에 쓴다. 디렉토리는 없으면 만든다.
7. **단정한다.** `score.passed`가 참인지 검사한다.

핵심 규칙 — 어기면 이 게이트가 반대로 작동한다:

1. **키가 없으면 반드시 skip하라. 절대로 그냥 돌리지 마라.** `services/anthropic.ts`는 `ANTHROPIC_API_KEY`가 없으면 목업을 돌려준다(TRD 9번 목업 모드). 목업 위에서 골든을 돌리면 **재현율이 100%로 나오고 게이트가 통과를 찍는다** — 모델 품질을 재려던 장치가 정확히 반대로 작동한다. 이 프로젝트는 "가짜 책이 확인된 책으로 노출"을 탐지할 신호가 달리 없고(TRD 6.4), 그 유일한 감지 장치가 스스로를 속이는 것이 여기서 가능한 최악의 결함이다 (ADR-010).
2. **skip은 통과가 아니다.** skip할 때 `expect`를 통과시키지 말고 **vitest의 skip 기제**를 써라(`describe.skipIf`/`ctx.skip()` 등 — 이 리포의 vitest 버전에서 되는 것을 쓴다). 그리고 skip 사유를 **콘솔과 리포트 파일 양쪽에** 남겨라. 사유를 남기지 않은 skip은 조용히 사라진다.
3. **`ExtractOutcome`의 실패를 성공처럼 다루지 마라.** `status: "failed"`인 사진은 후보 0건으로 접지 말고 **그 사진의 실패 사유를 리포트에 남겨라.** 이유: `refusal`·`timeout`·`upstream`은 모델의 판독 능력과 무관한데, 그것을 "못 읽었다"로 접으면 재현율이 인프라 문제 때문에 떨어진 것을 모델 탓으로 적는다. 이 리포가 실패와 데이터 없음을 끝까지 가르는 것과 같은 규율이다 (ADR-005 · CLAUDE.md CRITICAL).
4. **알라딘 조회 실패(`lookup_failed`)를 `no_match`로 만들지 마라.** `judge`가 이미 둘을 가른다 — 그 값을 그대로 나르고, **`lookup_failed`인 책은 오확인 판정의 분자에도 분모에도 넣지 마라.** 확인되지 않은 것과 잘못 확인된 것은 다르다.
5. **직렬로 돌려라.** 사진을 병렬로 돌리지 마라. 이유: 알라딘 일일 한도가 5,000회이고 세션당 260회가 이미 계산돼 있다(TRD 6.1). 20장을 병렬로 밀어 넣으면 한도와 레이트 리밋에 동시에 부딪히고, 그 실패가 인식률 숫자로 둔갑한다. `vitest.golden.config.ts`가 `fileParallelism: false`인 것과 같은 이유다.
6. **`deadlineMs`를 넉넉히 줘라.** 프로덕션의 시간 예산(추출 30s·대조 12s)은 Vercel 함수 60s 상한에서 나온 값이다(ADR-005). 골든은 사람이 배포 전에 돌리는 것이라 그 상한이 없다. 예산 때문에 강등된 책이 인식률로 계상되면 재는 대상이 바뀐다.
7. **사진을 로그에 남기지 마라.** base64 본문이나 파일 내용을 콘솔·리포트에 찍지 마라. 파일명과 해시까지다 (PRD 리스크 표: 업로드 이미지의 사생활).
8. **MIME을 파일 확장자에서 정하라.** `.jpg`/`.jpeg` → `image/jpeg`, `.png` → `image/png`, `.webp` → `image/webp`. 그 외 확장자는 그 사진을 건너뛰고 리포트에 남겨라 — 조용히 `image/jpeg`로 보내지 마라.

### 검증 방법 — 세트 없이 무엇을 확인할 수 있는가

**지금 이 리포에는 골든 세트가 없다. 그것이 정상이고, 이 step은 그 상태에서 완료돼야 한다** (ADR-010: 세트는 리포 밖에 있다).

그러므로 AC의 마지막 줄로 **skip 경로가 실제로 도는 것**을 확인한다:

```bash
npm run test:golden
```

`GOLDEN_SET_DIR`이 없으므로 `no_set_dir`로 skip해야 하고, **명령의 종료 코드가 0이어야 한다.** skip인데 실패로 끝나면 세트 없는 개발자의 로컬에서 이 명령이 항상 빨간불이 되고, 그러면 아무도 안 돌린다.

콘솔에 사유가 보이는지 눈으로 확인하고, 그 출력을 `summary`에 인용하라.

## Acceptance Criteria

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run audit
npm run test:golden
```

- 앞 다섯 줄이 한 세트다 (TRD 8번). 하나라도 빼지 마라.
- `npm test`의 테스트 수가 **줄지 않아야 한다.** 이 step은 `npm test`에 테스트를 더하지 않는다(골든은 exclude된다) — 줄었다면 기존 테스트를 깨뜨린 것이다.
- `npm run test:golden`은 **exit 0으로 끝나고 skip 사유를 출력해야 한다.**

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 새로 만든 파일이 `src/services/shelf.golden.test.ts` **하나뿐인가?** 프로덕션 모듈을 만들지 않았는가? (ARCHITECTURE: 러너는 테스트 코드다)
   - `reports/golden/`이 `.gitignore`에 이미 덮여 있는가? (`reports/`가 통째로 무시된다 — 새로 추가하지 마라)
   - 키 없을 때 skip하는가? **직접 확인하라** — 이 규칙이 빠지면 게이트가 반대로 작동한다
   - CLAUDE.md CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/golden-set/index.json`의 step 3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

`summary`에 담을 것: 만든 파일, `npm run test:golden`의 실제 출력 한 줄, 그리고 **세트를 만들 사람이 알아야 할 것**(매니페스트를 어디에 어떤 이름으로 두는가). 이 런 다음에 사람이 사진 20장을 준비하므로, 그 사람이 읽을 유일한 안내가 이 `summary`다.

## 금지사항

- **`src/services/anthropic.ts`·`src/services/aladin.ts`·`src/lib/match.ts`를 고치지 마라.** 이유: 프로덕션 판정이 그 위에 서 있다. 골든이 통과하도록 프로덕션 동작을 움직이면 게이트가 재는 대상과 지키려는 대상이 갈라진다. 부족한 것이 있으면 `summary`에 적어라
- **`golden-manifest.ts`·`golden-score.ts`·`golden-report.ts`를 고치지 마라.** 이유: step 0~2의 산출물이고 계약은 TRD 8번에 있다. 정말 막히면 `summary`에 적어라
- **프로덕션 모듈을 새로 만들지 마라** (`src/lib/**`·`src/services/**`의 비테스트 파일). 이유: 러너는 테스트 코드다 (ADR-010). 헬퍼가 필요하면 테스트 파일 안에 둬라
- **`vitest.config.ts`의 exclude를 건드리지 마라.** 이유: 골든이 `npm test`에 섞이면 CI가 실제 API를 부르고 알라딘 일일 한도를 태운다
- **junit 리포터를 골든에 켜지 마라.** 이유: 하네스 게이트가 `reports/junit/vitest.xml`에서 테스트 수를 읽는다. 골든이 그 파일을 덮으면 `tests_ran_floor` 1064가 사진 20장짜리 숫자와 대조된다
- **세트가 없다고 가짜 사진·가짜 매니페스트를 만들어 커밋하지 마라.** 이유: ADR-010이 세트를 리포 밖에 두기로 했다. 그리고 합성 세트로 잰 재현율은 실제 책장 사진의 판독 품질을 대변하지 못해 숫자를 오독하게 만든다. 테스트 안에서 쓰는 임시 픽스처는 괜찮지만 **디스크에 남기지 마라**
- **skip을 `expect(true).toBe(true)`로 때우지 마라.** 이유: 그것은 통과로 기록된다. vitest의 skip 기제를 써라
- **`docs/`·`package.json`·`vitest*.config.ts`·`CLAUDE.md`·`.gitignore`를 고치지 마라.** 이유: 메인 소유 경로이고 계약은 이미 적혀 있다
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts` · `runs`). 이유: 실행기가 기록한다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
