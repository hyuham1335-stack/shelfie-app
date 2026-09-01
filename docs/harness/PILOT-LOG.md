# 파일럿 기록 (Pilot Log)

> **이 문서의 위치**
> 하네스 자체의 문서다. `docs/` 직속 6종(프로젝트가 채우는 자리)과는 층이 다르다.
> [ROADMAP.md](ROADMAP.md) 2단계의 승격 조건이 이 문서이며, 여기 적힌 실측이
> `calibrate` 구현과 어댑터 `verified` 승격 판단의 **유일한 근거**다.
> 추정치를 적지 않는다. 재보지 않은 것은 "미측정"으로 남긴다.

---

## 런 #1 — `lib-core` (Shelfie `lib/` 계층 5개 모듈)

| 항목 | 값 |
|------|-----|
| 일자 | 2026-09-01 |
| 실행기 | `scripts/execute.py lib-core` (순차 step 실행기, ROADMAP 0단계 산물) |
| 브랜치 | `feat-lib-core` (base `main`) |
| 대상 | TR-015 proof · TR-012 analytics · TR-004 match(lib 부분) · TR-005 merge · TR-001 image |
| 어댑터 | `nextjs-ts` (`verified: false`) |
| 결과 | **5/5 완주.** error 0 · blocked 0 · 재시도 0 |
| 머신 | Windows 10 · Python 3.8.6 · Node/npm · 로캘 cp949 |

step 순서는 환경 위험 오름차순으로 배치했다. `execute.py`가 첫 error에서 멈추므로, jsdom이 캔버스를 렌더하지 못해 실패 가능성이 가장 큰 `image`를 마지막에 뒀다. **결과적으로 이 배치는 필요 없었지만**(전 step 무재시도 통과) 판단 근거 자체는 유효하다.

### 스테이지 실측 — step별

| step | 모듈 | 소요 | 재시도 | 산출 테스트 |
|---|---|---:|---:|---:|
| 0 | `proof` (TR-015) | 389s | 0 | 16 |
| 1 | `analytics` (TR-012) | 230s | 0 | 17 |
| 2 | `match` (TR-004 lib) | 425s | 0 | 33 |
| 3 | `merge` (TR-005) | 294s | 0 | 33 |
| 4 | `image` (TR-001) | 424s | 0 | 40 |
| | **합계** | **1762s (29.4분)** | **0** | **139** |

- step당 **230~425초**, 평균 352초. 편차가 2배 이내라 step 크기(TR 하나)가 적정했다는 신호다.
- 각 step이 자기 AC(`typecheck`·`lint`·`test`·`build`·`audit`)를 스스로 돌리고 통과한 뒤 넘어갔다.

### 스테이지 실측 — 어댑터 스테이지 (`calibrate`가 채울 값)

`harness/adapters/nextjs-ts.json`의 스테이지를 1회씩 실측했다. **`calibrate` 미구현이라 수동 측정이다.**

| 스테이지 | 명령 | 실측 | 어댑터의 현재 `timeout_sec` |
|---|---|---:|---:|
| `compile` | `npm run typecheck` | 2.5s | 300 |
| `lint` | `npm run lint` | 5.7s | 300 |
| `check` | `npm audit --audit-level=high` | 2.2s | 180 |
| `scoped` | `npm run test -- -t <name>` | 미측정 | 600 |
| `full` | `npm run test` | 4.7s | 1800 |
| `e2e` | — | `cmd: null` (스킵) | — |
| `build` | `npm run build` | 7.1s | 900 |
| `docs` | — | `cmd: null` (스킵) | — |

**정책 판정 (상수가 아니라 실측의 함수)**

- **백그라운드 전체 회귀: 켜지 않는다.** `full.sec = 4.7` 이고 `config.background_threshold_sec = 180` 이므로 조건 미달이다. 백그라운드 스테이지·조인 지점을 만들 근거가 없다.
- **`full` 타임아웃 `max(300, full.sec * 4)` = 300s.** 현재 어댑터의 1800s는 근거 없이 큰 값이다. 다만 테스트가 203건에서 늘어나면 다시 잰다.
- **전체 게이트 1회 = 약 22초.** step 하나가 350초인 것에 비하면 게이트는 병목이 아니다.

### 테스트 수 기준선

| | 파일럿 전 | 파일럿 후 |
|---|---:|---:|
| 총 테스트 | 64 | **203** |
| 테스트 파일 | 2 | 7 |

파일별: `schemas` 56 · `image` 40 · `match` 33 · `merge` 33 · `analytics` 17 · `proof` 16 · `env` 8.

`calibrate`의 `tests_ran` 하한(`floor(203 * 0.9) = 182`)에 쓸 값이다. 이 값 아래로 떨어지면 테스트가 삭제·스킵된 것으로 보고 차단해야 한다.

### 린트 기준선

`npm run lint` **위반 0건.** `harness/lint-baseline.json`은 만들지 않았다 — 기준선이 0이면 파일이 없는 것과 같고, 없는 파일을 만들어 두면 "0을 유지한다"는 사실이 오히려 흐려진다.

---

## 막힌 지점 · 수동 개입

ROADMAP 2단계가 실제로 찾으려던 것이다. **하네스가 사람 손을 요구한 지점만 적는다.**

### M1. 프롬프트를 argv로 넘겨 Windows 인자 상한 초과 — 차단, 해결됨

