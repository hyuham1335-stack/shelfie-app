#!/usr/bin/env python3
"""8페이즈 feature-pipeline 의 진입점.

    python scripts/pipeline/cli.py <cmd> [옵션]

**stdout 은 언제나 단일 JSON 봉투 하나다.** 진단·러너 출력은 stderr 로 간다.
모델이 읽는 것은 봉투의 `render` 와 `next_command` 둘뿐이고, 다른 필드로
판단하기 시작하면 이 계약이 깨진다.

이 파일이 `scripts/pipeline/` 을 패키지로 만들지 않는 이유: 정본(team-spec)이
`next_command` 를 `python scripts/pipeline/cli.py …` 로 문자 그대로 적어 두었다.
봉투가 내는 명령 전문이 스펙이므로 직접 스크립트 실행이 계약이다.

종료 코드는 team-spec 2.3 을 따른다:
    0 성공 · 1 내부 오류 · 2 사용법/미해결 플레이스홀더/doctor 미통과
    3 선행조건 미충족 · 4 기계 판정 실패(예산 남음) · 5 예산 소진
    6 advance 거부(지문 stale) · 7 반복 한계·stuck · 8 제출물 위반
    9 사용자 판단 대기(01~04 에는 없다) · 10 에스컬레이션(상태를 잠근다)
    11 런 완료
"""

import argparse
import json
import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))            # 형제 모듈
sys.path.insert(0, str(_HERE.parent))     # scripts/harness.py · execute.py

import harness  # noqa: E402  — 소유 판정·스키마 검증·doctor 의 단일 출처
import state as st  # noqa: E402
import adapters  # noqa: E402
import verdict  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent
PHASES_REL = "harness/phases"
TAXONOMY_REL = "docs/harness/pipeline/ledger/taxonomy.json"

# 프론트매터 어휘. 늘리려면 여기와 team-spec 을 함께 고친다.
REQUIRES_KINDS = ("file", "state", "clean_ownership", "adapter_stage")
PRODUCES_KINDS = ("json", "markdown")
FRONT_KEYS = ("id", "index", "owner", "approval", "docs", "requires", "produces",
              "review", "converge", "submit_checks", "skip_when", "on_skip",
              "gate", "loop", "allow", "on_success")
REQUIRED_SECTIONS = ("## 목적", "## 진입 조건", "## 절차",
                     "## 제출 형식", "## 금지", "## 실패 시")
ROLE_TEMPLATE_SECTION = "## 역할 프롬프트 템플릿"

_PLACEHOLDER = re.compile(r"\$\{([a-zA-Z0-9_.\[\]]+)\}")
_NAMESPACES = ("config", "calibration", "run")

# lint 는 런 없이 돈다. 경로 길이를 최악으로 재기 위한 자리표시자다 —
# run_id 18자 + slug 40자로 채운 값이 240자 상한을 넘지 않아야 한다.
LINT_RUN_ID = "20260101-0000-0000"
LINT_SLUG = "s" * 40


class PlaceholderError(ValueError):
    """`${...}` 를 해결하지 못했다. lint-phases 가 exit 2 로 거부한다."""


# ------------------------------------------------------------------ 진단 출력

def warn(text):
    """사람이 읽는 줄은 전부 stderr 로. stdout 은 봉투 전용이다."""
    sys.stderr.write(text + "\n")


# ------------------------------------------------------------- 페이즈 파서

def parse_phase_file(path):
    """(front, body, sections). 프론트매터는 `---` 로 감싼 **JSON** 이다.

    서드파티 파서를 쓰지 않기 위한 결정이고(런타임 전제), 잘못 쓰면 즉시
    예외가 나므로 조용히 반쯤 읽히는 일이 없다.
    """
    text = Path(path).read_text(encoding="utf-8")
    if not text.startswith("---"):
        raise ValueError("프론트매터 구분자(---)로 시작하지 않는다")
    rest = text[3:].lstrip("\r\n")
    end = rest.find("\n---")
    if end < 0:
        raise ValueError("프론트매터를 닫는 --- 가 없다")
    raw, body = rest[:end], rest[end + 4:]
    try:
        front = json.loads(raw)
    except ValueError as exc:
        raise ValueError("프론트매터 JSON 파싱 실패: %s" % exc)
    if not isinstance(front, dict):
        raise ValueError("프론트매터가 객체가 아니다")
    sections = [line.strip() for line in body.splitlines()
                if line.startswith("## ")]
    return front, body.lstrip("\r\n"), sections


def load_phases(root, phases_dir=None):
    """{id: {path, front, body, sections}} 또는 파싱 실패 목록."""
    d = Path(phases_dir or (Path(root) / PHASES_REL))
    loaded, broken = {}, []
    for p in sorted(d.glob("*.md")):
        try:
            front, body, sections = parse_phase_file(p)
        except ValueError as exc:
            broken.append((p, str(exc)))
            continue
        loaded[front.get("id") or p.stem] = {
            "path": p, "front": front, "body": body, "sections": sections}
    return loaded, broken


# ------------------------------------------------------------ 플레이스홀더

def build_context(root, paths=None, state=None, config=None, calibration=None):
    """`${config|calibration|run}` 세 네임스페이스. **state 는 여기에 없다.**

    state 는 `${}` 보간 대상이 아니라 `pointer`·`unless` 의 조건식 전용이다.
    보간 대상으로 만들면 페이즈 파일이 런 중 상태를 문자열로 끌어다 쓰기 시작하고,
    그러면 같은 페이즈 파일이 런마다 다른 것을 뜻하게 된다.
    """
    root = Path(root)
    if config is None:
        config = harness._read_json(root / harness.CONFIG_REL)
    if calibration is None:
        cal_rel = config.get("calibration_file")
        if cal_rel and (root / cal_rel).exists():
            try:
                calibration = harness._read_json(root / cal_rel)
            except (OSError, ValueError):
                calibration = {}
        else:
            calibration = {}

    if paths is not None:
        run_id, run_dir = paths.run_id, paths.run_dir.as_posix()
        slug = (state or {}).get("slug") or LINT_SLUG
    else:
        run_id, slug = LINT_RUN_ID, LINT_SLUG
        run_dir = (root / st.RUNS_REL / run_id).as_posix()

    template = ((config.get("contract") or {}).get("path_template")
                or "_workspace/contract_{slug}.md")
    return {
        "config": config,
        "calibration": calibration or {},
        "run": {"id": run_id, "dir": run_dir, "slug": slug,
                "contract_file": template.replace("{slug}", slug)},
    }


def _lookup(ctx, dotted):
    ns = dotted.split(".")[0]
    if ns not in _NAMESPACES:
        raise PlaceholderError(
            "`%s` 는 참조할 수 없는 네임스페이스다 — %s 셋만 쓴다"
            % (ns, "·".join(_NAMESPACES)))
    node = ctx
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            raise PlaceholderError("`${%s}` 를 해결하지 못했다" % dotted)
        node = node[part]
    return node


def resolve(value, ctx):
    """문자열 안의 `${...}` 를 해결한다.

    전체가 플레이스홀더 하나면 **원래 타입을 유지한다** — 숫자 비교가 문자열
    비교로 조용히 바뀌지 않게.
    """
    if isinstance(value, list):
        return [resolve(v, ctx) for v in value]
    if isinstance(value, dict):
        return {k: resolve(v, ctx) for k, v in value.items()}
    if not isinstance(value, str):
        return value
    whole = _PLACEHOLDER.fullmatch(value.strip())
    if whole:
        return _lookup(ctx, whole.group(1))
    return _PLACEHOLDER.sub(lambda m: str(_lookup(ctx, m.group(1))), value)


# --------------------------------------------------------- 조건식 (unless 등)

_CONDITION = re.compile(r"^\s*([A-Za-z0-9_.]+)\s*(==|!=)\s*(.+?)\s*$")


def eval_condition(expr, state):
    """`state.<pointer> == <JSON 리터럴>` 만 받는다. eval 을 쓰지 않는다.

    페이즈 파일이 임의 코드 실행 벡터가 되지 않게 하는 원칙이 명령에만
    적용되고 조건식에는 안 적용될 이유가 없다.
    """
    m = _CONDITION.match(expr or "")
    if not m:
        raise ValueError("해석할 수 없는 조건식: %r" % expr)
    pointer, op, literal = m.group(1), m.group(2), m.group(3)
    if not pointer.startswith("state."):
        raise ValueError("조건식은 state. 로 시작해야 한다: %r" % expr)
    try:
        want = json.loads(literal)
    except ValueError:
        want = literal.strip('"\'')
    got = harness._json_pointer(state or {}, pointer[len("state."):])
    return (got == want) if op == "==" else (got != want)


# --------------------------------------------------------------- requires

def check_requires(root, requires, ctx, state):
    """[{kind, ok, skipped, message}]. 실패해도 예외를 내지 않는다."""
    out = []
    for req in requires or []:
        kind = req.get("kind")
        if req.get("unless"):
            try:
                if eval_condition(req["unless"], state):
                    out.append({"kind": kind, "ok": True, "skipped": True,
                                "message": "unless 가 참이다: %s" % req["unless"]})
                    continue
            except ValueError as exc:
                out.append({"kind": kind, "ok": False, "skipped": False,
                            "message": str(exc)})
                continue
        handler = _REQUIRE_HANDLERS.get(kind)
        if handler is None:
            out.append({"kind": kind, "ok": False, "skipped": False,
                        "message": "알 수 없는 requires kind: %r" % kind})
            continue
        out.append(handler(Path(root), req, ctx, state))
    return out


