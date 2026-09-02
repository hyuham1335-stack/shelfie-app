---
name: harness
description: 이 프로젝트는 Harness 프레임워크를 사용한다. docs/ 문서를 읽고 구현 계획을 step 단위로 설계한 뒤 phases/ 파일을 생성하고 execute.py로 실행하는 워크플로우. 기능 구현 계획을 세우거나 step 파일을 만들 때 사용한다.
---

이 프로젝트는 Harness 프레임워크를 사용한다. 아래 워크플로우에 따라 작업을 진행하라.

---

## 워크플로우

### A. 탐색

`/docs/` 하위 문서(PRD, ARCHITECTURE, ADR 등)를 읽고 프로젝트의 기획·아키텍처·설계 의도를 파악한다. 필요시 Explore 에이전트를 병렬로 사용한다.

### B. 논의

구현을 위해 구체화하거나 기술적으로 결정해야 할 사항이 있으면 사용자에게 제시하고 논의한다.

### C. Step 설계

사용자가 구현 계획 작성을 지시하면 여러 step으로 나뉜 초안을 작성해 피드백을 요청한다.

설계 원칙:

1. **Scope 최소화** — 하나의 step에서 하나의 레이어 또는 모듈만 다룬다. 여러 모듈을 동시에 수정해야 하면 step을 쪼갠다.
2. **자기완결성** — 각 step 파일은 독립된 Claude 세션에서 실행된다. "이전 대화에서 논의한 바와 같이" 같은 외부 참조는 금지한다. 필요한 정보는 전부 파일 안에 적는다.
3. **사전 준비 강제** — 관련 문서 경로와 이전 step에서 생성/수정된 파일 경로를 명시한다. 세션이 코드를 읽고 맥락을 파악한 뒤 작업하도록 유도한다.
4. **시그니처 수준 지시** — 함수/클래스의 인터페이스만 제시하고 내부 구현은 에이전트 재량에 맡긴다. 단, 설계 의도에서 벗어나면 안 되는 핵심 규칙(멱등성, 보안, 데이터 무결성 등)은 반드시 명시한다.
5. **AC는 실행 가능한 커맨드** — "~가 동작해야 한다" 같은 추상적 서술이 아닌 `npm run build && npm test` 같은 실제 실행 가능한 검증 커맨드를 포함한다.
6. **주의사항은 구체적으로** — "조심해라" 대신 "X를 하지 마라. 이유: Y" 형식으로 적는다.
7. **네이밍** — step name은 kebab-case slug로, 해당 step의 핵심 모듈/작업을 한두 단어로 표현한다 (예: `project-setup`, `api-layer`, `auth-flow`).

#### 이전 런의 미해소 보고를 어느 step이 받는가

step들이 `summary`로 올린 보고는 **다음 런 설계에서 명시적으로 배정하지 않으면 영원히 이월된다.** 이 리포에서 실제로 네 건이 세 런 연속 살아남았고, 원인은 설계 단계에 있었다 — step 파일이 금지사항에 "`src/lib/`을 고치지 마라"를 넣어 놓고 다음 런의 계획서에는 "여기서 정리한다"고 적었다. 두 문서가 서로를 부정했고, 실행 중에는 아무도 그것을 알아채지 못했다.

설계 시작 전에 이전 런의 보고를 전부 꺼내 **손댈 파일 기준으로** 분류한다:

| 분류 | 판정 방법 | 처리 |
|------|-----------|------|
| **역할 소유** | `harness/config.json`의 `roles[].owns`에 걸린다 (이 리포에서는 `src/**`) | **어느 step이 받는지 이름으로 지정하고**, 그 step의 금지사항에서 그 경로를 뺀다 |
| **메인 소유** | `main_owned_paths`에 걸린다 (`docs/**` · `.env*` · `harness/**` · `scripts/**` · `.claude/**` · **리포 루트의** `*.ts`·`*.json`·`*.mjs`) | **step에 주지 마라.** 런을 시작하기 전에 사람이 처리한다 |
| **둘에 걸침** | 문서와 코드를 함께 고쳐야 한다 | **문서를 먼저(메인), 코드를 나중(step).** 계약이 없으면 step이 이름을 지어낸다 |