첫 실행이 step 0에서 즉사했다.

```
FileNotFoundError: [WinError 206] 파일 이름이나 확장명이 너무 깁니다
```

- **원인**: `execute.py`가 프롬프트 전문을 `claude`의 명령행 인자로 넘긴다. 가드레일(`CLAUDE.md` + `docs/*.md` 전문)만 **97,007자**, 프롬프트 합계 **102,839자**. Windows `CreateProcess`의 인자 상한은 **32,767자**로 3배 초과다.
- **왜 구조적인가**: 문서가 자랄수록 확실해지는 실패다. 이 프로젝트의 가드레일 주입 방식(문서 전문을 매 step에 넣는다)과 argv 전달이 근본적으로 양립하지 않는다. 상한 조정이나 문서 축소로 풀 문제가 아니다.
- **조치**: `claude -p`가 stdin을 프롬프트로 받는 것을 실측 확인하고 `input=`으로 전환. `encoding="utf-8"` 함께 명시(없으면 로캘 cp949로 인코딩돼 한글 프롬프트가 깨진다). 50,000자 프롬프트에서 argv 총합이 200자 미만인지 보는 회귀 테스트 추가.
- **커밋**: `fa61651`
- **3단계에 주는 입력**: 목표 파이프라인도 가드레일·계약·이전 findings를 프롬프트에 싣는다. **모델 호출 경로는 처음부터 stdin(또는 파일)이어야 한다.**

### M2. 진행 표시기가 TTY를 전제한다 — 비차단, 미해결

`progress_indicator`가 스피너 프레임(`◐◓◑◒`)을 0.12초마다 stderr에 쓴다. TTY에서는 `\r`로 덮이지만 **리다이렉트하면 전부 파일에 쌓인다.** 백그라운드 실행 로그가 분당 수만 자의 스피너로 뒤덮여 실제 출력(`✓ Step N`, 에러 메시지)을 육안으로 찾을 수 없었다. 진행 상황을 `phases/lib-core/index.json`으로 확인해야 했다.

- **영향**: CI·백그라운드 실행에서 로그가 사실상 무용지물이다. 이번에는 상태 파일이 있어 우회했다.
- **제안**: `sys.stderr.isatty()`가 거짓이면 스피너를 끄고 step 시작·종료 한 줄씩만 남긴다.
- **3단계에 주는 입력**: 실행기가 사람이 보는 터미널을 전제하지 않아야 한다.

### M3. 로캘 인코딩 — 이번 런 전에 이미 해결

파일럿 준비 중 `execute.py`가 `CLAUDE.md`·`docs/*.md`를 인코딩 없이 읽어 cp949 로캘에서 `UnicodeDecodeError`로 죽는 것을 발견해 고쳤다(`abfb7f6`). `test_execute.py` 픽스처도 같은 결함으로 34건이 에러 상태였다. **파일럿을 시작조차 못 할 뻔한 지점이므로 함께 남긴다.**

한글이 흔한 리포에서 "모든 파일 I/O에 `encoding='utf-8'`"은 선택이 아니다. 이 규율을 3단계 실행기에도 그대로 적용한다.

### 수동 개입이 **필요 없었던** 것

정직하게 같이 적는다 — 하네스가 잘한 부분도 실측이다.

- step 5개 전부 재시도 0회로 통과. 자가 교정 루프(최대 3회)가 한 번도 돌지 않았다.
- 금지 경로(`harness/` · `docs/` · `scripts/` · `.claude/`) 침범 **0건.** step 파일의 금지사항 절이 그대로 지켜졌다.
- **새 npm 의존성 0건.** `image` step에서 jsdom 캔버스 제약을 `vi.spyOn`/`stubGlobal` 모킹으로 풀었고, `canvas`·`sharp`·`exif-js` 어느 것도 끌어오지 않았다. CLAUDE.md의 "새 의존성은 ADR 먼저"가 지켜졌다.
- ADR-005 회귀 테스트(`no_match` ≠ `lookup_failed`)가 `match.test.ts`에 실재한다.
- 커밋이 설계대로 step마다 `feat`/`chore` 쌍으로 갈렸다.

---

## 사후 검증

| 검사 | 결과 |
|---|---|
| `python scripts/harness.py doctor` | exit 0 (PASS 11 · WARN 3) |
| 소유 경계 (파일 58개) | 겹침 0건 · 미소유 0건 |
| `npm run typecheck` · `lint` · `test` · `build` · `audit` | 전부 exit 0 |
| 새 의존성 | `package.json`·`package-lock.json` 무변경 |

`doctor`를 사후에도 돌린 이유는 소유 겹침 판정이 **실제 파일 목록** 기준(ADR-H004)이라 파일이 늘어난 뒤에야 검사되는 것이 있기 때문이다. `src/lib/*.ts`(impl)와 `src/lib/*.test.ts`(test)가 `excludes`를 거쳐 정확히 갈렸다.

남은 WARN 3종은 전부 설계상 예상된 것이다: `e2e`·`docs` 스테이지 `cmd: null`, 역할 에이전트 정의 부재(3단계), `verified: false` + 미캘리브레이션.

---

## 미해소로 남긴 것