def _req_file(root, req, ctx, state):
    path = root / resolve(req["path"], ctx)
    if not path.exists():
        return _bad("file", "없다: %s" % req["path"])
    raw = path.read_bytes()
    if req.get("min_bytes") and len(raw) < req["min_bytes"]:
        return _bad("file", "%s 가 %d바이트로 최소 %d 에 못 미친다"
                    % (req["path"], len(raw), req["min_bytes"]))
    needles = req.get("must_contain")
    if needles:
        text = raw.decode("utf-8", "replace")
        for needle in ([needles] if isinstance(needles, str) else needles):
            resolved = resolve(needle, ctx)
            if resolved not in text:
                return _bad("file", "%s 에 `%s` 가 없다" % (req["path"], resolved))
    pointer = req.get("sha256_pointer")
    if pointer:
        import hashlib
        want = harness._json_pointer(state or {}, pointer)
        if want and hashlib.sha256(raw).hexdigest() != want:
            return _bad("file", "%s 의 sha256 이 상태의 것과 다르다 — 동결이 깨졌다"
                        % req["path"])
    return _ok("file")


def _req_state(root, req, ctx, state):
    got = harness._json_pointer(state or {}, req["pointer"])
    if "in" in req:
        return (_ok("state") if got in req["in"] else
                _bad("state", "%s 가 %r 인데 %r 중 하나여야 한다"
                     % (req["pointer"], got, req["in"])))
    want = req.get("equals")
    return (_ok("state") if got == want else
            _bad("state", "%s 가 %r 인데 %r 이어야 한다" % (req["pointer"], got, want)))


def _req_adapter_stage(root, req, ctx, state):
    try:
        _config, adapter, _cal = adapters.load(root)
    except (OSError, ValueError, KeyError) as exc:
        return _bad("adapter_stage", "어댑터를 읽지 못했다: %s" % exc)
    absent = [n for n in req.get("steps") or []
              if adapters.stage_state(adapter, n) == "absent"]
    if not absent:
        return _ok("adapter_stage")
    msg = "이 스택에 없는 스테이지: %s — 없는 것이지 통과한 것이 아니다" % ", ".join(absent)
    if req.get("mode") == "warn":
        return {"kind": "adapter_stage", "ok": True, "skipped": False,
                "warn": True, "message": msg}
    return _bad("adapter_stage", msg)


def _req_clean_ownership(root, req, ctx, state):
    import attribution
    verdict = attribution.clean_ownership(root, _config_of(ctx), _claims_of(root, req, ctx))
    if verdict["ok"]:
        return _ok("clean_ownership")
    return dict(_bad("clean_ownership", verdict["message"]), detail=verdict)


def _config_of(ctx):
    return ctx["config"]


def _claims_of(root, req, ctx):
    path = req.get("claims")
    if not path:
        return None
    p = Path(root) / resolve(path, ctx)
    if not p.exists():
        return None
    try:
        return harness._read_json(p)
    except (OSError, ValueError):
        return None


_REQUIRE_HANDLERS = {
    "file": _req_file,
    "state": _req_state,
    "adapter_stage": _req_adapter_stage,
    "clean_ownership": _req_clean_ownership,
}


def _ok(kind, message=""):
    return {"kind": kind, "ok": True, "skipped": False, "message": message}


def _bad(kind, message):
    return {"kind": kind, "ok": False, "skipped": False, "message": message}


# ---------------------------------------------------------------------- doctor

def cmd_doctor(root, args):
    """계약 계층 doctor 에 위임하고 파이프라인 검사 셋을 더한다.

    같은 검사를 두 번 구현하지 않는다 — 소유 판정·스키마 검증이 두 곳에서
    갈라지는 것이 이 리포가 이미 기록한 실패다.
    """
    report = harness.run_doctor(root)
    harness_data = {
        "checks": [{"name": c.name, "status": c.status, "message": c.message}
                   for c in report.checks],
        "failures": len(report.failures),
        "warnings": len(report.warnings),
    }
    pipeline = _pipeline_checks(root)
    warn(report.text())
    for c in pipeline:
        warn("  %-4s %s" % (c["status"], c["name"]))
        if c.get("message"):
            warn("         %s" % c["message"])

    failed = report.failures or [c for c in pipeline if c["status"] == "FAIL"]
    exit_ = 2 if failed else 0
    render = _doctor_render(harness_data, pipeline, exit_)
    return st.emit(st.envelope(
        "doctor", exit_ == 0, exit_, None,
        {"harness": harness_data, "pipeline": pipeline},
        render,
        None if exit_ else "python scripts/pipeline/cli.py init --feature <slug> "
                           "--request-file <경로>"))


def _pipeline_checks(root):
    """계약 계층이 보지 않는 것 셋. 전부 /feature 진입 **전에** 값싸게 잡힌다."""
    out = []

    # ① 작업 공간이 무시되는가. 아니면 03 의 clean_ownership 이 계약 파일을
    #    orphan 으로 잡아 exit 8 로 죽는다.
    r = harness._git(root, "check-ignore", "-q", "%s/probe" % st.WORKSPACE_REL)
    if r is None:
        out.append({"name": "작업 공간 무시", "status": "SKIP",
                    "message": "git 을 부를 수 없다"})
    elif r.returncode == 0:
        out.append({"name": "작업 공간 무시", "status": "PASS"})
    else:
        out.append({"name": "작업 공간 무시", "status": "FAIL",
                    "message": "%s/ 가 VCS 무시 목록에 없다. 계약 파일이 추적되는 "
                               "orphan 이 되어 03 이 exit 8 로 죽는다."
                               % st.WORKSPACE_REL})

    # ② 역할 에이전트 정의. 계약 계층에서는 경고지만 여기서는 차단이다 —
    #    03 이 그 파일 없이 돌 수 없다.
    try:
        config = harness._read_json(root / harness.CONFIG_REL)
    except (OSError, ValueError):
        config = {}
    missing = [r_["agent"] for r_ in (config.get("roles") or [])
               if not (root / ".claude" / "agents" / ("%s.md" % r_.get("agent"))).exists()]
    if not config.get("roles"):
        out.append({"name": "역할 에이전트 정의", "status": "SKIP",
                    "message": "config 를 읽지 못했다"})
    elif missing:
        out.append({"name": "역할 에이전트 정의", "status": "FAIL",
                    "message": "없다: %s — 03-implement 가 호출할 대상이다"
                               % ", ".join(".claude/agents/%s.md" % m for m in missing)})
    else:
        out.append({"name": "역할 에이전트 정의", "status": "PASS"})

    # ③ 페이즈 파일. 깨진 채로 /feature 가 시작하면 런 중간에 알게 된다 (P5 의 일반형).
    phases_dir = root / PHASES_REL
    if not phases_dir.is_dir():
        out.append({"name": "페이즈 파일", "status": "FAIL",
                    "message": "%s/ 가 없다" % PHASES_REL})
    else:
        findings = lint_phases(root)
        bad = [f for f in findings if f["status"] == "FAIL"]
        out.append({"name": "페이즈 파일",
                    "status": "FAIL" if bad else "PASS",
                    "message": "; ".join("%s: %s" % (f["file"], f["message"])
                                         for f in bad[:3])})

    # ④ 계약 템플릿이 **자기 파서를 통과하는가.** 계약 계층의 "계약 절 ↔ 템플릿"
    #    은 절 제목 일치만 본다 — 템플릿이 시범 보이는 **형태**가 파서를 속이면
    #    첫 계약이 그 형태를 베끼고, 유닛이 부풀어 스코프 선택이 조용히 빗나간다.
    out.append(_check_template_parses(root, config))
    return out


def _check_template_parses(root, config):
    import contract as contract_mod
    name = "계약 템플릿 파싱"
    path = Path(root) / harness.CONTRACT_TEMPLATE_REL
    if not path.is_file() or not config:
        return {"name": name, "status": "SKIP",
                "message": "템플릿이나 config 를 읽지 못했다"}
    try:
        parsed = contract_mod.parse(path.read_text(encoding="utf-8"), config)
    except (OSError, ValueError) as exc:
        return {"name": name, "status": "FAIL", "message": "파싱 실패: %s" % exc}
    dropped = parsed.get("dropped") or []
    if dropped:
        return {"name": name, "status": "FAIL",
                "message": "템플릿이 자기 파서에 유닛 아닌 것 %d개를 낸다: %s — "
                           "첫 계약이 이 형태를 베끼면 유닛 수가 부풀어 프로파일 "
                           "판정과 스코프 선택이 함께 빗나간다."
                           % (len(dropped),
                              ", ".join(repr(d["raw"]) for d in dropped[:3]))}
    if not parsed.get("units"):
        return {"name": name, "status": "FAIL",
                "message": "템플릿의 유닛 절이 파서에 아무것도 내지 않는다 — "
                           "시범이 시범 노릇을 못 한다."}
    return {"name": name, "status": "PASS",
            "message": "유닛 %d개 · 버려진 것 0개" % len(parsed["units"])}


def _doctor_render(harness_data, pipeline, exit_):
    if exit_ == 0:
        return ("doctor 통과. 경고 %d건은 진행을 막지 않지만 전부 stderr 에 드러나 있다.\n"
                "`init --feature <slug> --request-file <경로>` 로 런을 시작한다."
                % harness_data["warnings"])
    lines = ["## doctor 미통과 — /feature 를 시작하지 않는다", ""]
    for c in harness_data["checks"]:
        if c["status"] == "FAIL":
            lines.append("- %s: %s" % (c["name"], c["message"]))
    for c in pipeline:
        if c["status"] == "FAIL":
            lines.append("- %s: %s" % (c["name"], c.get("message", "")))
    lines += ["", "설정과 실물이 어긋난 채로 시작하면 게이트가 한참 돌고 나서 드러난다.",
              "위 항목을 고친 뒤 다시 실행한다."]
    return "\n".join(lines)


# ----------------------------------------------------------------- lint-phases

