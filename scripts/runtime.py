"""코어와 순차 실행기가 함께 쓰는 원시요소.

**이 파일이 생긴 이유는 소유권이지 재사용이 아니다.** 트랜스크립트를 읽는 일과
출력 인코딩을 고정하는 일은 `scripts/execute.py`(순차 step 실행기) 안에 살고
있었는데, 8페이즈 코어(`scripts/pipeline/*` · `session_log.py`)가 그것을 쓰려고
실행기를 import 했다. 그래서 **코어가 실행기에 의존**했다.

`harness-template` 추출은 실행기를 안 싣는다 — 헤드리스 승인 우회를 클론하는
사람이 물려받게 하지 않기 위해서다 (ROADMAP 36). 그 상태로 추출하면 코어가
없는 모듈을 물고 죽는다. 지식을 **그것을 소유해야 할 계층**으로 내린 것이 이
파일이다 (ADR-H037). [[ADR-H031]] 이 스택 실행기 이름 목록을 코어에서 어댑터
선언으로 내린 것과 방향만 반대이고 규율은 같다 — 그 상수 이름을 여기 적지 않는
것은 그것을 감시하는 자물쇠(`CoreHasNoStackNamesTest`)가 인용까지 잡기 때문이고,
잡는 것이 맞다.

**실행기는 여전히 이것을 쓴다** — 여기서 내보내고 `execute.py` 가 읽는다.
같은 지식이 두 곳에 살면 한쪽만 고쳐지는 날이 온다.

모듈명 `runtime` 은 stdlib 과 겹치지 않는다(확인함). `scripts/pipeline/` 이
stdlib `trace` 를 가리지 않으려고 `trace_contract.py` 를 쓴 것과 같은 확인이다.
"""

import hashlib
import json
import sys
from datetime import timezone, timedelta
from pathlib import Path
from typing import Optional

# 이 리포의 타임존. **여기서 매개변수화하지 않는다** — 옮기면서 동시에 고치면
# 회귀가 났을 때 어느 쪽이 원인인지 못 가른다 (ADR-H037).
TZ = timezone(timedelta(hours=9))



# step 세션의 트랜스크립트가 쌓이는 곳 (ROADMAP 29 · ADR-H011).
# 하위 디렉토리 이름(슬러그)은 유도하지 않고 session_id 로 glob 한다 —
# 슬러그 규칙은 Claude Code 구현 세부이고, 이 리포는 경로 casing 함정에
# 두 번 물렸다. session_id 는 UUID 라 한 번의 glob 으로 유일하게 잡힌다.
TRANSCRIPT_ROOT = Path.home() / ".claude" / "projects"