`main_owned_paths`의 glob은 `*`가 디렉토리를 넘지 않는다. 즉 `*.ts`는 **루트의** `vitest.config.ts`·`next.config.ts`만 잡고 `src/lib/env.ts`는 잡지 않는다. 워커가 실제로 소유한 경로를 금지사항으로 막고 있지 않은지 확인하라 — 판정은 눈이 아니라 `harness.py`의 `glob_any`로 한다.

어느 분류에도 넣지 못한 보고는 **이번 런에서 해소되지 않는다고 `phases/{task-name}/index.json`이나 계획서에 명시한다.** 조용히 떨어뜨리는 것이 이 실패의 원형이다.

### D. 파일 생성

사용자가 승인하면 아래 파일들을 생성한다.

#### D-1. `phases/index.json` (전체 현황)

여러 task를 관리하는 top-level 인덱스. 이미 존재하면 `phases` 배열에 새 항목을 추가한다.

```json
{
  "phases": [
    {
      "dir": "0-mvp",
      "status": "pending"
    }
  ]
}
```

- `dir`: task 디렉토리명.
- `status`: `"pending"` | `"completed"` | `"error"` | `"blocked"`. execute.py가 실행 중 자동으로 업데이트한다.
- 타임스탬프(`completed_at`, `failed_at`, `blocked_at`)는 execute.py가 상태 변경 시 자동 기록한다. 생성 시 넣지 않는다.

#### D-2. `phases/{task-name}/index.json` (task 상세)

```json
{
  "project": "<프로젝트명>",
  "phase": "<task-name>",
  "steps": [
    { "step": 0, "name": "project-setup", "status": "pending",
      "docs": ["ARCHITECTURE", "ADR"] },
    { "step": 1, "name": "core-types", "status": "pending",
      "docs": ["ARCHITECTURE", "ADR", "TRD"] },
    { "step": 2, "name": "api-layer", "status": "pending",
      "docs": ["API_SPEC", "TRD", "ADR"] }
  ]
}
```

필드 규칙:

- `project`: 프로젝트명 (CLAUDE.md 참조).
- `phase`: task 이름. 디렉토리명과 일치시킨다.
- `steps[].step`: 0부터 시작하는 순번.
- `steps[].name`: kebab-case slug.
- `steps[].status`: 초기값은 모두 `"pending"`.
- `steps[].docs`: **이 step 프롬프트에 주입할 `docs/` 문서**(확장자 없는 파일명). 아래 절을 본다.
- `steps[].sources`: **이 step 프롬프트에 실을 소스 파일**(리포 루트 기준 경로). 아래 절을 본다.

상태 전이와 자동 기록 필드:

| 전이 | 기록되는 필드 | 기록 주체 |
|------|-------------|----------|
| → `completed` | `completed_at`, `summary` | Claude 세션 (summary), execute.py (timestamp) |
| → `error` | `failed_at`, `error_message` | Claude 세션 (message), execute.py (timestamp) |
| → `blocked` | `blocked_at`, `blocked_reason` | Claude 세션 (reason), execute.py (timestamp) |

`summary`는 step 완료 시 산출물을 한 줄로 요약한 것으로, execute.py가 다음 step 프롬프트에 컨텍스트로 누적 전달한다. 따라서 다음 step에 유용한 정보(생성된 파일, 핵심 결정 등)를 담아야 한다.

`created_at`은 execute.py가 최초 실행 시 task 레벨에 한 번만 기록한다. step 레벨의 `started_at`도 execute.py가 각 step 시작 시 자동 기록한다. 생성 시 넣지 않는다.