def lint_phases(root, phases_dir=None):
    """페이즈 파일을 검증해 findings 를 낸다.

    이것이 CI 없이도 도는 유일한 검증 장치다. 여기서 못 잡으면 런 중간에
    알게 되고, 그때는 앞 페이즈에 쓴 시간이 이미 낭비된 뒤다.
    """
    root = Path(root)
    d = Path(phases_dir or (root / PHASES_REL))
    out = []

    def add(file, rule, status, message=""):
        out.append({"file": str(file), "rule": rule,
                    "status": status, "message": message})

    if not d.is_dir():
        add(PHASES_REL, "phases_dir", "FAIL", "페이즈 디렉터리가 없다")
        return out

    loaded, broken = load_phases(root, d)
    for path, msg in broken:
        add(path.name, "frontmatter", "FAIL", msg)
    if not loaded:
        if not broken:
            add(PHASES_REL, "phases_dir", "FAIL", "페이즈 파일이 없다")
        return out

    try:
        config, adapter, calibration = adapters.load(root)
    except (OSError, ValueError, KeyError) as exc:
        add(harness.CONFIG_REL, "config", "FAIL", "설정·어댑터를 읽지 못했다: %s" % exc)
        return out
    ctx = build_context(root, config=config, calibration=calibration)

    _lint_runner_bin(root, adapter, config, add)

    seen_index, seen_keys = {}, {}
    max_index = max((p["front"].get("index") or 0) for p in loaded.values())

    for pid, item in sorted(loaded.items()):
        front, path, sections = item["front"], item["path"], item["sections"]
        name = path.name

        # ── 신원
        if pid != path.stem:
            add(name, "id", "FAIL", "id(%r) 가 파일명(%r) 과 다르다" % (pid, path.stem))
        idx = front.get("index")
        if idx in seen_index:
            add(name, "index", "FAIL", "index %r 가 %s 와 겹친다" % (idx, seen_index[idx]))
        else:
            seen_index[idx] = pid
        unknown = [k for k in front if k not in FRONT_KEYS]
        if unknown:
            add(name, "front_keys", "FAIL", "알 수 없는 최상위 키: %s" % ", ".join(unknown))

        # ── 본문 섹션
        missing = [s for s in REQUIRED_SECTIONS if s not in sections]
        if front.get("allow", {}).get("agents") and ROLE_TEMPLATE_SECTION not in sections:
            missing.append(ROLE_TEMPLATE_SECTION)
        if missing:
            add(name, "sections", "FAIL", "필수 절이 없다: %s" % ", ".join(missing))

        # ── 게이트
        gate = front.get("gate") or {}
        runner = gate.get("runner")
        if runner not in ("adapter", "none"):
            add(name, "runner", "FAIL",
                "gate.runner 는 adapter 또는 none 이다 (받은 값: %r). "
                "페이즈 파일이 임의 명령 실행 벡터가 되지 않게 한다" % runner)
        for step in gate.get("steps") or []:
            sid = step.get("id")
            if sid not in (adapter.get("stages") or {}):
                add(name, "stage", "FAIL", "어댑터에 없는 스테이지 이름: %r" % sid)
            if "background" in step:
                _lint_background(name, step, ctx, add)

        # ── 어휘
        for req in front.get("requires") or []:
            if req.get("kind") not in REQUIRES_KINDS:
                add(name, "requires_kind", "FAIL",
                    "알 수 없는 requires kind: %r (%s)"
                    % (req.get("kind"), ", ".join(REQUIRES_KINDS)))
        for prod in front.get("produces") or []:
            if prod.get("kind") not in PRODUCES_KINDS:
                add(name, "produces_kind", "FAIL",
                    "알 수 없는 produces kind: %r (%s)"
                    % (prod.get("kind"), ", ".join(PRODUCES_KINDS)))
            key = prod.get("key")
            if key in seen_keys:
                add(name, "produces_key", "FAIL",
                    "produces.key %r 가 %s 와 겹친다" % (key, seen_keys[key]))
            else:
                seen_keys[key] = pid
        loop = front.get("loop") or {}
        if loop.get("counter") and loop["counter"] not in st.COUNTERS:
            add(name, "counter", "FAIL",
                "알 수 없는 카운터: %r (%s)" % (loop["counter"], ", ".join(st.COUNTERS)))

        # ── 플레이스홀더와 경로
        _lint_placeholders(name, front, ctx, add)
        _lint_paths(name, front, ctx, add)

        # ── 역할 에이전트 정의
        _lint_agents(root, name, front, config, add)

        # ── 전이
        nxt = front.get("on_success")
        if nxt and nxt not in loaded:
            nxt_idx = _index_prefix(nxt)
            if nxt_idx is not None and nxt_idx > max_index:
                add(name, "on_success", "WARN",
                    "%r 는 아직 없다 (FUTURE) — 그 페이즈가 생기면 이어진다" % nxt)
            else:
                add(name, "on_success", "FAIL", "전이 대상이 없다: %r" % nxt)

    _lint_cycle(loaded, add)
    _lint_taxonomy(root, add)
    return out


def _index_prefix(phase_id):
    head = (phase_id or "").split("-")[0]
    return int(head) if head.isdigit() else None


def _lint_runner_bin(root, adapter, config, add):
    """화이트리스트는 스키마의 enum 이다 — 실행기 코드에 목록을 두지 않는다."""
    try:
        schema = harness._read_json(root / harness.ADAPTER_SCHEMA_REL)
    except (OSError, ValueError):
        return
    allowed = (((schema.get("properties") or {}).get("runner") or {})
               .get("properties", {}).get("bin", {}).get("enum"))
    got = (adapter.get("runner") or {}).get("bin")
    if allowed and got not in allowed:
        add("harness/adapters/%s.json" % config.get("adapter"), "runner_bin", "FAIL",
            "runner.bin %r 이 화이트리스트 밖이다" % got)


def _lint_background(name, step, ctx, add):
    """참으로 해석되면 거부한다 — 조용히 동기로 낙하시키지 않는다.

    이 스켈레톤은 백그라운드 경로를 만들지 않았다. 없는 기계를 있는 척
    통과시키는 것이 이 문서군이 막으려는 실패다.
    """
    try:
        value = resolve(step["background"], ctx)
    except PlaceholderError as exc:
        add(name, "placeholder", "FAIL", str(exc))
        return
    if value:
        add(name, "background", "FAIL",
            "background 가 참으로 해석된다. 이 실행기는 동기 실행만 지원하므로 "
            "거부한다 — 조용히 동기로 돌리면 없는 기계를 통과시키는 것이다")


def _lint_placeholders(name, front, ctx, add):
    try:
        resolve({k: v for k, v in front.items() if k != "gate"}, ctx)
        for step in (front.get("gate") or {}).get("steps") or []:
            resolve({k: v for k, v in step.items() if k != "background"}, ctx)
    except PlaceholderError as exc:
        add(name, "placeholder", "FAIL", str(exc))


def _lint_paths(name, front, ctx, add):
    for prod in front.get("produces") or []:
        try:
            path = resolve(prod.get("path", ""), ctx)
        except PlaceholderError:
            continue                      # 위에서 이미 잡았다
        if len(str(path)) > harness.PATH_LIMIT:
            add(name, "path_length", "FAIL",
                "산출물 경로가 %d자로 상한 %d 를 넘는다: %s"
                % (len(str(path)), harness.PATH_LIMIT, path))


def _lint_agents(root, name, front, config, add):
    allow = (front.get("allow") or {}).get("agents")
    if allow != "config.roles[].agent":
        return
    for role in config.get("roles") or []:
        agent = role.get("agent")
        if not (root / ".claude" / "agents" / ("%s.md" % agent)).exists():
            add(name, "agent_file", "FAIL",
                ".claude/agents/%s.md 가 없다 — 기동 전에 잡는다" % agent)


def _lint_cycle(loaded, add):
    for pid in loaded:
        seen, cur = [], pid
        while cur in loaded:
            if cur in seen:
                add(loaded[pid]["path"].name, "cycle", "FAIL",
                    "전이가 순환한다: %s" % " → ".join(seen + [cur]))
                return
            seen.append(cur)
            cur = loaded[cur]["front"].get("on_success")


def _lint_taxonomy(root, add):
    """01~04 에는 소비자가 없다. **없는 검사를 통과로 세지 않는다.**"""
    path = Path(root) / TAXONOMY_REL
    if not path.exists():
        add(TAXONOMY_REL, "taxonomy", "SKIP",
            "원장이 아직 없다 — 05~08 이 생기면 검사한다")
        return
    try:
        data = harness._read_json(path)
    except (OSError, ValueError) as exc:
        add(TAXONOMY_REL, "taxonomy", "FAIL", "읽지 못했다: %s" % exc)
        return
    codes = [c.get("code") for c in data.get("codes") or []]
    if len(codes) != len(set(codes)):
        add(TAXONOMY_REL, "taxonomy", "FAIL", "코드가 유니크하지 않다")
    bad = [c for c in data.get("codes") or []
           if c.get("enforceable") not in ("lint", "check", "prose", None)]
    if bad:
        add(TAXONOMY_REL, "taxonomy", "FAIL",
            "enforceable 어휘 밖: %s" % ", ".join(c.get("code") for c in bad))


def cmd_lint_phases(root, args):
    findings = lint_phases(root, args.dir)
    bad = [f for f in findings if f["status"] == "FAIL"]
    exit_ = 2 if bad else 0
    for f in findings:
        warn("  %-4s %s — %s" % (f["status"], f["file"], f["message"]))
    render = ("페이즈 파일 검증 통과." if not bad else
              "## 페이즈 파일 거부\n\n" +
              "\n".join("- `%s` %s: %s" % (f["file"], f["rule"], f["message"])
                        for f in bad))
    return st.emit(st.envelope("lint-phases", exit_ == 0, exit_, None,
                               {"findings": findings}, render, None))


