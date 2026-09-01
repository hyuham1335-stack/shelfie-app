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

## 다음 런에서 볼 것

1. `scoped` 스테이지 실측 — 스코프 테스트 선택 문법(`-t`)이 vitest에서 의도대로 좁히는가
2. `services/`·`app/api/` 계층(TR-003·TR-004·TR-006) — 외부 API 모킹이 들어가면 step 소요와 재시도율이 어떻게 변하는가
3. 테스트가 203건에서 얼마나 늘어나는가 — `tests_ran` 하한을 갱신한다