def _percentile(sorted_sizes: list, pct: int) -> int:
    """최근접 순위(nearest-rank). **보간하지 않는다.**

    보간하면 관측된 적 없는 숫자가 칸에 앉는다 — 100 과 300 만 왔는데
    p50 이 200 이면, 그 200 은 이 세션이 한 번도 받아 본 적 없는 크기다.
    유도된 값이 원자료로 오해되지 않게 실제 관측값 하나를 돌려준다.
    """
    rank = -(-pct * len(sorted_sizes) // 100)      # ceil, 정수만으로
    return sorted_sizes[max(rank, 1) - 1]


def _distribution(sizes: list, repeat_chars: int, repeat_count: int) -> dict:
    """호출당 결과 크기의 분포와 재수신 몫.

    결과가 0 건이면 **칸을 만들지 않는다** — 0 으로 채우면 "한 번도 안
    끌어왔다"와 "안 쟀다"가 같은 칸에 들어간다 (ADR-H007).
    """
    if not sizes:
        return {}
    ordered = sorted(sizes)
    return {"tool_result_p50": _percentile(ordered, 50),
            "tool_result_p90": _percentile(ordered, 90),
            "tool_result_max": ordered[-1],
            "tool_result_repeat_chars": repeat_chars,
            "tool_result_repeat_count": repeat_count}


def force_utf8_output():
    """이 프로세스의 출력을 UTF-8 로 고정한다.

    리다이렉트된 stdout 은 로캘(cp949)을 쓴다. 진행 표시의 ✓ · ▶ 나 한글
    에러 메시지가 그 순간 UnicodeEncodeError 를 내고 **실행기가 죽는다** —
    런 #3에서 step 3 완료를 출력하다 phase 가 중단됐다. 출력 하나 때문에
    완주가 깨지면 안 되므로 errors="replace" 로 넘어간다.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


# import 만으로 인코딩이 고정된다 — 코어의 진입점들이 이것에 기대고 있다.
force_utf8_output()


def read_cost_state(session_id: Optional[str], *,
                     transcript_root: Optional[Path] = None) -> dict:
    """세션 **누적** 비용을 트랜스크립트의 `cost-state` 레코드에서 읽는다.

    **`_extract_usage` 와 뜻이 다르다.** 그쪽은 `claude -p` **한 번**의
    비용이고 이쪽은 **세션 전체**(서브에이전트 포함)다. 그래서 키에
    `session_` 을 붙여 **구조적으로** 겹치지 않게 했다 — `_record_run` 의
    `entry.update` 가 둘을 겹쳐 쓰면 뒤엣것이 조용히 이긴다. 그 함수에
    배선하지도 않는다. `_session_id` 를 `_extract_usage` 에서 갈라 둔 것과
    같은 이유다. 런 단위 합계 이름으로 옮기는 것은 `cli.run_cost` 가 한다.

    **서브에이전트를 포함한다** — 43개 트랜스크립트로 갈랐다.
    서브에이전트가 0개인 세션 다섯에서 메인 트랜스크립트만으로
    `modelUsage` 와 정확히 일치하고, 있는 세션에서는 메인만으로 크게
    모자란다. 포함하지 않는다면 뒤쪽도 일치해야 한다.

    **트랜스크립트 재구성으로 대조하지 않는다.** 서브에이전트 jsonl 은
    `apiBlockIndex` 로 쪼갠 부분 usage 를 담고, `modelUsage` 에는
    트랜스크립트에 레코드조차 없는 haiku 부수 호출이 있다 — 재구성값은
    신뢰할 수 없는 하한이다.

    **마지막 레코드가 이긴다.** 한 파일에 두 건인 경우가 실물 43개 중
    6건이고, 누적값은 같고 `totalDuration` 만 다르다.

    레코드는 트랜스크립트의 **마지막 줄**로 써진다 — 그 세션 자신의
    `SessionEnd` 훅은 이 값을 볼 수 없다. 그래서 런 비용은 훅이 아니라
    **읽는 시점**에 집계한다 (`cli.run_cost`).

    못 재면 키를 만들지 않는다 (ADR-H007). `hasUnknownModelCost` 면
    `cost_usd` 대신 그 플래그를 적는다 — 값을 모르는 모델이 섞인 합계는
    비용이 아니다.
    """
    if not session_id:
        return {}
    root = TRANSCRIPT_ROOT if transcript_root is None else Path(transcript_root)
    try:
        paths = sorted(root.glob(f"*/{session_id}.jsonl"))
    except OSError:
        return {}
    if not paths:
        return {}

    latest = None
    try:
        with paths[0].open(encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"cost-state"' not in line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    # 쓰이는 중이면 마지막 줄이 잘려 있을 수 있다.
                    continue
                if isinstance(rec, dict) and rec.get("type") == "cost-state":
                    latest = rec
    except OSError:
        return {}
    if latest is None:
        return {}

    out: dict = {"session_id": session_id}
    unknown = latest.get("hasUnknownModelCost")
    if unknown is True:
        out["unknown_model_cost"] = True
    else:
        cost = latest.get("totalCostUSD")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            out["session_cost_usd"] = round(float(cost), 4)
    for src_key, dst_key in (("totalDuration", "duration_ms"),
                             ("totalAPIDuration", "api_duration_ms")):
        val = latest.get(src_key)
        if isinstance(val, int) and not isinstance(val, bool):
            out[dst_key] = val

    usage = latest.get("modelUsage")
    if isinstance(usage, dict):
        totals = {}
        models = {}
        for name, cell in usage.items():
            if not isinstance(cell, dict):
                continue
            models[name] = cell.get("costUSD")
            for s_key, d_key in (("inputTokens", "session_input_tokens"),
                                 ("outputTokens", "session_output_tokens"),
                                 ("thinkingTokens", "session_thinking_tokens"),
                                 ("cacheReadInputTokens", "session_cache_read"),
                                 ("cacheCreationInputTokens",
                                  "session_cache_write")):
                val = cell.get(s_key)
                if isinstance(val, int) and not isinstance(val, bool):
                    totals[d_key] = totals.get(d_key, 0) + val
        out.update(totals)
        if models:
            out["models"] = models
    return out


def read_session_metrics(session_id: Optional[str], *,
                          transcript_root: Optional[Path] = None) -> dict:
    """세션이 접두부 **밖에서** 끌어온 양을 트랜스크립트에서 잰다 (ROADMAP 29).

    접두부는 ADR-H010 이 분해해서 재게 했는데, 런 #7·#8 이 두 번 연속
    "접두부가 크면 비싸다"를 반증했다 — 접두부 최대 step 이 두 번 최저
    비용이었다. 런 #8 이 진짜 변수를 지목했다: **첨부되지 않아 세션이
    직접 읽어야 했던 양**이다(66,275자 → 44 turn · 16,334자 → 23 turn).
    실행기는 sources(첨부한 것)는 알면서 그것을 몰랐다.

    **분류하지 않는다.** step 세션은 bashFirst 로 돌아 cat·sed·grep 으로
    읽고 heredoc 으로 쓴다 — 런 #8 step 0 은 도구 호출 15건이 전부 Bash 다.
    이름으로 "읽기/쓰기"를 가르면 틀린 숫자가 나오고, 틀린 숫자는 없는
    숫자보다 나쁘다. 이름별 횟수만 원자료로 남기고 해석은 사람이 한다.

    못 재면 키를 만들지 않는다 — 0 으로 채우면 "재지 않았다"와 "0 이었다"가
    같은 칸에 들어간다 (ADR-H007 이 attempts 에서 겪은 실패).

    **합계만으로는 부족했다.** 41 step 백필이 끌어온 양 ↔ 비용 r=0.752 를
    냈지만 0.95 가 아니었고, 이유가 두 행에 있다 — 같은 양(≈79,800자)을
    끌어온 booklist-props 는 22 turn, request-contract 는 44 turn 이다.
    tool_result_count 는 15 step 전부에서 turns-1 이라 새 정보가 아니다.
    새 정보는 **한 호출이 얼마나 큰가**(p50·p90·max)와 **그 중 몇 자가
    이미 왔던 것인가**(repeat)뿐이다.

    **중복은 명령을 파싱하지 않고 결과 내용으로 잰다.** `cat page.tsx` 와
    `sed -n '1,80p' page.tsx` 를 같은 파일로 묶으려면 셸 명령을 해석해야
    하는데, 그것이 이 함수가 이름으로 분류하기를 거부한 바로 그 자리다.
    내용을 그대로 해싱하면 파싱이 없다 — 대신 부분 읽기와 파일이 바뀐 뒤의
    재독은 안 잡히므로 **하한**이다 (tool_output_chars 와 같은 성격이다).

    백분위는 **보간하지 않는다.** 최근접 순위로 실제 관측값 하나를
    돌려준다 — 유도된 값이 원자료로 오해되지 않게 한다.
    """
    if not session_id:
        return {}
    root = TRANSCRIPT_ROOT if transcript_root is None else Path(transcript_root)
    try:
        paths = sorted(root.glob(f"*/{session_id}.jsonl"))
    except OSError:
        return {}
    if not paths:
        return {}

    def _block_text(content) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(b["text"] for b in content
                           if isinstance(b, dict) and isinstance(b.get("text"), str))
        return ""

    def _raw_chars(tur) -> int:
        if isinstance(tur, str):
            return len(tur)
        if isinstance(tur, dict):
            total = 0
            for key in ("stdout", "stderr", "content", "output"):
                val = tur.get(key)
                if isinstance(val, str):
                    total += len(val)
            return total
        return 0

    result_chars = raw_chars = result_count = 0
    repeat_chars = repeat_count = 0
    sizes: list = []
    seen: set = set()
    calls: dict = {}
    for path in paths:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                # 트랜스크립트가 쓰이는 중이면 마지막 줄이 잘려 있을 수 있다.
                # 한 줄 때문에 나머지 실측을 버리지 않는다.
                continue
            if not isinstance(rec, dict) or rec.get("isSidechain"):
                # 서브에이전트의 도구 결과는 메인 컨텍스트에 들어가지 않는다.
                continue
            msg = rec.get("message")
            if isinstance(msg, dict) and isinstance(msg.get("content"), list):
                for blk in msg["content"]:
                    if not isinstance(blk, dict):
                        continue
                    if blk.get("type") == "tool_use":
                        name = blk.get("name")
                        if isinstance(name, str):
                            calls[name] = calls.get(name, 0) + 1
                    elif blk.get("type") == "tool_result":
                        text = _block_text(blk.get("content"))
                        result_chars += len(text)
                        result_count += 1
                        sizes.append(len(text))
                        if text:
                            # 빈 결과끼리는 중복으로 세지 않는다 — 그러면
                            # 재수신 건수가 세션이 하지 않은 일을 말한다.
                            digest = hashlib.sha1(text.encode("utf-8")).digest()
                            if digest in seen:
                                repeat_chars += len(text)
                                repeat_count += 1
                            else:
                                seen.add(digest)
            if rec.get("toolUseResult") is not None:
                raw_chars += _raw_chars(rec["toolUseResult"])

    return {"session_id": session_id,
            "tool_result_chars": result_chars,
            "tool_result_count": result_count,
            # 도구가 남긴 원본 stdout·stderr 다. 16KB 를 넘는 출력은 파일로
            # 빠지고 컨텍스트에 들어가는 블록은 잘리므로, 이 값이 크면 그
            # 차이가 잘린 양이다. 다만 **하한**이다 — Edit 처럼 결과가
            # 구조화된 도구는 stdout 을 남기지 않아 여기서 세지 못한다.
            # 예산에 쓰는 숫자는 위의 tool_result_chars 쪽이다.
            "tool_output_chars": raw_chars,
            "tool_calls": dict(sorted(calls.items())),
            **_distribution(sizes, repeat_chars, repeat_count)}