# ------------------------------------------------------------------------ init

def cmd_init(root, args):
    return st.emit(run_init(root, args.feature, args.request_file, args.profile))


def run_init(root, slug, request_file, profile=None):
    root = Path(root)
    if not slug or not harness.NAME_RE.match(slug):
        return st.envelope("init", False, 2, None, {"slug": slug},
                           "슬러그는 `^[a-z0-9][a-z0-9-]*$` 여야 한다: %r" % slug, None)
    req = Path(request_file)
    if not req.is_absolute():
        req = root / req
    if not req.exists():
        return st.envelope("init", False, 2, None, {"request_file": str(req)},
                           "요청 파일이 없다: %s" % request_file, None)
    paths, s = st.create_run(root, slug, req, profile=profile)
    data = {"run_id": s["run_id"], "run_dir": str(paths.run_dir),
            "request_sha256": s["request"]["sha256"],
            "profile": s["profile"]}
    render = ("런 `%s` 을 만들었다. 요청은 바이트 그대로 동결됐고 sha256 이 박혔다.\n"
              "`next` 로 첫 페이즈 지시문을 받는다." % s["run_id"])
    return st.envelope("init", True, 0, s, data, render,
                       "python scripts/pipeline/cli.py next --run-id %s" % s["run_id"])


# ------------------------------------------------------------------------ next

def cmd_next(root, args):
    return st.emit(run_next(root, args.run_id))


def run_next(root, run_id=None):
    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("next", False, 3, None, {},
                           "런이 없다. `init --feature <slug> --request-file <경로>` 로 시작한다.",
                           None)
    if s.get("escalated"):
        return _escalation_envelope("next", paths, s)

    pid = s.get("phase")
    loaded, _broken = load_phases(root)
    phase = loaded.get(pid)
    if phase is None:
        return st.envelope("next", True, 11, s, {"phase": pid},
                           _horizon_render(pid), None)

    ctx = build_context(root, paths, s)
    checks = check_requires(root, phase["front"].get("requires"), ctx, s)
    failed = [c for c in checks if not c["ok"]]
    if failed:
        return st.envelope(
            "next", False, 3, s, {"requires_report": checks},
            "## %s 진입 거부\n\n선행 조건이 채워지지 않았다.\n\n%s"
            % (pid, "\n".join("- %s" % c["message"] for c in failed)),
            None)

    st.set_phase_status(s, pid, "running")
    st.append_event(paths, "phase_enter", cmd="next", phase=pid)
    st.save(paths, s)

    render, next_cmd = render_packet(root, phase, ctx, s, checks)
    return st.envelope("next", True, 0, s,
                       {"produces": [resolve(p.get("path"), ctx)
                                     for p in phase["front"].get("produces") or []],
                        "requires_report": checks,
                        "prescan": _prescan(root, loaded, ctx, s) if pid == "01-plan" else []},
                       render, next_cmd)


def render_packet(root, phase, ctx, s, checks=None):
    front, body = phase["front"], phase["body"]
    pid = front["id"]
    parts = [render_header(ctx["config"], s), ""]
    parts.append(_section(body, "## 목적"))
    parts.append(_section(body, "## 절차"))
    role_tpl = _section(body, "## 역할 프롬프트 템플릿")
    if role_tpl:
        parts.append(role_tpl)
    parts.append(_section(body, "## 제출 형식"))
    parts.append(_section(body, "## 금지"))

    produces = [resolve(p.get("path"), ctx) for p in front.get("produces") or []]
    if produces:
        parts.append("## 쓸 파일\n\n" +
                     "\n".join("- `%s`" % p for p in produces))
    warns = [c for c in (checks or []) if c.get("warn")]
    if warns:
        parts.append("## 경고\n\n" + "\n".join("- %s" % c["message"] for c in warns))

    if (front.get("gate") or {}).get("runner") == "adapter" and pid == "04-gate":
        cmd = "python scripts/pipeline/cli.py gate --phase 04 --run-id %s" % s["run_id"]
    else:
        cmd = ("python scripts/pipeline/cli.py record --phase %s --file <산출물> "
               "--run-id %s" % (pid.split("-")[0], s["run_id"]))
    return "\n\n".join(p for p in parts if p), cmd


def render_header(config, s):
    """300자 이내. 넘으면 INV → 소유권 → 예산 → 금지 순으로 자른다."""
    bits = []
    counters = s.get("counters") or {}
    used = ", ".join("%s %d/%s" % (k, v.get("used", 0), v.get("max"))
                     for k, v in sorted(counters.items()))
    bits.append("런 `%s` · 페이즈 **%s**" % (s.get("run_id"), s.get("phase")))
    roles = ", ".join("%s→%s" % (r["id"], r["agent"]) for r in config.get("roles") or [])
    if roles:
        bits.append("역할: %s" % roles)
    if used:
        bits.append("카운터: %s" % used)
    budget = (s.get("budget") or {}).get("model_calls") or {}
    if budget.get("max"):
        bits.append("모델 호출 %s/%s(제출 기준 근사)"
                    % (budget.get("total"), budget["max"]))
    out = " · ".join(bits)
    while len(out) > 300 and len(bits) > 1:
        bits.pop()
        out = " · ".join(bits)
    return out


def _section(body, heading):
    lines = body.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.strip() == heading)
    except StopIteration:
        return ""
    out = [lines[start]]
    for line in lines[start + 1:]:
        if line.startswith("## "):
            break
        out.append(line)
    return "\n".join(out).rstrip()


def _prescan(root, loaded, ctx, s):
    """런 전체의 requires 를 미리 훑는다 — 뒤 페이즈에서 막히면 앞이 낭비다.

    **예측이지 보장이 아니다.** 앞선 페이즈가 파일을 고치므로 여기서 통과한
    것이 나중에 실패할 수 있다. 그래서 경고로만 내고, 각 페이즈 진입 시 다시
    강제한다 — 둘 다 필요하다.
    """
    out = []
    for pid, item in sorted(loaded.items()):
        if pid == s.get("phase"):
            continue
        for req in item["front"].get("requires") or []:
            if req.get("kind") != "adapter_stage":
                continue          # 파일·상태는 아직 없는 것이 정상이다
            got = check_requires(root, [req], ctx, s)[0]
            if not got["ok"] or got.get("warn"):
                out.append({"phase": pid, "message": got["message"]})
    return out


def _horizon_render(pid):
    return ("## 01~04 까지가 이 실행기의 범위다\n\n"
            "다음 페이즈 `%s` 는 아직 구현되지 않았다.\n"
            "**PR 을 만들지 않았고 push 하지 않았다.** 코드는 워킹트리에 있다.\n"
            "`status` 로 이 런의 등급과 남은 gap 을 본다." % pid)


def _escalation_envelope(cmd, paths, s):
    esc = s.get("escalation") or {}
    lines = ["## 에스컬레이션 — 사람의 판단이 필요하다", "", esc.get("reason", "")]
    if esc.get("options"):
        lines += [""] + ["%d. %s" % (i + 1, o) for i, o in enumerate(esc["options"])]
    lines += ["", "`%s` 에 전문이 있다." % paths.escalation.name]
    return st.envelope(cmd, False, 10, s, {"escalation": esc}, "\n".join(lines),
                       "python scripts/pipeline/cli.py resume --ack --answer-file <경로>")


# ---------------------------------------------------------------------- record

def cmd_record(root, args):
    return st.emit(run_record(root, args.phase, args.file, args.reviewer,
                              args.round, args.run_id))


def run_record(root, phase, file, reviewer=None, round_=None, run_id=None):
    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("record", False, 3, None, {}, "런이 없다.", None)
    if s.get("escalated"):
        return _escalation_envelope("record", paths, s)

    loaded, _broken = load_phases(root)
    pid = _normalize_phase(phase, loaded)
    if pid is None:
        return st.envelope("record", False, 2, s, {"phase": phase},
                           "알 수 없는 페이즈: %r" % phase, None)

    if st.phase_status(s, pid) == "passed":
        return st.envelope(
            "record", False, 3, s, {"phase": pid},
            "`%s` 는 이미 통과했다. **record 는 멱등이 아니다** — 재작업은 "
            "`retry --phase %s --counter <이름> --reason <사유>` 로만 한다."
            % (pid, pid.split("-")[0]), None)

    phase_item = loaded[pid]
    ctx = build_context(root, paths, s)
    checks = check_requires(root, phase_item["front"].get("requires"), ctx, s)
    failed = [c for c in checks if not c["ok"]]
    if failed:
        return st.envelope("record", False, 3, s, {"requires_report": checks},
                           "## 선행 조건 미충족\n\n" +
                           "\n".join("- %s" % c["message"] for c in failed), None)

    st.append_event(paths, "submit_received", cmd="record", phase=pid,
                    file=paths.rel(file), reviewer=reviewer)
    handler = _RECORD_HANDLERS.get(pid)
    if handler is None:
        return st.envelope("record", False, 2, s, {"phase": pid},
                           "`%s` 의 제출 처리는 아직 구현되지 않았다." % pid, None)
    exhausted = _count_model_calls(paths, s, phase_item, ctx, reviewer)
    env = handler(root, paths, s, phase_item, ctx, Path(file), reviewer, round_)
    return _budget_stop(paths, env) if exhausted else env


def _count_model_calls(paths, s, phase_item, ctx, reviewer):
    """이 제출이 태운 모델 호출을 센다. 반환: 예산이 소진됐는가.

    메인이 쓴 산출물(`reviewer` 가 없는 제출)은 서브에이전트 호출이 아니므로
    세지 않는다. 역할 병렬 페이즈는 제출 하나가 역할 수만큼의 호출을 뜻한다.
    """
    front = phase_item["front"]
    if reviewer:
        n = 1
    elif (front.get("allow") or {}).get("parallel"):
        n = len(ctx["config"].get("roles") or [])
    else:
        n = 0
    if not n:
        return False
    _total, _max, exhausted = st.bump_model_calls(s, front["id"], n)
    st.save(paths, s)
    return exhausted


