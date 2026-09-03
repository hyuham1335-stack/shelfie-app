---
description: 요청 하나를 계획 → 교차검증 → 구현 → 게이트 → 코드리뷰(01~05)까지 끌고 간다. PR 은 만들지 않는다.
---

> **이 커맨드는 페이즈 01~05(계획 · 교차검증 · 구현 · 게이트 · 코드리뷰)까지만 돈다.**
> 06~08(PR · PR리뷰 · 보고서)은 아직 구현되지 않았다.
> **PR 을 만들지 않고 push 하지 않는다.** 끝나면 무엇이 남았는지 보고한다.

요청: $ARGUMENTS

---

## 0. 게이트

```bash
python scripts/pipeline/cli.py doctor
```

**exit 2 면 여기서 멈춘다.** FAIL 항목을 사용자에게 그대로 보고하고 **고치려 들지
마라** — 설정과 실물이 어긋난 것이고, 무엇을 맞출지는 사람이 정한다.

## 1. 요청을 파일로 동결한다

`_workspace/requests/{slug}.md` 에 **사용자가 친 문장을 한 글자도 바꾸지 않고**
쓴다. 요약·정리·다듬기·번역 전부 금지다.

slug 는 `^[a-z0-9][a-z0-9-]*$` 형태로 제안하고 사용자에게 확인받는다.

> **이 단계의 한계를 알고 있어라.** `init` 이 바이트와 sha256 을 박으므로 그
> **이후**의 변조는 기계가 잡는다. 그러나 네가 옮겨 적는 **그 순간**의 의역은
> 아무도 잡지 못한다. 여기가 이 파이프라인에서 사람의 의도가 새어 나갈 수 있는
> 유일한 자리다.

```bash
python scripts/pipeline/cli.py init --feature {slug} \
    --request-file _workspace/requests/{slug}.md
```

## 2. 루프

```bash
python scripts/pipeline/cli.py next
```

봉투(stdout 의 JSON 하나)에서 **`render` 와 `next_command` 둘만 읽는다.**
다른 필드로 판단하지 마라.

1. `render` 가 시키는 대로 한다
2. `produces[].path` 에 파일을 쓴다
3. `next_command` 를 그대로 실행한다

### 종료 코드별 대처

| exit | 뜻 | 할 일 |
|---|---|---|
| 0 | 진행 | 봉투의 `next_command` 를 계속 따른다 |
| 3 | 선행조건 미충족 | `render` 가 말한 것을 채우고 같은 명령을 다시 친다 |
| 4 | 기계 판정 실패, 예산 남음 | 수리한다. **`data.repair_dispatch` 의 배정을 그대로 쓴다** |
| 8 | 제출물이 스키마·정합성을 어겼다 | 고쳐서 다시 낸다 |
| 5 · 7 · 10 | 예산 소진 · 반복 한계 · 에스컬레이션 | **멈춘다.** `ESCALATION.md` 의 선택지를 그대로 사용자에게 제시한다 |
| 11 | 이 실행기의 범위 끝 | 종료 보고로 간다 |

### 03-implement 에서

역할 전원을 **한 메시지 안에서 동시 호출**한다. 각 역할에게 봉투의 역할 프롬프트
템플릿을 채워 준다 — 소유권 표를 **그대로** 싣고 glob 을 문장으로 옮겨 적지 마라.

계약 파일은 **네가 직접 쓴다.** 역할 에이전트에게 위임하지 않는다.

### 04-gate 에서

```bash
python scripts/pipeline/cli.py gate --phase 04
```

실패하면 봉투가 소유자와 브리프를 준다. **실패를 다시 분류하지 마라** — 배정은
게이트가 이미 했고, 네가 다시 정하면 핑퐁 방지와 시그니처 추적이 무너진다.

### 05-code-review 에서

**비용 오름차순이고, 앞의 두 개는 모델을 부르지 않는다.**

```bash
python scripts/pipeline/cli.py precheck --scope pr --run-id <id>
python scripts/pipeline/cli.py contract-trace --run-id <id>
```