| 항목 | 근거 | 해소 시점 |
|---|---|---|
| `src/lib/env.ts`의 zod 필수값 검증 미이행 (조용한 기본값 폴백) | `/docs/TRD.md` 8번 | TR-003 `services/` 착수 전 |
| `vitest.config.ts`의 `setupFiles` 부재 (`@testing-library/jest-dom` 미로드) | `/docs/TRD.md` 8번 | TR-011 컴포넌트 테스트 착수 전 |
| M2 스피너 TTY 전제 | 이 문서 | 3단계 실행기 재작성 시 |
| `scoped` 스테이지 미측정 | 스코프 테스트 선택을 이번 런에서 쓰지 않았다 | `calibrate` 구현 시 |

---

## 이 런이 승격 판단에 주는 답

| 질문 | 답 |
|---|---|
| 어댑터 `nextjs-ts`를 `verified: true`로 올릴 수 있는가 | **아직 아니다.** 이 런은 `execute.py`(순차 실행기)로 돌았고 어댑터의 스테이지 체인·귀속 규칙·`test_report` 파싱을 **하나도 쓰지 않았다.** 어댑터가 검증된 것이 아니라 그 안의 명령들이 손으로 확인된 것뿐이다. 승격은 04-gate가 어댑터를 실제로 소비한 뒤다 |
| `calibrate`를 구현할 근거가 생겼는가 | **생겼다.** 위 스테이지 실측 표가 그대로 `calibration.json`의 첫 내용이고, 백그라운드 회귀 판정(4.7s < 180s → OFF)과 `full` 타임아웃(1800 → 300)이 실측의 함수로 결정됐다 |
| 3단계 8페이즈로 갈 수 있는가 | 부분적으로. 단일 스택(Next.js) 완주만 확보했다. ROADMAP 3단계 게이트인 "두 스택에서 완주"는 대상 리포가 이 머신에 없어 **게이트 자체를 재검토해야 한다** |

---

## 런 #1의 "다음 런에서 볼 것" — 런 #2가 답한 것

1. `scoped` 스테이지 실측 → **아직 미측정.** `calibrate`가 "계약이 있어야 측정된다"로 명시적 skip 처리했다
2. 외부 API 모킹이 들어가면 step 소요와 재시도율이 어떻게 변하는가 → **소요는 20% 늘고 재시도는 여전히 0회.** 아래 런 #2 참조
3. 테스트 203건에서 얼마나 늘어나는가 → **335건**

---

## 런 #2 — `services-core` (선결과제 + `lib/` 2종 + `services/` 2종)

| 항목 | 값 |
|------|-----|
| 일자 | 2026-09-01 |
| 실행기 | `scripts/execute.py services-core` |
| 브랜치 | `feat-services-core` (base `main`) |
| 대상 | env zod 검증(TRD 8번 미이행 해소) · `lib/budget.ts` · `lib/prompts.ts` · `services/aladin.ts`(TR-004) · `services/anthropic.ts`(TR-003) |
| 결과 | **5/5 완주.** error 0 · blocked 0 · 재시도 0 |
| 런 #1과 다른 조건 | 외부 API 모킹 · 타임아웃 · 재시도 정책 · 요청 스코프 서킷 브레이커 · SDK 타입 |

### 스테이지 실측 — step별

| step | 모듈 | 소요 | 재시도 | 산출 테스트 |
|---|---|---:|---:|---:|
| 0 | `env-zod` (TRD 7·8번) | 260s | 0 | 8 → 23 (+15) |
| 1 | `budget` (TRD 7번 시간 예산) | 207s | 0 | 17 |
| 2 | `prompts` | 502s | 0 | 29 |
| 3 | `aladin` (TR-004 서비스) | 530s | 0 | 32 |
| 4 | `anthropic` (TR-003) | 609s | 0 | 39 |
| | **합계** | **2108s (35.1분)** | **0** | **+132** |

### 런 #1과의 대조 — 이 런의 고유 산출물

| | 런 #1 (`lib/` 순수 함수) | 런 #2 (`services/` 외부 경계) |
|---|---:|---:|
| step 평균 | 352s | **422s** (+20%) |
| step 최소~최대 | 230~425s | **207~609s** |
| 재시도 | 0 | **0** |
| step당 산출 테스트 | 27.8건 | **26.4건** |
| 총 소요 | 29.4분 | 35.1분 |