def _budget_stop(paths, env):
    """제출은 살리고 다음 호출만 막는다 — exit 5 는 소진이지 거부가 아니다."""
    if not env.get("ok") or env.get("exit") not in (0, 11):
        return env
    env["ok"] = False
    env["exit"] = 5
    env["next_command"] = None
    env["render"] = (
        "## 모델 호출 예산이 소진됐다\n\n"
        "이번 제출은 기록됐다. 다음 호출을 요구하지 않고 여기서 멈춘다.\n"
        "계속하려면 사람이 `budget.model_calls_max` 를 올리거나 범위를 줄인다.\n\n"
        "직전 지시문:\n\n%s" % env.get("render", ""))
    st.append_event(paths, "check_fail", cmd="record", exit=5,
                    reason="model_call_budget")
    return env


def _normalize_phase(phase, loaded):
    """`04` 와 `04-gate` 를 둘 다 받는다."""
    if phase in loaded:
        return phase
    for pid in loaded:
        if pid.split("-")[0] == str(phase).zfill(2):
            return pid
    return None


def _advance_to_next(root, paths, s, phase_item, ctx, cmd="record"):
    """통과 시 전이하고 **다음 페이즈 지시문을 바로 낸다** (왕복 절약)."""
    pid = phase_item["front"]["id"]
    st.set_phase_status(s, pid, "passed")
    st.append_event(paths, "phase_pass", cmd=cmd, phase=pid)
    nxt = phase_item["front"].get("on_success")
    s["phase"] = nxt
    st.save(paths, s)

    loaded, _ = load_phases(root)
    if nxt not in loaded:
        st.append_event(paths, "horizon", cmd=cmd, phase=nxt)
        return st.envelope(cmd, True, 11, s, {"next_phase": nxt},
                           _horizon_render(nxt), None)
    nxt_item = loaded[nxt]
    nxt_checks = check_requires(root, nxt_item["front"].get("requires"), ctx, s)
    if [c for c in nxt_checks if not c["ok"]]:
        return st.envelope(cmd, True, 0, s, {"next_phase": nxt,
                                             "requires_report": nxt_checks},
                           "`%s` 통과. 다음은 `%s` 이고 아직 선행 조건이 남았다:\n\n%s"
                           % (pid, nxt,
                              "\n".join("- %s" % c["message"]
                                        for c in nxt_checks if not c["ok"])),
                           "python scripts/pipeline/cli.py next --run-id %s" % s["run_id"])
    st.set_phase_status(s, nxt, "running")
    st.append_event(paths, "phase_enter", cmd=cmd, phase=nxt)
    st.save(paths, s)
    render, next_cmd = render_packet(root, nxt_item, ctx, s, nxt_checks)
    return st.envelope(cmd, True, 0, s, {"next_phase": nxt}, render, next_cmd)


# ------------------------------------------------------- 01 제출 처리

def _record_01(root, paths, s, phase_item, ctx, file, reviewer, round_):
    if reviewer:
        return _record_01_review(root, paths, s, phase_item, ctx, file,
                                 reviewer, round_ or 1)
    return _record_01_plan(root, paths, s, phase_item, ctx, file)


def _record_01_plan(root, paths, s, phase_item, ctx, file):
    if not file.exists():
        return st.envelope("record", False, 3, s, {}, "산출물이 없다: %s" % file, None)
    text = file.read_text(encoding="utf-8")
    request_text = paths.request.read_text(encoding="utf-8")
    limit = ((ctx["config"].get("profile") or {}).get("inv_skip_below_chars") or 0)

    got = verdict.check_plan(text, request_text, limit)
    node = s.setdefault("phases", {}).setdefault("01-plan", {})
    node["drift_score"] = got["drift_score"]
    if got.get("inv_skipped"):
        s.setdefault("profile", {})["inv_skipped"] = True

    if not got["ok"]:
        st.set_phase_status(s, "01-plan", "failed")
        st.append_event(paths, "check_fail", cmd="record", phase="01-plan",
                        exit=got["exit"], errors=len(got["errors"]))
        st.save(paths, s)
        return st.envelope("record", False, got["exit"], s,
                           {"errors": got["errors"], "drift_score": got["drift_score"],
                            "drift": got["drift"]},
                           _plan_fail_render(got), _same_command(s, "01"))

    node["plan_accepted"] = True
    st.set_phase_status(s, "01-plan", "running")   # node 는 상태 안의 같은 dict 다
    st.save(paths, s)
    reviewers = ((phase_item["front"].get("review") or {}).get("reviewers") or [])
    codes = [r["code"] for r in reviewers]
    return st.envelope(
        "record", True, 0, s,
        {"drift_score": 0, "round": _round_no(s), "reviewers": codes},
        "## 플랜이 받아들여졌다\n\n인용 검증과 커버리지가 통과했고 드리프트가 0 이다.\n"
        "이제 **리뷰어 둘을 병렬로** 돌린다 (`%s`). 회차마다 원문 `.raw.md` 와 "
        "구조화 `.json` 을 함께 낸다." % "`, `".join(codes),
        "python scripts/pipeline/cli.py record --phase 01 --file <리뷰 json> "
        "--reviewer <code> --round %d --run-id %s" % (_round_no(s), s["run_id"]))


def _plan_fail_render(got):
    if got["exit"] == 4:
        lines = ["## 드리프트 — 의도가 새어 나갔다", ""]
        for d in got["drift"]:
            lines.append("- `%s` (%s): %s — 사유: %s"
                         % (d["id"], d.get("kind"), d["status"], d["reason"]))
        lines += ["", "덮거나, 사용자 승인을 받아야 넘어간다. 예산은 남아 있다."]
        return "\n".join(lines)
    return ("## 제출물 거부\n\n" +
            "\n".join("- %s" % e for e in got["errors"]))


def _round_no(s):
    return ((s.get("counters") or {}).get("round") or {}).get("used", 0) + 1


def _record_01_review(root, paths, s, phase_item, ctx, file, reviewer, round_):
    node = s.setdefault("phases", {}).setdefault("01-plan", {})
    if not node.get("plan_accepted"):
        return st.envelope("record", False, 3, s, {},
                           "플랜이 먼저다. `record --phase 01 --file <01_plan.md>`", None)
    if not file.exists():
        return st.envelope("record", False, 3, s, {}, "산출물이 없다: %s" % file, None)
    try:
        payload = harness._read_json(file)
    except (OSError, ValueError) as exc:
        return st.envelope("record", False, 8, s, {}, "JSON 을 읽지 못했다: %s" % exc, None)

    raw_path = file.with_name(file.name.replace(".json", ".raw.md"))
    if not raw_path.exists():
        return st.envelope("record", False, 8, s, {},
                           "리뷰어 원문이 없다: %s — 구조화 JSON 만으로는 "
                           "quote 를 검증할 수 없다" % raw_path.name, None)
    raw_text = raw_path.read_text(encoding="utf-8")

    rounds = node.setdefault("rounds", {})
    prev_open = _previous_open(rounds, round_)
    got = verdict.check_review(payload, raw_text, prev_open)
    if not got["ok"]:
        st.append_event(paths, "check_fail", cmd="record", phase="01-plan",
                        reviewer=reviewer, errors=len(got["errors"]))
        st.save(paths, s)
        return st.envelope("record", False, 8, s, {"errors": got["errors"]},
                           "## 리뷰 제출 거부\n\n" +
                           "\n".join("- %s" % e for e in got["errors"]),
                           _same_command(s, "01"))

    slot = rounds.setdefault(str(round_), {})
    slot[reviewer] = {"mode": payload.get("mode") or "primary",
                      "keys": got["keys"], "blocking": got["blocking"]}
    st.save(paths, s)

    expected = [r["code"] for r in
                ((phase_item["front"].get("review") or {}).get("reviewers") or [])]
    missing = [c for c in expected if c not in slot]
    if missing:
        return st.envelope("record", True, 0, s,
                           {"round": round_, "waiting_for": missing},
                           "`%s` 리뷰를 받았다. 아직 `%s` 가 남았다."
                           % (reviewer, "`, `".join(missing)),
                           "python scripts/pipeline/cli.py record --phase 01 "
                           "--file <리뷰 json> --reviewer %s --round %d --run-id %s"
                           % (missing[0], round_, s["run_id"]))

    return _judge_round(root, paths, s, phase_item, ctx, round_, slot, rounds)


def _previous_open(rounds, round_):
    """이전 회차들에서 열려 있던 지적. 사라지면 단조성 검사가 잡는다."""
    out, seen = [], set()
    for rn in sorted(rounds, key=int):
        if int(rn) >= round_:
            continue
        for sub in rounds[rn].values():
            for k in sub.get("keys") or []:
                if k["key"] not in seen:
                    seen.add(k["key"])
                    out.append(k)
    return out