| exit | 뜻 | 할 일 |
|---|---|---|
| 9 | 예산·브랜치·base | **사람에게 묻는다.** 자동으로 쪼개거나 리베이스하지 마라 |
| 10 | 인프라 프로브 실패 | 멈춘다. 카운터는 소모되지 않았다 |
| 8 (trace) | Critical 이 남았다 | 고치고 `gate --phase 04 --stage scoped` 후 다시 친다 |

그다음 **봉투가 준 리뷰어 목록을 그대로** 한 메시지 안에서 병렬 호출한다.

- **누구를 부를지 다시 정하지 마라.** 라우팅은 `when` glob 이 정하는 결정론이다
- 프롬프트 첫 줄은 **스킬 파일을 읽으라는 지시**다. 본문을 복사하지 마라 —
  리뷰어 수만큼 그 고정비가 곱해진다
- 봉투의 **"검토 제외"** 목록을 그대로 전달한다
- 리뷰어에게 **리포 탐색을 허용하지 마라.** 부족하면 `need_more_context` 에 적게 한다

리뷰어마다 `.raw.md` 와 `.json` **두 파일**을 받고 하나씩 제출한다.

```bash
python scripts/pipeline/cli.py record --phase 05 --file <리뷰 json> \
    --reviewer <code> --round <n> --run-id <id>
```

**원문 헤딩 개수와 findings 개수가 다르면 exit 8 이다. 네가 사후에 헤딩을 붙여
맞추지 마라** — 원문 대조라는 검사의 취지가 그 순간 사라진다. 리뷰어에게 형태를
다시 알려 주고 다시 받는다.

exit 4 면 Critical/Major 수리다. **Minor 는 고치지 않는다** — 원장에 쌓이고
보고서로 간다.

## 3. 종료 보고

`status` 로 확인하고 아래를 사람이 읽을 수 있게 적는다.

- 등급과 `gaps` 전부 — **스킵된 것을 통과로 적지 마라**
- 스킵된 스테이지: **"이 스택에 없는 것"과 "이번에 안 건드려서 건너뛴 것"을 구분**
- **`review05.status`** — `degraded`·`failed` 면 **몇 명이 계획됐고 몇 명이
  성공했는지**까지 적는다. findings 0건과 "리뷰가 없었다"는 다른 사실이다
- `contract-trace` 가 **건너뛴 검사**가 있으면 그것도 (통과가 아니다)
- `dropped_by_enforcement` 와 `truncated` 가 0이 아니면 그 수
- 카운터 사용량과 모델 호출 근사치(근사임을 명시)
- 런 디렉터리 경로
- 그리고 이 문장:
  > 06~08 은 아직 구현되지 않았다. 이 런은 **PR 을 만들지 않았고 push 하지 않았다.**
  > 코드는 워킹트리에 있다.

## 다른 진입

```bash
python scripts/pipeline/cli.py next --run-id <id>     # 세션 복구
python scripts/pipeline/cli.py status                 # 현황
python scripts/pipeline/cli.py resume --ack --answer-file <경로>   # 잠금 해제
```

## 금지

- **`git push` · PR 생성 · 브랜치 생성을 직접 하지 마라.** 이유: 이 실행기의
  범위가 아니고, 06 이 생기기 전까지 그 판단은 사람의 것이다
- **봉투 없이 스테이지 명령을 직접 돌리지 마라.** 이유: 결과가 영수증에 남지 않아
  지문 대조가 성립하지 않는다
- **실패 귀속을 다시 하지 마라.** 이유: 배정은 게이트가 한다
- **계약을 역할 에이전트에게 쓰게 하지 마라.** 이유: 메인 단독 소유다
- **`harness/config.json` · `harness/adapters/*` · `harness/calibration.json` 을
  고치지 마라.** 이유: 게이트가 검사할 기준을 게이트를 통과하려고 고치는 것이다
- **실패를 요약해 없애지 마라.** 이유: 스킵·미측정·미검증이 보고서에 드러나는 것이
  이 파이프라인의 존재 이유다