**외부 모킹은 재시도율을 올리지 않았고 소요만 20% 늘렸다.** 편차는 커졌다(런 #1은 최대/최소 1.8배, 런 #2는 2.9배) — 순수 함수 step(`budget` 207s)과 SDK 모킹 step(`anthropic` 609s)의 차이다.

**해석**: step 크기를 "TR 하나"로 잡는 규칙은 외부 경계에서도 유지된다. 다만 SDK 모킹이 들어가는 step은 순수 함수 step의 **3배**를 잡아야 한다. 3단계에서 step별 예산을 두게 되면 이 비율이 입력이다.

### 테스트 수 기준선

| | 런 #1 후 | 런 #2 후 |
|---|---:|---:|
| 총 테스트 | 203 | **335** |
| 테스트 파일 | 7 | 11 |

`calibrate`의 `tests_ran_floor`를 **301**(`floor(335 × 0.9)`)로 갱신해야 한다. 다음 `calibrate` 실행이 자동으로 반영한다.

### 어댑터 스테이지 실측 — `calibrate` 1회차

런 #2 직전에 `calibrate`를 구현하고 처음 돌렸다. 런 #1에서 손으로 잰 값과 대조한다.

| 스테이지 | 런 #1 수동 | `calibrate` (203건 기준) | 차이 |
|---|---:|---:|---|
| `compile` | 2.5s | 3.16s | 노이즈 |
| `lint` | 5.7s | 5.75s | 일치 |
| `check` | 2.2s | 1.66s | 노이즈 |
| `full` | 4.7s | 5.56s | 노이즈 |
| `build` | 7.1s | 7.92s | 노이즈 |

**정책 결론은 동일하다** — 백그라운드 전체 회귀 OFF(5.56s < 180s), `full` 타임아웃 300s. 수동 실측과 도구 실측이 어긋나지 않았다는 것이 `calibrate` 구현의 첫 검증이다.

---

## 막힌 지점 · 수동 개입 (런 #2)

### M4. 실행기가 표시하는 step 소요가 항상 0s — 비차단, 해결 필요

두 런의 로그가 전부 `✓ Step 0: proof [0s]` 였다.

`progress_indicator`가 `info.elapsed`를 `finally` 블록에서 채우는데, 호출부는 `with` 블록 **안에서** `int(pi.elapsed)`를 읽는다. `finally`는 그 뒤에 실행되므로 언제나 초기값 `0.0`이다.

- **영향**: 실행기의 유일한 시간 표시가 무용지물이다. 이 문서의 step 소요는 전부 `index.json`의 `started_at`↔`completed_at`에서 계산한 것이지 실행기가 알려준 값이 아니다.
- **왜 두 런 동안 안 드러났나**: 런 #1에서는 스피너(M2)가 로그를 덮어 `✓` 줄을 볼 수 없었고, 런 #2에서 stderr를 버린 뒤에야 보였다. **결함 하나가 다른 결함을 가리고 있었다.**

### M5. 세션과 실행기가 타임스탬프 소유권을 다툰다 — 비차단, 관측됨

step 1 세션이 `completed_at`을 `"2026-09-01 06:53:17"`(UTC·구분자 공백·타임존 없음)로 쓴 뒤 스스로 알아채고 `7051ab9`로 고쳤다. 실행기의 형식은 `"2026-09-01T15:53:25+0900"`이다.

- **원인**: `.claude/skills/harness/SKILL.md`는 "타임스탬프는 `execute.py`가 자동 기록한다. 생성 시 넣지 않는다"고 정했는데, **세션은 그 문서를 본 적이 없다.** 가드레일로 주입되는 것은 `CLAUDE.md`와 `docs/*.md`뿐이고 `SKILL.md`는 포함되지 않는다. 세션은 "`index.json`의 status를 업데이트하라"는 지시만 받고 형식 규약은 못 받는다.
- **왜 중요한가**: 이번엔 세션이 자정했지만, 안 했다면 `PILOT-LOG`의 실측이 조용히 오염됐을 것이다. 실측을 근거로 정책을 정하는 구조에서 **타임스탬프 형식은 계약이다.**
- **제안**: 상태 파일에 쓰는 형식 규약을 step 프롬프트 preamble에 넣거나, `execute.py`가 세션이 쓴 타임스탬프를 무조건 덮어쓰도록(이미 `completed_at`은 덮어쓴다) 나머지 필드도 정규화한다.

### M2 보강 — 스피너를 끄면 이번엔 버퍼링이 가린다

런 #2는 M2를 `2>/dev/null`로 우회했는데, 그러자 **stdout이 블록 버퍼링돼 프로세스가 끝날 때까지 로그가 한 줄도 안 나왔다.** 진행 상황은 `index.json`을 직접 읽어 확인해야 했다.

M2의 뿌리는 스피너가 아니라 **실행기가 비대화형 실행을 전제하지 않는다는 것**이다. 고치려면 둘 다 필요하다: `sys.stderr.isatty()`가 거짓이면 스피너를 끄고, 진행 출력에 `flush=True`를 붙인다.

### 수동 개입이 **필요 없었던** 것

- step 5개 전부 재시도 0회 (`retry` 로그 0건으로 확인)
- 금지 경로(`harness/`·`docs/`·`scripts/`·`.claude/`·`.env*`) 침범 **0건**
- **새 npm 의존성 0건** — `prompts` step이 `zod-to-json-schema`를, `aladin`이 `axios`/`p-limit`을, `anthropic`이 아무것도 끌어오지 않았다
- 테스트가 **실제 외부 API를 한 번도 치지 않았다** (fetch·SDK 전부 주입/모킹)
- ADR-005 회귀 테스트(`no_match` ≠ `lookup_failed`)가 `aladin.test.ts`에 실재한다
- `services/` 디렉토리가 `/docs/ARCHITECTURE.md`의 구조대로 생성됐다

---

## 계획이 틀렸던 지점 (기록해 둔다)

**플랜은 `prompts` step이 `zod/v4`의 `toJSONSchema`를 쓸 수 있다고 단정했다. 쓸 수 없었다.**

`node -e "typeof require('zod/v4').toJSONSchema"`가 `function`을 반환하는 것은 확인했지만, **그 변환기가 이 리포의 스키마에 동작하는지는 확인하지 않았다.** `src/lib/schemas.ts`는 zod 3.25의 classic(v3) API로 쓰였고 v4 변환기는 v4 내부 구조(`_zod`)를 요구해서, v3 노드를 넘기면 던진다. `@anthropic-ai/sdk` 0.68의 `betaZodTool`도 같은 변환기를 쓰므로 동일하다.

step은 막히지 않고 `prompts.ts` 안에 v3 노드를 직접 거는 비공개 변환기를 두어(모르는 노드는 조용히 넘기지 않고 `throw`) 해결했고, 새 의존성은 0건을 유지했다.

**교훈**: "함수가 존재한다"와 "이 입력에 동작한다"는 다른 사실이다. step 파일에 기술 선택을 못박을 때는 **실제 입력으로 한 번 돌려 본 것만** 단정한다. 이 문서의 원칙("추정치를 적지 않는다")이 step 파일에도 적용돼야 한다.

---

## 사후 검증 (런 #2)

| 검사 | 결과 |
|---|---|
| `python scripts/harness.py doctor` | exit 0 (PASS 11 · WARN 3) — **캘리브레이션 상태가 처음으로 PASS** |
| 소유 경계 | 겹침 0건 · 미소유 0건 (`src/services/*.ts`가 impl, `*.test.ts`가 test로 정확히 갈렸다) |
| `typecheck`·`lint`·`test`·`build`·`audit` | 전부 exit 0 |
| 새 의존성 | `package.json`·`package-lock.json` 무변경 |
| 금지 경로 | 침범 0건 |

남은 WARN 3종: 어댑터 `verified:false`, `e2e`·`docs` 스테이지 `cmd:null`, 역할 에이전트 정의 부재.

---

## 다음 런으로 넘기는 보고 (step들이 올린 것)

step 세션들이 "고치지 말고 보고하라"는 지시를 따라 올린 항목이다. **전부 라우트 계층(런 #3)의 입력이다.**

| 출처 | 내용 |
|---|---|
| `aladin` | `LookupOutcome`이 `aladinCandidate`(isbn13·title·author·publisher·coverUrl)만 담아 `IdentifiedBook`에 필요한 `pages`·`aladinRating`·`aladinLink`를 못 채운다. **ItemLookUp 경로가 라우트 step에 따로 필요하다** |
| `anthropic` | 설치된 `@anthropic-ai/sdk` 0.68의 타입 정의에 `output_config`·`fallbacks`·adaptive thinking이 없다(TRD 7번 호출 규약보다 낡았다). 본문은 그대로 전송되므로 동작은 문제없고 캐스팅을 인터페이스 한 곳으로 좁혔다. SDK를 올리면 그 인터페이스만 지우면 된다 |
| `anthropic` | `ExtractOutcome`의 `failed` 분기에 `usage`가 없다. `refusal`·`max_tokens` 응답도 토큰은 과금되므로 **그 사진의 비용이 `analyze_completed` 집계에서 빠진다.** PRD 7번의 "세션당 비용" 가드레일이 실제보다 낮게 나온다 — 라우트 step에서 타입을 넓혀야 한다 |
| `env-zod` | `.env.example`의 `NEXT_PUBLIC_MAX_PHOTOS`를 `env.ts`의 `MAX_PHOTOS`가 읽지 않는다(상수로 박혀 있다). 기존 계약이라 이번 step에서 건드리지 않았다 |

---

## 이 런이 승격 판단에 주는 답

| 질문 | 답 |
|---|---|
| 어댑터 `verified: true` 승격 | **여전히 아니다.** 런 #2도 `execute.py`로 돌았고 어댑터의 스테이지 체인·귀속 규칙을 소비하지 않았다. 다만 `calibrate`가 `test_report` 파싱을 **처음으로 실제 소비했다** — 어댑터의 일부가 검증된 첫 사례다 |
| `calibrate`가 쓸 만한가 | **그렇다.** 수동 실측과 어긋나지 않았고, 정책 3종(백그라운드 회귀·타임아웃·테스트 하한)을 실측에서 자동으로 유도했다 |
| 3단계로 갈 수 있는가 | 단일 스택 완주 2회를 확보했다. "두 스택에서 완주" 게이트는 **여전히 대상 리포가 없어** 재검토가 필요하다 |

## 다음 런에서 볼 것

1. **라우트 계층(TR-006 analyze)** — 시간 예산·부분 실패·서명 발급·ItemLookUp이 한꺼번에 만난다. 지금까지 중 가장 통합적인 step이고, 재시도가 처음 발생할 가능성이 높은 지점이다
2. `scoped` 스테이지 실측 — 라우트가 생기면 계약을 쓸 수 있고, 그때 `-t` 선택 문법이 vitest에서 의도대로 좁히는지 잰다
3. M4·M5·M2를 고친 실행기로 돌린다 — 세 결함 모두 실행기 쪽이고 3단계 재작성까지 미룰 이유가 없다
4. `tests_ran_floor` 갱신 (301)

---

## 런 #3 — `routes-core` (라우트 계층 · 첫 통합 지점)

| 항목 | 값 |
|------|-----|
| 일자 | 2026-09-01 |
| 실행기 | `scripts/execute.py routes-core` |
| 브랜치 | `feat-routes-core` (base `main`) |
| 대상 | `aladin` ItemLookUp 확장 · `anthropic` 한줄평 배치 · `POST /api/analyze`(TR-006) · `POST /api/books/resolve`(TR-008) · `POST /api/events`(TR-014) |
| 결과 | **5/5 완주.** 자가 교정 재시도 **0** · 사용량 한도로 **1회 중단 후 재개** |
| 앞선 두 런과 다른 조건 | 시간 예산·부분 실패·서명 발급·요청 스코프 브레이커가 **한 라우트에서 처음 만난다.** `src/app/api/` 최초 생성 |
| 실행기 | M2·M4·M5를 고친 판으로 시작 → 런 도중 M6·M7·M8을 발견하고 고쳤다 |

### 스테이지 실측 — step별

| step | 모듈 | 소요 | 재시도 | 산출 테스트 | 누적 |
|---|---|---:|---:|---:|---:|
| 0 | `aladin-lookup` (ItemLookUp) | 584s | 0 | +25 | 360 |
| 1 | `anthropic-notes` (배치·usage 보존) | 785s | 0 | +29 | 389 |
| 2 | `analyze-route` (TR-006) | 898s | 0 | +35 | 424 |
| 3 | `resolve-route` (TR-008) | (191s) | 0 | +28 | 452 |
| 4 | `events-route` (TR-014) | 535s | 0 | +30 | 482 |
| | **합계** | **2993s (49.9분)** | **0** | **+147** | |

**step 3의 191s는 다른 값과 비교하면 안 된다.** 1차 시도가 사용량 한도로 잘린 뒤(아래 M7) 재실행한 값이고,
그때 산출물은 이미 디스크에 있었다. 세션은 사실상 검증만 했다. 1차 시도의 실제 작업 시간은
`17:18:37 → 17:23:29` 구간에 있지만 그 안에 429 재시도 2회가 섞여 있어 분리해 잴 수 없다.

### 런 #1·#2와의 대조

| | #1 `lib/` 순수 함수 | #2 `services/` 외부 경계 | #3 `app/api/` 라우트 |
|---|---:|---:|---:|
| step 평균 | 352s | 422s | **700s** (step 3 제외) |
| step 최소~최대 | 230~425s | 207~609s | **535~898s** |
| 자가 교정 재시도 | 0 | 0 | **0** |
| step당 산출 테스트 | 27.8건 | 26.4건 | **29.4건** |
| 총 소요 | 29.4분 | 35.1분 | 49.9분 |

**통합 지점은 소요를 다시 66% 올렸지만 재시도율은 이번에도 올리지 않았다.** 런 #2가 "SDK 모킹 step은 순수 함수 step의 3배"를
남겼는데, 라우트 step은 그보다 한 단계 더 든다 — 가장 짧은 step(535s)이 런 #1의 가장 긴 step(425s)보다 길다.
**"재시도가 처음 발생할 가능성이 높은 지점"이라던 런 #2의 예상은 빗나갔다.** 세 런 15 step 동안 자가 교정은 한 번도 발동하지 않았다.
`MAX_RETRIES = 3`은 아직 한 번도 시험되지 않은 장치다.

### 테스트 수 기준선

| | 런 #1 후 | 런 #2 후 | 런 #3 후 |
|---|---:|---:|---:|
| 총 테스트 | 203 | 335 | **482** |
| 테스트 파일 | 7 | 11 | **14** |

`tests_ran_floor`를 **433**(`floor(482 × 0.9)`)으로 갱신했다. 런 #2가 남긴 과제 4번을 해소한다.

### 어댑터 스테이지 실측 — `calibrate` 2회차 (`scoped` 최초 측정)

| 스테이지 | 런 #2 (203건) | 런 #3 (482건) | 비고 |
|---|---:|---:|---|
| `compile` | 3.16s | 2.56s | 노이즈 |
| `lint` | 5.75s | 6.25s | 노이즈 |
| `check` | 1.66s | 1.58s | 노이즈 |
| `scoped` | 미측정 | **8.95s** | **최초 측정** |
| `full` | 5.56s | 10.83s | 테스트가 2.4배 → 소요 1.9배 |
| `build` | 7.92s | 9.95s | 라우트 3개 추가 |

**`scoped`가 `full`을 거의 못 줄인다 — 이 런의 가장 중요한 실측이다.**
`-t "미확인 사유를 뭉개지 않는다"`는 선택 자체는 정확히 동작한다(482건 중 **3건 실행**, 13개 파일 스킵).
그런데 소요는 8.95s로 `full` 10.83s의 **83%**다. vitest가 선택과 무관하게 전체 파일을 수집·변환하기 때문이다.

이것은 목표 8페이즈 파이프라인의 전제를 직접 건드린다. `loop_stage: true`인 `scoped`는
"루프마다 싸게 도는 스테이지"를 가정하는데, **이 스택에서는 싸지 않다.**
루프를 10회 돌면 `scoped` 89s vs 처음부터 `full` 10.8s — 선택 실행이 오히려 손해다.
3단계에서 스테이지 체인을 설계할 때 `scoped`의 존재 이유를 스택별로 다시 물어야 한다.

---

## 막힌 지점 · 수동 개입 (런 #3)

### M6. `_run_git`이 로캘로 git 출력을 디코드해 실행기를 무너뜨린다 — 차단, 해결됨

step 3 커밋에서 `UnicodeDecodeError: 'cp949' codec can't decode byte 0xe2`가 리더 스레드를 죽이고,
`subprocess.communicate`가 `stdout[0]`에서 `IndexError`를 내며 **phase 전체가 중단**됐다.
0xe2는 커밋 제목의 em dash(`feat(routes-core): step 3 — resolve-route`)다.

- **왜 두 런 동안 안 드러났나**: 평소에는 **step 세션이 스스로 커밋한다**(preamble 규칙 7). 그래서 `_commit_step`의
  `git diff --cached --quiet`가 0을 돌려주고 `git commit`은 실행되지 않는다 — 실행기의 커밋 경로가 사실상 no-op이었다.
  step 3은 세션이 **커밋 전에 잘려** 실행기가 런 3개 만에 처음으로 진짜 커밋을 만들었고, 그 순간 드러났다.
- **교훈**: `_invoke_claude`는 런 #1(M1·M3)에서 이미 `encoding="utf-8"`로 고쳤는데 `_run_git`은 남아 있었다.
  **같은 결함의 형제를 함께 찾지 않으면 남는다.** 로캘 의존 인코딩은 파일 단위로 훑어야 한다.
- **해결**: `encoding="utf-8", errors="replace"`. 실제 git으로 em dash 커밋을 만드는 회귀 테스트 포함 3건.

### M7. 사용량 한도(429)를 코드 결함과 구분하지 못한다 — 차단, 해결됨

`claude -p`가 `is_error: true` · `api_error_status: 429` · `result: "You've hit your session limit — resets 7:20pm"`을
돌려줬는데 실행기는 이것을 step 실패로 보고 **자가 교정을 3회 태운 뒤**(각 493ms) `error` +
`"[3회 시도 후 실패] Step did not update status"`로 적었다.

- **왜 중요한가**: (1) 한도는 외부 조건이라 자가 교정으로 고쳐지지 않는다 — 재시도 2회가 순수 낭비다.
  (2) **파일럿의 재시도 통계가 오염된다.** 이 건을 그대로 두면 런 #3은 "3회 시도 후 실패"로 읽히는데,
  실제로는 자가 교정이 한 번도 시험되지 않았다. 실측을 근거로 정책을 정하는 구조에서 이 오염은 치명적이다.
  (3) 사용자가 고칠 수 없는 실패를 고치려 든다.
- **해결**: `_usage_limit_reason`이 429를 판별하면 재시도 없이 `blocked` + exit 2. 테스트 10건.

### M8. 실행기가 자기 출력을 로캘로 인코딩해 완주 직전에 죽는다 — 차단, 해결됨

step 4를 위해 재기동한 실행기가 step 3 완료 표시 `✓`를 리다이렉트된 stdout(cp949)에 찍다
`UnicodeEncodeError: 'cp949' codec can't encode character '✓'`으로 죽었다.
**step 3은 이미 완주하고 커밋까지 끝난 뒤였다** — 출력 한 줄 때문에 phase가 끊겼다.

- M6와 같은 뿌리(로캘 의존 인코딩)이고 방향만 반대다(읽기 → 쓰기). M6를 고치면서 같이 찾았어야 했다.
- **해결**: 시작 시 `sys.stdout`·`sys.stderr`를 `encoding="utf-8", errors="replace"`로 재설정. 테스트 3건.
- 런 #2가 M2 우회로 쓰던 `2>/dev/null`을 이번엔 쓰지 않았기 때문에 드러났다. **결함 하나를 고치면 그 뒤에 가려 있던 것이 나온다** —
  런 #2의 "M2가 M4를 가리고 있었다"와 같은 패턴이 세 번째다.

### M9. `calibrate --stage X`가 기존 실측을 통째로 덮어쓴다 — 비차단, 관측됨

`scoped`만 재려고 `calibrate --stage scoped`를 돌리자 `calibration.json`이 **`scoped` 하나만 든 파일로 교체**됐다.
`compile`·`lint`·`check`·`full`·`build`의 실측이 사라지고 `derived`의 정책 3종이 전부 `null`이 됐다.
`partial: true`가 붙긴 하지만, 그 순간 `doctor`의 "캘리브레이션 상태"는 통과에서 미측정으로 떨어진다.

- **왜 중요한가**: 실측이 정책의 유일한 근거인데 **부분 측정 한 번이 전체 근거를 지운다.** 되돌릴 방법은 재측정뿐이다.
- **제안**: `--stage`는 기존 파일을 읽어 해당 스테이지만 갱신(merge)하고, 전체 교체는 명시적 플래그를 요구한다.
- **이번 조치**: 전체 `calibrate --select ...`를 다시 돌려 복구했다. 그 김에 `scoped`가 처음으로 전체 파일에 들어갔다.

### 관측 — 상태 파일과 산출물이 어긋난 채로 남을 수 있다

429는 세션이 **코드·테스트를 다 쓰고 `index.json`을 갱신하기 직전**에 떨어졌다. 재개 시점에
`route.ts` 243줄 + `route.test.ts` 455줄이 이미 있었고 AC 5종을 전부 통과했다.
그런데 실행기는 상태 파일만 보고 실패로 판정한다.

**3단계 파이프라인의 재개(resume) 설계는 "status는 pending인데 산출물이 이미 있다"를 다뤄야 한다.**
지금 실행기에는 그 개념이 없어, 재실행한 step 3 세션은 자기가 쓴 코드를 다시 읽고 검증만 했다(191s).
운 좋게 값싸게 끝났지만, 세션이 "처음부터 다시 쓴다"를 골랐다면 검증된 산출물을 덮어썼을 것이다.

### 환경 — 경로 casing 함정 (실행기 무관)

사람이 손으로 검증하던 셸에서 `npm run build`가 `/_global-error` 프리렌더에서
`InvariantError: Expected workStore to be initialized`로 죽었다. 원인은 코드가 아니라 세션 cwd의
대문자 `PROJECT`(디스크 실제 이름은 소문자 `project`)다. 소문자 경로에서 같은 코드가 통과한다.
**실행기는 `Path(__file__).resolve()`로 실제 casing을 쓰므로 step 세션은 영향받지 않았다** —
검증하는 사람만 밟는 함정이다.

### 수동 개입이 **필요 없었던** 것

- step 5개 전부 자가 교정 재시도 0회
- 금지 경로(`harness/`·`docs/`·`.claude/`·`.env*`) 침범 **0건**
- **새 npm 의존성 0건** — 라우트 3개가 아무것도 끌어오지 않았다
- 테스트가 실제 알라딘·Anthropic을 한 번도 치지 않았다
- 라우트가 `src/app/api/` 밖으로 새지 않았다 (CLAUDE.md CRITICAL)
- `lib/` 수정 0건 — step들이 결함을 발견하고도 고치지 않고 `summary`로 보고했다

---

## 사후 검증 (런 #3)

| 검사 | 결과 |
|---|---|
| `python scripts/harness.py doctor` | exit 0 (PASS 11 · WARN 3) |
| `typecheck`·`lint`·`test`·`build`·`audit` | 전부 exit 0 · **482건 통과** · 취약점 0건 |
| 금지 경로 | 침범 0건 |
| 새 의존성 | `package.json`·`package-lock.json` 무변경 |
| ADR-005 회귀 | `analyze` 테스트에 `lookup_failed` 10회 · `no_match` 6회 · `resolve`는 404 `NOT_FOUND_IN_ALADIN`과 502 `UPSTREAM_UNAVAILABLE`로 분리 |
| ADR-006 회귀 | `proof` 단언 `analyze` 6회 · `resolve` 10회 |

남은 WARN 3종은 런 #2와 동일하다(어댑터 `verified:false`, `e2e`·`docs` `cmd:null`, 역할 에이전트 부재).

---

## 다음 런으로 넘기는 보고 (런 #3의 step들이 올린 것)

| 출처 | 내용 |
|---|---|
| `aladin-lookup` · `analyze-route` | ItemLookUp 도입으로 세션당 알라딘 호출 상한이 **260회**(후보 80×2 + 확인 ≤50×2)가 됐다. `/docs/TRD.md` 10번 병목 표의 160회와 PRD 부채 표를 갱신해야 한다 — step들이 `docs/` 수정 금지를 지켜 보고만 했다 |
| `analyze-route` | 장당 2MB·합계 4MB 상수가 `lib/image.ts`(브라우저 전용)와 라우트 두 곳에 있다. `lib/env.ts`로 옮기는 것이 맞다 |
| `analyze-route` | `errorCodeSchema`에 500대 내부 오류 코드가 없어, 우리 응답이 계약을 어기는 경우를 502 `UPSTREAM_UNAVAILABLE`로 내보낸다. `/docs/API_SPEC.md`가 이 자리를 비워 두고 있다 |
| `anthropic-notes` | `@anthropic-ai/sdk` 0.68 타입이 TRD 7번 호출 규약보다 낡았다(런 #2에서 이미 보고). 캐스팅이 인터페이스 한 곳에 모여 있다 |
| `env-zod`(런 #2) | `.env.example`의 `NEXT_PUBLIC_MAX_PHOTOS`를 `env.ts`가 읽지 않는다 — **아직 미해소** |

---

## 이 런이 승격 판단에 주는 답

| 질문 | 답 |
|---|---|
| 어댑터 `verified: true` 승격 | **여전히 아니다.** 세 런 모두 `execute.py`로 돌았고 스테이지 체인·`attribution`을 소비하지 않았다. 다만 `calibrate`가 이번에 `scoped`의 `select` 문법까지 실제로 소비했다 — 어댑터에서 검증된 부분이 또 늘었다 |
| 순차 실행기로 충분한가 | **라우트 계층까지는 충분했다.** 15 step 연속 자가 교정 0회. 다만 실행기 결함 3종(M6·M7·M8)이 전부 **완주를 끊는** 종류였다 — 실행기의 취약점은 작업 품질이 아니라 **운영 견고성**에 있다 |
| `scoped` 스테이지가 쓸모 있는가 | **이 스택에서는 의문이다.** 선택은 정확하나 `full` 대비 83% 소요다. 3단계 스테이지 체인 설계의 입력이다 |
| 3단계로 갈 수 있는가 | 단일 스택 완주 **3회**를 확보했다. "두 스택에서 완주" 게이트는 여전히 대상 리포가 없다 |

## 런 #3 다음에 볼 것

1. **M9(부분 캘리브레이션이 전체를 덮어쓴다)를 고친다** — 실측이 정책의 유일한 근거인데 지금은 한 번의 부분 측정으로 지워진다
2. **재개(resume) 개념** — "status는 pending인데 산출물이 이미 있다"를 실행기가 다뤄야 한다. 이번엔 운으로 넘어갔다
3. **UI 계층** — 라우트가 생겼으니 `app/` 화면이 다음이다. `/docs/UI_GUIDE.md`의 "Claude 생성 텍스트 블록"과 사실·해석 분리(ADR-002)가 처음으로 화면에서 시험된다
4. `MAX_RETRIES = 3`은 세 런 동안 한 번도 발동하지 않았다 — 실측 없는 상수로 남아 있다