def _judge_round(root, paths, s, phase_item, ctx, round_, slot, rounds):
    subs = [dict(v, code=k) for k, v in slot.items()]
    prev_keys = {k["key"] for r in rounds for sub in rounds[r].values()
                 for k in sub.get("keys") or [] if int(r) < round_}
    drift = (s["phases"]["01-plan"] or {}).get("drift_score") or 0
    ok, reason = verdict.converged(round_, subs, prev_keys, drift)

    conv = phase_item["front"].get("converge") or {}
    profile = (s.get("profile") or {}).get("name") or "normal"
    max_rounds = (conv.get("max_by_profile") or {}).get(profile) or 5

    if ok:
        s["phases"]["01-plan"]["rounds"] = round_
        st.counter_inc(s, "round", max_rounds)
        return _advance_to_next(root, paths, s, phase_item, ctx)

    used, _max, exceeded = st.counter_inc(s, "round", max_rounds)
    if exceeded:
        st.escalate(paths, s,
                    "01 이 %d라운드 안에 수렴하지 않았다: %s" % (max_rounds, reason),
                    ["이대로 진행한다(미해결 지적을 안고 간다)",
                     "범위를 줄여 플랜을 다시 쓴다", "중단한다"],
                    phase="01-plan")
        return _escalation_envelope("record", paths, s)

    st.save(paths, s)
    focus = conv.get("focus_round_2") or ""
    return st.envelope(
        "record", True, 0, s, {"round": used + 1, "reason": reason},
        "## %d라운드가 필요하다\n\n%s\n\n다음 회차의 강제 초점: %s\n\n"
        "플랜은 **부분 편집**으로 고친다 — 전체를 다시 쓰면 접두부가 라운드마다 쌓인다."
        % (used + 1, reason, focus or "(없음)"),
        "python scripts/pipeline/cli.py record --phase 01 --file <리뷰 json> "
        "--reviewer <code> --round %d --run-id %s" % (used + 1, s["run_id"]))


def _same_command(s, phase):
    return ("python scripts/pipeline/cli.py record --phase %s --file <산출물> "
            "--run-id %s" % (phase, s["run_id"]))


# ------------------------------------------------------- 02 제출 처리

def _record_02(root, paths, s, phase_item, ctx, file, reviewer, round_):
    front = phase_item["front"]
    if front.get("skip_when") and verdict and eval_condition(front["skip_when"], s):
        on_skip = front.get("on_skip") or {}
        st.set_phase_status(s, "02-cross-verify", on_skip.get("status") or "skipped")
        gap = on_skip.get("gap")
        if gap and gap not in s.setdefault("gaps", []):
            s["gaps"].append(gap)
        s["grade"] = on_skip.get("grade") or st.GRADES[1]
        st.append_event(paths, "phase_skip", cmd="record", phase="02-cross-verify",
                        gap=gap)
        st.save(paths, s)
        return _advance_to_next(root, paths, s, phase_item, ctx)

    if not file.exists():
        return st.envelope("record", False, 3, s, {}, "산출물이 없다: %s" % file, None)
    try:
        payload = harness._read_json(file)
    except (OSError, ValueError) as exc:
        return st.envelope("record", False, 8, s, {}, "JSON 을 읽지 못했다: %s" % exc, None)

    errors = []
    if payload.get("reviewer") == "main":
        errors.append("reviewer 가 main 이다 — 독립 관측이 아니다")
    plan_text = (paths.run_dir / "01_plan.md").read_text(encoding="utf-8")
    for f in payload.get("findings") or []:
        q = f.get("quote")
        if q and verdict.normalize_ws(q) not in verdict.normalize_ws(plan_text):
            errors.append("%s 의 quote 가 플랜 원문에 없다" % f.get("id"))
        if f.get("severity") in verdict.BLOCKING and not _has_adoption(payload, f):
            errors.append("%s 에 대한 채택 판정(adopted)이 없다" % f.get("id"))
    if errors:
        st.append_event(paths, "check_fail", cmd="record", phase="02-cross-verify",
                        errors=len(errors))
        st.save(paths, s)
        return st.envelope("record", False, 8, s, {"errors": errors},
                           "## 제출물 거부\n\n" + "\n".join("- %s" % e for e in errors),
                           _same_command(s, "02"))

    critical = [f for f in payload.get("findings") or []
                if f.get("severity") == "critical" and _accepted(payload, f)]
    s["cross_verify"] = dict(s.get("cross_verify") or {},
                             mode=payload.get("mode") or "primary")
    if critical:
        used, max_, exceeded = st.counter_inc(s, "xverify_return", 1)
        if exceeded and used > 1:
            st.escalate(paths, s, "02 가 두 번째로 Critical 을 냈다",
                        ["이대로 진행한다", "범위를 줄인다", "중단한다"],
                        phase="02-cross-verify")
            return _escalation_envelope("record", paths, s)
        st.set_phase_status(s, "01-plan", "failed")
        st.set_phase_status(s, "02-cross-verify", "failed")
        s["phase"] = "01-plan"
        st.save(paths, s)
        return st.envelope(
            "record", False, 4, s, {"critical": len(critical)},
            "## Critical 이 남았다 — 01 로 되돌린다\n\n%s\n\n왕복은 1회다."
            % "\n".join("- %s: %s" % (f.get("id"), f.get("title"))
                        for f in critical),
            "python scripts/pipeline/cli.py next --run-id %s" % s["run_id"])

    return _advance_to_next(root, paths, s, phase_item, ctx)


def _has_adoption(payload, finding):
    return any(a.get("id") == finding.get("id")
               for a in payload.get("adopted") or [])


def _accepted(payload, finding):
    for a in payload.get("adopted") or []:
        if a.get("id") == finding.get("id"):
            return a.get("verdict") != "reject"
    return True


# ------------------------------------------------------- 03 제출 처리

def _record_03(root, paths, s, phase_item, ctx, file, reviewer, round_):
    import attribution
    import contract as contract_mod

    if not file.exists():
        return st.envelope("record", False, 3, s, {}, "산출물이 없다: %s" % file, None)
    try:
        claims = harness._read_json(file)
    except (OSError, ValueError) as exc:
        return st.envelope("record", False, 8, s, {}, "JSON 을 읽지 못했다: %s" % exc, None)

    contract_path = resolve("${run.contract_file}", ctx)
    full = root / contract_path
    if full.exists():
        s["contract"] = dict(s.get("contract") or {}, present=True,
                             path=contract_path,
                             sha256=_sha256(full))
        parsed = contract_mod.parse(full.read_text(encoding="utf-8"), ctx["config"])
        s["profile"] = _confirm_profile(s, ctx["config"], parsed)

    got = attribution.clean_ownership(root, ctx["config"], claims)
    if not got["ok"]:
        st.set_phase_status(s, "03-implement", "failed")
        st.append_event(paths, "check_fail", cmd="record", phase="03-implement",
                        findings=len(got["findings"]))
        st.save(paths, s)
        return st.envelope(
            "record", False, 8, s,
            {"findings": got["findings"], "rollback": got["rollback"]},
            "## 소유 경계 위반\n\n%s\n\n되돌릴 것:\n%s"
            % ("\n".join("- `%s` — %s" % (f["path"], f["message"])
                         for f in got["findings"]),
               "\n".join("- `%s` → %s" % (r["path"], r["by"])
                         for r in got["rollback"]) or "- (없음)"),
            _same_command(s, "03"))

    _config, adapter, calibration = adapters.load(root)
    if adapters.stage_state(adapter, "compile") == "present":
        log = paths.gates / "03_compile.log"
        result = adapters.run_stage(root, adapter, "compile", log_path=log,
                                    calibration=calibration)
        st.append_event(paths, "stage_done", cmd="record", phase="03-implement",
                        stage="compile", exit=result.get("exit"))
        if result.get("exit"):
            st.set_phase_status(s, "03-implement", "failed")
            st.save(paths, s)
            return st.envelope(
                "record", False, 4, s, {"stage": result},
                "## 컴파일 실패\n\n```\n%s\n```" % (result.get("output") or "")[:2000],
                _same_command(s, "03"))

    st.set_phase_status(s, "03-implement", "passed",
                        claims=file.name)
    return _advance_to_next(root, paths, s, phase_item, ctx)


def _confirm_profile(s, config, parsed):
    """계약이 생겼으니 프로파일을 실제로 센다."""
    n = len(parsed.get("units") or []) + len(parsed.get("entrypoints") or [])
    limit = (config.get("profile") or {}).get("small_max_units") or 3
    if (s.get("profile") or {}).get("source") == "user":
        return s["profile"]
    return {"name": "small" if n <= limit else "normal", "source": "auto",
            "units": len(parsed.get("units") or []),
            "entrypoints": len(parsed.get("entrypoints") or [])}


def _sha256(path):
    import hashlib
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


_RECORD_HANDLERS = {"01-plan": _record_01, "02-cross-verify": _record_02,
                    "03-implement": _record_03}


# ------------------------------------------------------------------------ gate

def cmd_gate(root, args):
    return st.emit(run_gate_cmd(root, args.phase, args.stage, args.replay,
                                args.run_id))