`attempts`(그 step을 몇 번 태웠는가)도 execute.py가 쓴다. 1회에 통과해도 `1`을 남긴다 — **"기록 없음"과 "재시도 0회"는 다른 것**이고, 재시도 상한(`calibrate`의 `retry_budget`)이 이 값에서 유도된다. 생성 시 넣지 말고, step 세션도 건드리지 않는다.

##### 어느 문서를 주입할 것인가 — `steps[].docs`

가드레일은 **step이 고른다** ([ADR-H008](../../../docs/harness/DECISIONS.md)). 지정하지 않으면 `docs/` 전량이 들어가고, 실행기가 매 step `⚠ 문서 미선택 — 전량 주입 (N자)`으로 드러낸다.

왜 고르는가는 실측이다. 파일럿 다섯 런의 청구 토큰 115.6M 중 **cache read가 110.3M(95.4%)** 이고, 그것은 **매 turn 프롬프트 접두부를 다시 읽은 양**이다. 그 접두부의 **86.9%가 가드레일**이었다 — UI step이 배포 인프라 절을, 순수 함수 step이 GTM 이벤트 표를 750 turn 내내 재독했다. 런 #5의 step 파일들은 이미 각각 3~5종만 필요하다고 적어 두었고, 그대로 주입했다면 문자 기준 **41% 절감**이었다.

규칙 셋:

1. **step 파일의 `## 읽어야 할 파일`에 적은 `docs/*.md`는 전부 `docs` 배열에 있어야 한다.** 어긋나면 실행기가 step 시작 전에 `exit 2`로 막는다. 선언은 필드가 하고 프로즈는 검증만 한다 — 프로즈를 주입 목록으로 쓰면 파싱이 빗나가는 순간 규칙이 소리 없이 빠진다
2. `CLAUDE.md`는 언제나 들어간다. 뺄 수 없고 뺄 필요도 없다(3천 자, CRITICAL 규칙 원본)
3. **줄이는 것이 목적이라고 필요한 문서를 빼지 마라.** 워커가 규칙을 못 본 채 지켰다고 보고하는 것이 이 리포에서 가장 나쁜 실패다. 확신이 없으면 넣는다 — 롤백은 `docs`를 지우는 것으로 끝난다

계층별 출발점(이 리포 기준): UI step → `UI_GUIDE`·`ARCHITECTURE`(+화면이 계약을 만나면 `API_SPEC`) · 라우트 step → `API_SPEC`·`TRD`·`ADR` · 순수 로직 step → `ARCHITECTURE`·`ADR` · 계약/부채 정리 step → 손대는 문서 전부.

#### 어느 소스를 실어 줄 것인가 — `steps[].sources`

step이 읽어야 할 소스를 **실행기가 프롬프트에 미리 싣는다** ([ADR-H009](../../../docs/harness/DECISIONS.md)). 지정하지 않으면 세션이 직접 읽는다(기존 동작).

왜 싣는가도 실측이다. 26 step 트랜스크립트를 turn 단위로 분해하니 **파일 읽기가 도구 호출의 38%(276회) · 컨텍스트 투입의 70.5%**였고, **읽기 turn 336회가 유발한 접두부 재독이 전체의 44.0%**였다. turn 하나가 접두부 전체를 다시 읽게 만들기 때문에, **읽기 하나를 없앨 때마다 약 10만 문자·turn이 절약된다.** 336회 중 80회(22%)는 같은 세션에서 이미 읽은 파일을 또 읽은 것이었다.

**무엇을 첨부할지는 "읽을 파일이냐 쓸 파일이냐"로 정하지 않는다.** 런 #8이 그 축을 A/B로 시험해 뒤집었다 — 쓸 파일을 첨부한 팔이 15.0 turn·$2.40, 읽을 파일만 첨부한 팔이 33.5 turn·$3.80이었다. **축은 크기이고, 첨부의 값은 *안 첨부했을 때 드는 읽기 turn 수*에 비례한다** ([ADR-H010](../../../docs/harness/DECISIONS.md)).