def run_gate_cmd(root, phase="04", only_stage=None, replay=None, run_id=None):
    import gate as gate_mod

    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("gate", False, 3, None, {}, "런이 없다.", None)
    if s.get("escalated"):
        return _escalation_envelope("gate", paths, s)

    loaded, _broken = load_phases(root)
    pid = _normalize_phase(phase, loaded)
    if pid is None:
        return st.envelope("gate", False, 2, s, {}, "알 수 없는 페이즈: %r" % phase, None)
    phase_item = loaded[pid]
    ctx = build_context(root, paths, s)

    if not only_stage:
        checks = check_requires(root, phase_item["front"].get("requires"), ctx, s)
        failed = [c for c in checks if not c["ok"]]
        if failed:
            return st.envelope("gate", False, 3, s, {"requires_report": checks},
                               "## 게이트 진입 거부\n\n" +
                               "\n".join("- %s" % c["message"] for c in failed), None)

    config, adapter, calibration = adapters.load(root)
    round_no = ((s.get("counters") or {}).get("repair") or {}).get("used", 0) + 1
    log_path = paths.gates / ("gr-%d.stdout.log" % round_no)

    st.append_event(paths, "stage_start", cmd="gate", phase=pid, round=round_no)
    report = gate_mod.run_gate(root, config, adapter, calibration, s,
                               phase_item["front"], paths.run_dir,
                               only_stage=only_stage, replay=replay,
                               log_path=log_path)
    report["at"] = st.stamp()
    report["run_id"] = s["run_id"]
    report["round"] = round_no
    report["log"] = paths.rel(log_path)

    if only_stage:
        # 단일 스테이지는 카운터를 소모하지 않고 리포트를 덮어쓰지 않는다.
        stage = report["stages"][0] if report["stages"] else {}
        ok = stage.get("state") != "ran" or stage.get("exit") == 0
        return st.envelope("gate", ok, 0 if ok else 4, s, {"stage": stage},
                           _stage_render(stage), None)

    _write_json(paths.run_dir / "04_gate_report.json", report)

    log_text = ""
    if log_path.exists():
        log_text = log_path.read_text(encoding="utf-8", errors="replace")
    dispatch = gate_mod.attribute(root, config, adapter, report, s,
                                  replay=replay, log_text=log_text)

    if report.get("tests"):
        s["tests"] = report["tests"]
    for gap in report.get("gaps") or []:
        if gap not in s.setdefault("gaps", []):
            s["gaps"].append(gap)

    if dispatch is None:
        shrank = (report.get("tests") or {}).get("status") == "shrank"
        if shrank:
            return _gate_fail(root, paths, s, phase_item, ctx, report,
                              {"owner": None, "stuck": False,
                               "reason": "테스트 수가 하한 아래로 떨어졌다"},
                              round_no)
        s["grade"] = report.get("grade") or st.GRADES[1]
        s["fingerprint"] = st.fingerprint(root, config)
        # 실패가 없어도 회차를 남긴다 — "귀속을 안 했다"와 "귀속할 실패가
        # 없었다"는 다른 사실이고, 빈 파일이 후자를 말한다.
        _write_attribution(paths, report,
                           {"by_owner": {}, "failures": [], "deferred": [],
                            "owner": None, "stuck": False}, round_no)
        st.append_event(paths, "stage_done", cmd="gate", phase=pid,
                        grade=s["grade"])
        st.save(paths, s)
        return _advance_to_next(root, paths, s, phase_item, ctx, cmd="gate")

    return _gate_fail(root, paths, s, phase_item, ctx, report, dispatch, round_no)


def _gate_fail(root, paths, s, phase_item, ctx, report, dispatch, round_no):
    import gate as gate_mod   # noqa: F401  — 대칭을 위해 남긴다

    _write_attribution(paths, report, dispatch, round_no)
    st.append_event(paths, "attribution", cmd="gate", phase="04-gate",
                    owner=dispatch.get("owner"), stuck=dispatch.get("stuck"))

    if dispatch.get("owner") == "infra":
        # **카운터를 소모하지 않는다.** 외부 의존 미기동이 구현 역할의 실패로
        # 오분류되면 예산을 태운다.
        st.escalate(paths, s,
                    "외부 의존 실패로 보인다 (패턴: %s)" % dispatch.get("infra"),
                    ["의존을 띄우고 `gate` 를 다시 돌린다",
                     "이 스테이지를 건너뛰고 진행한다(등급에 남는다)", "중단한다"],
                    phase="04-gate")
        return _escalation_envelope("gate", paths, s)

    if dispatch.get("stuck"):
        st.escalate(paths, s,
                    "동일 실패 시그니처가 연속 2회다 — 예산이 남아도 멈춘다",
                    ["계약을 고쳐 다시 돌린다", "범위를 줄인다", "중단한다"],
                    phase="04-gate")
        return _escalation_envelope("gate", paths, s)

    loop = phase_item["front"].get("loop") or {}
    used, max_, exceeded = st.counter_inc(s, loop.get("counter") or "repair",
                                          loop.get("max") or 3)
    s.setdefault("sig_chain", []).extend(dispatch.get("sigs") or [])
    st.set_phase_status(s, "04-gate", "failed")
    st.save(paths, s)

    if exceeded:
        st.escalate(paths, s, "수리 예산 %d회를 소진했다" % max_,
                    ["계약을 고쳐 다시 돌린다", "범위를 줄인다", "중단한다"],
                    phase="04-gate")
        return st.envelope("gate", False, 5, s, {"report": report["gaps"]},
                           "## 예산 소진 — 에스컬레이션\n\n`ESCALATION.md` 를 본다.",
                           "python scripts/pipeline/cli.py resume --ack "
                           "--answer-file <경로>")

    brief = _dispatch_brief(dispatch, paths, round_no)
    st.append_event(paths, "dispatch", cmd="gate", phase="04-gate",
                    owner=dispatch.get("owner"))
    return st.envelope("gate", False, 4, s,
                       {"repair_dispatch": brief, "gaps": report.get("gaps")},
                       _repair_render(dispatch, brief),
                       "python scripts/pipeline/cli.py gate --phase 04 --run-id %s"
                       % s["run_id"])


def _write_attribution(paths, report, dispatch, round_no):
    path = paths.run_dir / "attribution.json"
    data = {"schema": 1, "run_id": report.get("run_id"), "rounds": []}
    if path.exists():
        try:
            data = harness._read_json(path)
        except (OSError, ValueError):
            pass
    data.setdefault("rounds", []).append({
        "round": round_no,
        "stage": (report.get("failed") or {}).get("id"),
        "stage_exit": (report.get("failed") or {}).get("exit"),
        "failures": dispatch.get("failures") or [],
        "by_owner": {k: [f["id"] for f in v]
                     for k, v in (dispatch.get("by_owner") or {}).items()},
        "infra": dispatch.get("owner") == "infra",
        "deferred": dispatch.get("deferred") or [],
        "rules_inactive": report.get("rules_inactive") or [],
    })
    _write_json(path, data)
    _write_json(paths.gates / ("gr-%d.dispatch.json" % round_no), dispatch)


def _dispatch_brief(dispatch, paths, round_no):
    """봉투에는 **실패당 60줄 상한**의 브리프만. 전문은 파일에 있다."""
    owner = dispatch.get("owner")
    items = (dispatch.get("by_owner") or {}).get(owner) or []
    brief = []
    for f in items:
        lines = (f.get("message") or "").splitlines()[:60]
        brief.append({"id": f.get("id"), "unit": f.get("unit"),
                      "file": f.get("file"), "frames": f.get("frames"),
                      "lines": lines})
    return {"round": round_no, "owner": owner,
            "reason": (items[0].get("owner_reason") if items else None),
            "failure_count": len(items),
            "file": "gates/gr-%d.dispatch.json" % round_no,
            "brief": brief, "deferred": dispatch.get("deferred") or []}


def _repair_render(dispatch, brief):
    lines = ["## 04 게이트 실패 — 수리 지시", "",
             "**`%s` 에게만** 보낸다. 배정 근거: %s"
             % (brief["owner"], brief.get("reason") or "-"), ""]
    for f in brief["brief"]:
        lines.append("- `%s` %s" % (f["id"], f.get("unit") or ""))
        if f.get("file"):
            lines.append("  - 파일: `%s`" % f["file"])
        for l in (f.get("lines") or [])[:6]:
            lines.append("  - %s" % l)
    if brief.get("deferred"):
        lines += ["", "미룬 것 (동시 배정 금지):"]
        lines += ["- %s (%d건) — %s" % (d["owner"], d["failure_count"], d["reason"])
                  for d in brief["deferred"]]
    lines += ["", "**실패를 다시 분류하지 마라.** 배정은 끝났다.",
              "고친 뒤 `gate` 를 다시 돌린다."]
    return "\n".join(lines)


def _stage_render(stage):
    if stage.get("state") == "skipped":
        return "`%s` 는 %s — 없는 것이지 통과한 것이 아니다." % (stage["id"],
                                                                stage["reason"])
    return "`%s` exit %s (%ss)" % (stage["id"], stage.get("exit"), stage.get("sec"))


def _write_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                          encoding="utf-8")


# ---------------------------------------------- advance · retry · escalate · resume

def cmd_advance(root, args):
    return st.emit(run_advance(root, args.phase, args.run_id))


def run_advance(root, phase, run_id=None):
    """명시 전이. **산출물 신선도 + 워크트리 지문**을 대조한다.

    게이트 통과 후 소스가 바뀌면 영수증이 stale 이다 — "통과한 셈 치고 넘어가기"의
    구조적 차단이고, 막히는 것이 정상 동작이다.
    """
    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("advance", False, 3, None, {}, "런이 없다.", None)
    loaded, _ = load_phases(root)
    pid = _normalize_phase(phase, loaded)
    if pid is None:
        return st.envelope("advance", False, 2, s, {}, "알 수 없는 페이즈: %r" % phase, None)

    ctx = build_context(root, paths, s)
    missing = []
    for prod in loaded[pid]["front"].get("produces") or []:
        if prod.get("unless") and eval_condition(prod["unless"], s):
            continue
        target = root / resolve(prod["path"], ctx)
        if not target.exists():
            missing.append(prod["path"])
    if missing:
        return st.envelope("advance", False, 6, s, {"missing": missing},
                           "## 전이 거부 — 산출물이 없다\n\n" +
                           "\n".join("- `%s`" % m for m in missing), None)

    saved = s.get("fingerprint")
    fresh = st.fingerprint(root, ctx["config"])
    if saved and not st.fingerprint_matches(saved, fresh):
        return st.envelope(
            "advance", False, 6, s, {"saved": saved, "fresh": fresh},
            "## 전이 거부 — 영수증이 낡았다\n\n게이트 통과 뒤 소유 범위의 소스가 "
            "바뀌었다. 게이트를 다시 돌려야 한다.\n\n"
            "`python scripts/pipeline/cli.py gate --phase 04 --run-id %s`" % s["run_id"],
            "python scripts/pipeline/cli.py gate --phase 04 --run-id %s" % s["run_id"])

    return _advance_to_next(root, paths, s, loaded[pid], ctx, cmd="advance")


def cmd_retry(root, args):
    return st.emit(run_retry(root, args.phase, args.counter, args.reason, args.run_id))


def run_retry(root, phase, counter, reason, run_id=None):
    """`failed` → `running`. **record 로는 못 한다** — 재작업의 유일한 문이다."""
    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("retry", False, 3, None, {}, "런이 없다.", None)
    loaded, _ = load_phases(root)
    pid = _normalize_phase(phase, loaded)
    if pid is None:
        return st.envelope("retry", False, 2, s, {}, "알 수 없는 페이즈: %r" % phase, None)
    if counter not in st.COUNTERS:
        return st.envelope("retry", False, 2, s, {},
                           "알 수 없는 카운터: %r (%s)"
                           % (counter, ", ".join(st.COUNTERS)), None)

    loop = loaded[pid]["front"].get("loop") or {}
    profile = (s.get("profile") or {}).get("name") or "normal"
    max_ = loop.get("max") or (loop.get("max_by_profile") or {}).get(profile) or 3
    used, _m, exceeded = st.counter_inc(s, counter, max_)
    st.append_event(paths, "counter_inc", cmd="retry", phase=pid,
                    counter=counter, used=used, reason=reason)
    if exceeded:
        st.escalate(paths, s, "`%s` 카운터가 상한 %d 에 닿았다: %s" % (counter, max_, reason),
                    ["범위를 줄인다", "계약을 고친다", "중단한다"], phase=pid)
        return st.envelope("retry", False, 7, s, {"counter": counter, "used": used},
                           "## 반복 한계 — 에스컬레이션\n\n`ESCALATION.md` 를 본다.",
                           "python scripts/pipeline/cli.py resume --ack "
                           "--answer-file <경로>")
    st.set_phase_status(s, pid, "running", retry_reason=reason)
    s["phase"] = pid
    st.save(paths, s)
    return st.envelope("retry", True, 0, s, {"counter": counter, "used": used, "max": max_},
                       "`%s` 를 다시 연다 (%s %d/%d). 사유: %s"
                       % (pid, counter, used, max_, reason),
                       "python scripts/pipeline/cli.py next --run-id %s" % s["run_id"])


def cmd_escalate(root, args):
    return st.emit(run_escalate(root, args.reason, args.run_id))


def run_escalate(root, reason=None, run_id=None):
    paths, s = st.load(Path(root), run_id)
    if s is None:
        return st.envelope("escalate", False, 3, None, {}, "런이 없다.", None)
    st.escalate(paths, s, reason or "사람이 판단을 요청했다",
                ["이대로 진행한다", "범위를 줄인다", "중단한다"],
                phase=s.get("phase"))
    return _escalation_envelope("escalate", paths, s)


def cmd_resume(root, args):
    return st.emit(run_resume(root, args.ack, args.answer_file, args.run_id))


def run_resume(root, ack=False, answer_file=None, run_id=None):
    """에스컬레이션 잠금 해제 **전용**.

    세션 복구는 `next --run-id` 가 한다 — 두 가지를 한 커맨드에 넣으면
    "재개했다"가 "판단했다"를 조용히 대신하게 된다.
    """
    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("resume", False, 3, None, {}, "런이 없다.", None)
    if not s.get("escalated"):
        return st.envelope("resume", True, 0, s, {},
                           "잠긴 런이 아니다. 세션을 이어가려면 `next --run-id` 를 쓴다.",
                           "python scripts/pipeline/cli.py next --run-id %s" % s["run_id"])
    if not ack:
        return st.envelope("resume", False, 2, s, {},
                           "`--ack` 없이는 잠금을 풀지 않는다. 사람이 답을 정했다는 "
                           "표시다.", None)
    answer = None
    if answer_file:
        p = Path(answer_file)
        if not p.is_absolute():
            p = root / p
        if not p.exists():
            return st.envelope("resume", False, 2, s, {}, "답변 파일이 없다: %s"
                               % answer_file, None)
        answer = p.read_text(encoding="utf-8")
    s["escalated"] = False
    s["run_status"] = "active"
    s["escalation"] = dict(s.get("escalation") or {}, answered_at=st.stamp(),
                           answer=answer)
    pid = s.get("phase")
    if pid and st.phase_status(s, pid) == "escalated":
        st.set_phase_status(s, pid, "running")
    st.append_event(paths, "resumed", cmd="resume", phase=pid)
    st.save(paths, s)
    return st.envelope("resume", True, 0, s, {"phase": pid},
                       "잠금을 풀었다. 사람의 답이 원장에 남았다.",
                       "python scripts/pipeline/cli.py next --run-id %s" % s["run_id"])


# ---------------------------------------------------------------------- status

def cmd_status(root, args):
    """현황. **항상 exit 0** — 상태를 묻는 것이 실패일 수는 없다."""
    paths, s = st.load(root, args.run_id)
    if s is None:
        return st.emit(st.envelope(
            "status", True, 0, None, {"runs": 0},
            "진행 중인 런이 없다. `init --feature <slug> --request-file <경로>` 로 시작한다.",
            None))
    data = {
        "run_id": s["run_id"], "slug": s.get("slug"),
        "phase": s.get("phase"), "phases": s.get("phases") or {},
        "run_dir": str(paths.run_dir),
        "contract": s.get("contract"), "grade": s.get("grade"),
        "gaps": s.get("gaps") or [],
    }
    lines = ["## 런 `%s` (%s)" % (s["run_id"], s.get("slug")), "",
             "현재 페이즈: **%s**" % s.get("phase"), ""]
    for pid in sorted((s.get("phases") or {})):
        lines.append("- `%s` — %s" % (pid, s["phases"][pid].get("status")))
    if s.get("gaps"):
        lines += ["", "gaps: " + ", ".join(s["gaps"])]
    return st.emit(st.envelope("status", True, 0, s, data, "\n".join(lines), None))


# ------------------------------------------------------------------------ CLI

def build_parser():
    # add_help=False — argparse 의 도움말은 stdout 으로 나가 봉투를 오염시킨다.
    p = argparse.ArgumentParser(prog="cli.py", add_help=False,
                                description="8페이즈 feature-pipeline")
    sub = p.add_subparsers(dest="cmd")

    sub.add_parser("doctor", add_help=False)

    sp = sub.add_parser("status", add_help=False)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("lint-phases", add_help=False)
    sp.add_argument("--dir", dest="dir", default=None)

    sp = sub.add_parser("init", add_help=False)
    sp.add_argument("--feature", dest="feature", default=None)
    sp.add_argument("--request-file", dest="request_file", default=None)
    sp.add_argument("--profile", dest="profile", default=None,
                    choices=["small", "normal"])

    sp = sub.add_parser("next", add_help=False)
    sp.add_argument("--run-id", dest="run_id", default=None)
    sp.add_argument("--phase", dest="phase", default=None)

    sp = sub.add_parser("advance", add_help=False)
    sp.add_argument("--phase", dest="phase", required=True)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("retry", add_help=False)
    sp.add_argument("--phase", dest="phase", required=True)
    sp.add_argument("--counter", dest="counter", required=True)
    sp.add_argument("--reason", dest="reason", required=True)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("escalate", add_help=False)
    sp.add_argument("--reason", dest="reason", default=None)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("resume", add_help=False)
    sp.add_argument("--ack", dest="ack", action="store_true")
    sp.add_argument("--answer-file", dest="answer_file", default=None)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("gate", add_help=False)
    sp.add_argument("--phase", dest="phase", default="04")
    sp.add_argument("--stage", dest="stage", default=None)
    sp.add_argument("--replay", dest="replay", default=None)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("record", add_help=False)
    sp.add_argument("--phase", dest="phase", required=True)
    sp.add_argument("--file", dest="file", required=True)
    sp.add_argument("--reviewer", dest="reviewer", default=None)
    sp.add_argument("--round", dest="round", type=int, default=None)
    sp.add_argument("--run-id", dest="run_id", default=None)

    return p


HANDLERS = {
    "doctor": cmd_doctor,
    "init": cmd_init,
    "next": cmd_next,
    "record": cmd_record,
    "gate": cmd_gate,
    "advance": cmd_advance,
    "retry": cmd_retry,
    "escalate": cmd_escalate,
    "resume": cmd_resume,
    "status": cmd_status,
    "lint-phases": cmd_lint_phases,
}


def main(argv=None):
    parser = build_parser()
    args, unknown = parser.parse_known_args(argv)
    if unknown:
        return st.emit(st.envelope(
            "usage", False, 2, None, {"unknown": unknown},
            "알 수 없는 인자: %s" % " ".join(unknown), None))
    handler = HANDLERS.get(args.cmd)
    if handler is None:
        return st.emit(st.envelope(
            "usage", False, 2, None, {"commands": sorted(HANDLERS)},
            "커맨드를 지정한다: %s" % ", ".join(sorted(HANDLERS)), None))
    return handler(resolve_root(), args)


def resolve_root():
    """설정이 있는 리포 루트를 찾는다.

    cwd 우선인 것이 요점이다 — 테스트가 임시 리포를 cwd 로 주고 부르므로,
    모듈 위치를 먼저 보면 실물 `_workspace/` 를 건드리게 된다.
    """
    cwd = Path.cwd()
    if (cwd / harness.CONFIG_REL).exists():
        return cwd
    r = harness._git(cwd, "rev-parse", "--show-toplevel")
    if r is not None and r.returncode == 0 and r.stdout.strip():
        top = Path(r.stdout.strip())
        if (top / harness.CONFIG_REL).exists():
            return top
    return ROOT


if __name__ == "__main__":
    sys.exit(main())