그 turn 수를 어림하는 눈금이 41 step 백필에서 나왔다. 세션이 도구 결과 하나로 끌어오는 양의 **중앙값이 1,713자**(p25 1,340 · p75 2,269)다. 그러므로:

> **그 파일을 통독해야 하면 대략 `문자 수 ÷ 1,700` turn, 부르기만 하면 크기와 무관하게 2~3 turn이 든다.**

**먼저 물어야 하는 것은 크기가 아니라 "이 step이 그 파일에 무엇을 하는가"다** ([ADR-H012](../../../docs/harness/DECISIONS.md)).

| 세션이 하는 일 | 어림 | 첨부 판단 |
|---|---|---|
| **통독한다** — 고칠 파일, 로직을 다시 세울 파일, 규약을 옮겨 적을 파일 | `크기 ÷ 1,700` turn **(하한)** | 크면 클수록 첨부가 값을 한다 |
| **부르기만 한다** — 시그니처·타입·한두 분기만 필요한 파일 | **2~3 turn** (크기 무관) | 크기가 커도 첨부 이득이 거의 없다 |

두 줄이 갈린 근거는 실측이다. 런 #8 `capture-guide`는 통독 대상이라 어림 16,334자에 실측 **30,644자**(1.9배 — 어림은 *파일 크기*를 세지만 세션은 테스트 출력·`grep` 결과·빌드 로그까지 끌어온다). 런 #9 `golden-runner`는 `services/anthropic.ts`(39,233자 · **어림 23.1 turn**)를 부르기만 해서 `grep -n` 1회 + `sed -n` 1회, 합 **2 turn · 6,726자**로 끝냈다 — **11.6배 과대평가**다. 크기만 보면 큰 쪽이 오히려 쌌다.

**이 판정은 기계가 대신하지 못한다.** 실행기는 step 파일의 산문을 읽지 않고, 읽더라도 "고친다"와 "부른다"를 구별할 근거가 없다. 설계자가 런 전에 판정하고 실측이 사후에 채점한다.

**틀렸을 때의 값이 비대칭이다.** 통독할 파일을 안 첨부하면 여러 turn을 물고(천장 없음), 부르기만 할 파일을 첨부하면 그 크기가 모든 turn에 곱해진다(상한 60,000자가 천장이다). **확신이 없으면 첨부한다.**

규칙 다섯:

1. **`## 읽어야 할 파일`에 적은 것 중 실재하는 비문서 파일은 전부 `sources`에 있어야 한다.** 어긋나면 `exit 2`다 — `docs`와 같은 교차검증이다. 아직 만들지 않은 파일(이 step이 만들 것)은 그 절에 적어도 요구되지 않는다
2. **합계 60,000자를 넘기지 마라**(`config.project.source_inject_max_chars`). 접두부는 **모든 turn에 곱해지므로** 상한 없는 첨부는 개선이 아니라 악화다. 넘으면 `exit 2`
3. 첨부본은 **step 시작 시점**의 내용이다. 프롬프트가 "다시 읽지 마라, 단 네가 고친 뒤의 내용은 반영되지 않는다"를 함께 싣는다
4. **상한에 걸려 고를 수밖에 없다면 `통독 대상 중` 큰 파일부터 넣는다.** 아끼는 turn 수는 크기가 아니라 **통독 여부 × 크기**에 비례한다 — 부르기만 할 파일은 39,233자여도 2 turn이므로, 그것을 넣느라 통독할 8,000자 파일을 빼면 손해다(런 #9). **쓸 파일이라고 뒤로 미루지 마라** — 쓸 파일은 정의상 통독 대상이고, 첨부본이 낡는 것은 *한 번*의 재독을 만들 뿐이라 안 읽어서 생기는 여러 turn보다 싸다
5. **읽지도 않을 파일은 넣지 마라.** 아끼는 turn이 0인데 모든 turn이 값을 치른다. **`grep` 한 번으로 끝날 파일도 여기에 가깝다** — 위 표의 둘째 줄이다

**첨부하지 못한 것을 설계 시점에 세어 둔다.** 실행기가 런이 끝나면 그 step이 실제로 끌어온 양·조각 수·조각 크기를 `runs[]`에 남기므로(아래 [ADR-H011](../../../docs/harness/DECISIONS.md)), 어림과 실측을 대조할 수 있다. **상한은 없다** — 걸면 step 설계가 그 값에 맞춰져 표본이 더는 생기지 않는다.

이 리포 실측: `app-shell` 6개 step이 각각 3~6개 · 18,642~48,664자를 지목했다. 전부 상한 안이다.

### D-3. `phases/{task-name}/step{N}.md` (각 step마다 1개)

```markdown
# Step {N}: {이름}

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/docs/ARCHITECTURE.md`
- `/docs/ADR.md`
- {이전 step에서 생성/수정된 파일 경로}

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 작업

{구체적인 구현 지시. 파일 경로, 클래스/함수 시그니처, 로직 설명을 포함.
코드 스니펫은 인터페이스/시그니처 수준만 제시하고, 구현체는 에이전트에게 맡겨라.
단, 설계 의도에서 벗어나면 안 되는 핵심 규칙은 명확히 박아넣어라.}

## Acceptance Criteria

```bash
npm run build   # 컴파일 에러 없음
npm test        # 테스트 통과
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - ARCHITECTURE.md 디렉토리 구조를 따르는가?
   - ADR 기술 스택을 벗어나지 않았는가?
   - CLAUDE.md CRITICAL 규칙을 위반하지 않았는가?
3. 결과에 따라 `phases/{task-name}/index.json`의 해당 step을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 (API 키, 외부 인증, 수동 설정 등) → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- {이 step에서 하지 말아야 할 것. "X를 하지 마라. 이유: Y" 형식}
- **`index.json`의 실행기 소유 필드를 쓰지 마라** (타임스탬프 5종 · `attempts`). 이유: 실행기가 기록한다. 네가 쓰면 실측이 오염된다
- **`RUNNING` 파일을 읽지도 지우지도 마라.** 이유: 실행기 소유다
- 기존 테스트를 깨뜨리지 마라
```

`## 읽어야 할 파일`에 적은 `/docs/*.md`는 `index.json`의 `steps[].docs`와 일치해야 한다. 어긋난 채로는 실행기가 시작하지 않는다.

금지사항을 쓰기 전에 위의 **소유 분류**를 다시 본다. 워커가 소유한 경로를 습관적으로 금지하면 그 step이 받기로 한 보고가 설계 단계에서 이미 불가능해진다 — 실제로 그 방식으로 네 건이 세 런을 살아남았다.

### E. 실행

먼저 계약 계층 게이트를 통과해야 한다. **미통과면 실행하지 않는다** — 설정과 실물이 어긋난 채로 시작하면 25분 뒤에 알게 된다.

```bash
python3 scripts/harness.py doctor              # exit 0 이어야 다음으로 간다
```

`doctor`는 `harness/config.json`과 어댑터가 이 리포의 실물(스크립트·소유 경계·계약 절 제목·base 브랜치)과 맞는지 검사한다. 경고는 통과를 막지 않지만 전부 출력에 드러난다 — `verified:false` 어댑터, 미캘리브레이션, `cmd:null` 스테이지는 "없는 것"이지 "통과한 것"이 아니다.

```bash
python3 scripts/execute.py {task-name}        # 순차 실행
python3 scripts/execute.py {task-name} --push  # 실행 후 push
```

execute.py가 자동으로 처리하는 것:

- `feat-{task-name}` 브랜치 생성/checkout
- 가드레일 주입 — CLAUDE.md + docs/*.md 내용을 매 step 프롬프트에 포함
- 컨텍스트 누적 — 완료된 step의 summary를 다음 step 프롬프트에 전달
- 자가 교정 — 실패 시 재시도하며 이전 에러 메시지를 프롬프트에 피드백한다. 상한은 `harness/calibration.json`의 `derived.retry_budget`에서 오고, 실측이 없으면 `MAX_RETRIES`(3)가 바닥값이다
- 2단계 커밋 — 코드 변경(`feat`)과 메타데이터(`chore`)를 분리 커밋
- 타임스탬프와 `attempts` — started_at, completed_at, failed_at, blocked_at 자동 기록
- **실행 중 상태** — `phases/{task-name}/RUNNING`에 pid·step·heartbeat를 남기고, 끝나면(성공·실패·차단 모두) 지운다
- **문서 주입** — `steps[].docs`가 고른 문서만 넣고, 미지정이면 전량 주입 + 경고를 찍는다
- **소스 첨부** — `steps[].sources`의 파일을 접두부에 싣는다. 미지정이면 싣지 않는다(세션이 직접 읽는다)
- **시도별 실측** — `steps[].runs[]`에 시도마다 남긴다. 소요는 여기서 읽는다 — `completed_at - started_at`은 **재개 대기 시간을 포함해** 런 #5에서 실제의 7배로 나왔다

  | 무리 | 칸 |
  |------|-----|
  | 시도 | `attempt` · `outcome` · `elapsed_sec` · `cost_usd` · `turns` · `cache_read` |
  | 접두부 분해 ([ADR-H010](../../../docs/harness/DECISIONS.md)) | `prompt_chars` · `preamble_chars` · `guardrail_chars` · `source_chars` · `context_chars` · `step_body_chars` |
  | 세션이 끌어온 양 ([ADR-H011](../../../docs/harness/DECISIONS.md)) | `session_id` · `tool_result_chars` · `tool_result_count` · `tool_output_chars` · `tool_calls` · `tool_result_p50` · `tool_result_p90` · `tool_result_max` · `tool_result_repeat_chars` · `tool_result_repeat_count` · `reads_source` |

  **못 잰 칸은 만들지 않는다** — 0으로 채우면 "재지 않았다"와 "0이었다"가 같은 칸에 들어간다. `reads_source`는 그 실측이 런 중에 났는지(`live`) 사후 집계인지(`backfill`)를 말한다

### 실행 중인 런을 오독하지 않기

`started_at`은 있는데 `step{N}-output.json`이 없는 상태는 **"지금 돌고 있다"와 "죽었다"를 동시에 뜻한다.** 출력 파일은 모델 호출이 반환한 뒤에야 쓰이기 때문이다. 실제로 감독 세션이 9분째 작업 중이던 step을 "끊겼다"로 읽고 산출물을 되돌린 적이 있다.

**진행 중인지 보려면 `RUNNING`을 본다.** `heartbeat`가 5분 이내면 살아 있는 것이다.

```bash
cat phases/{task-name}/RUNNING     # heartbeat 가 지금과 가까우면 돌고 있다
```

- 살아 있는 런의 소스·`index.json`을 고치지 마라. 실행기를 하나 더 띄우지도 마라 — 둘이 같은 `index.json`을 고치면 산출물이 서로를 덮는다. 실행기가 `exit 2`로 막지만, 막히기 전에 사람이 파일을 건드리는 것까지 막지는 못한다.
- **`RUNNING`을 손으로 지우지 마라.** 실행기 소유다. 정말 죽은 런이라고 확신할 때만 지운다.
- 실행기가 죽은 런의 `RUNNING`을 발견하면 스스로 회수하고, 그 step을 재개로 표시해 세션에게 "이미 있는 것을 먼저 읽어라"라고 알린다.

에러 복구:

- **error 발생 시**: `phases/{task-name}/index.json`에서 해당 step의 `status`를 `"pending"`으로 바꾸고 `error_message`를 삭제한 뒤 재실행한다.
- **blocked 발생 시**: `blocked_reason`에 적힌 사유를 해결한 뒤, `status`를 `"pending"`으로 바꾸고 `blocked_reason`을 삭제한 뒤 재실행한다.
- 어느 쪽이든 `started_at`·`attempts`는 되돌리지 않는다. 실행기가 소유한 실측이다.
