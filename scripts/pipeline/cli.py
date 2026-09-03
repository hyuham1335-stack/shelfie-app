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
    #    폴백 교차검증기도 같이 본다 — config 가 이름을 부르는데 파일이 없으면
    #    01 이 라운드마다 그 에이전트를 못 찾는다. 계약 계층은 roles 만 훑으므로
    #    이 구멍은 여기서만 닫힌다.
    wanted = [(r_.get("agent"), "03-implement 가 호출할 대상이다")
              for r_ in (config.get("roles") or [])]
    fb = (config.get("cross_verify") or {}).get("fallback")
    if fb:
        wanted.append((fb, "01 의 폴백 교차검증기다"))
    missing = ["%s (%s)" % (a, why) for a, why in wanted
               if not (root / ".claude" / "agents" / ("%s.md" % a)).exists()]
    if not config.get("roles"):
        out.append({"name": "역할 에이전트 정의", "status": "SKIP",
                    "message": "config 를 읽지 못했다"})
    elif missing:
        out.append({"name": "역할 에이전트 정의", "status": "FAIL",
                    "message": "없다: %s" % ", ".join(missing)})
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

    # ⑤ 리뷰어. 05 가 없는 스킬을 부르면 라운드마다 헛돌고, 그것을 알게 되는
    #    시점은 리뷰어를 이미 띄운 뒤다. **기동 전에, 무료로 잡는다** (§E10).
    out.append(_check_reviewers(root, config))

    # ⑥ 원격과 base. 06 이 진입할 때 exit 9(3지선다)로 멈추는 것을 **기동 전에,
    #    무료로** 알려 준다 (§P3). 여기서 막지는 않는다 — 원격 없이 로컬까지만
    #    가는 것도 정당한 선택이고, 그 선택은 사람의 것이다.
    out.append(_check_remote(root, config))

    # ⑦ 외부 리뷰 봇. 켜 놓고 대상을 안 적으면 07 이 아무도 아닌 것을 기다린다.
    out.append(_check_external_bot(config))
    return out


def _check_remote(root, config):
    name = "원격과 base 브랜치"
    if not config:
        return {"name": name, "status": "SKIP", "message": "config 를 읽지 못했다"}
    vcs = config.get("vcs") or {}
    remote = vcs.get("remote") or "origin"
    base = vcs.get("base_branch")
    r = harness._git(root, "remote")
    names = (r.stdout.split() if r is not None and r.returncode == 0 else [])
    if remote not in names:
        return {"name": name, "status": "WARN",
                "message": "원격 %r 이 없다 — 06 이 exit 9 3지선다로 멈춘다. "
                           "**자동으로 만들지 않는다** (§P3)." % remote}
    v = harness._git(root, "rev-parse", "--verify", "-q",
                     "refs/remotes/%s/%s" % (remote, base))
    if v is None or v.returncode != 0:
        return {"name": name, "status": "WARN",
                "message": "base %r 이 원격 %r 에 없다 — 06 이 exit 9 로 "
                           "멈춘다." % (base, remote)}
    return {"name": name, "status": "PASS",
            "message": "%s/%s 확인" % (remote, base)}


def _check_external_bot(config):
    name = "외부 리뷰 봇"
    ext = (config or {}).get("external_pr_review") or {}
    if not ext.get("enabled"):
        return {"name": name, "status": "PASS",
                "message": "꺼져 있다 — 07 의 생략 조건이 성립하지 않아 "
                           "내장 리뷰가 항상 돈다. 안전한 기본값이다."}
    if not (ext.get("bot_logins") or []):
        return {"name": name, "status": "FAIL",
                "message": "켜져 있는데 bot_logins 가 비었다 — 07 이 아무도 "
                           "아닌 것을 timeout_sec 동안 기다린다."}
    return {"name": name, "status": "PASS",
            "message": "%s — 폴링 %ss / 상한 %ss (**미검증 상속값**)"
                       % (", ".join(ext["bot_logins"]), ext.get("poll_sec"),
                          ext.get("timeout_sec"))}


def _check_reviewers(root, config):
    import review as review_mod

    name = "리뷰어 스킬"
    if not config:
        return {"name": name, "status": "SKIP", "message": "config 를 읽지 못했다"}
    reviewers = config.get("reviewers") or []
    if not reviewers:
        return {"name": name, "status": "WARN",
                "message": "config.reviewers 가 비어 있다 — 05 의 "
                           "review05.status 가 늘 failed 이고 등급이 "
                           "PASS_WITH_GAPS 로 떨어진다. 통과가 아니라 미수행이다."}
    errors = review_mod.validate(root, config)
    if errors:
        return {"name": name, "status": "FAIL", "message": "; ".join(errors[:3])}
    return {"name": name, "status": "PASS",
            "message": "%d종 — %s" % (len(reviewers),
                                     ", ".join(r["code"] for r in reviewers))}


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
    _lint_reviewers(root, config, add)
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
    """원장 어휘 · 승격 목적지 · 리뷰 범위 셋의 단일 출처를 검사한다.

    이 파일이 손상되면 셋이 **동시에** 조용히 틀어진다 — 05 가 검토 제외 목록을
    잘못 만들고, 승격이 갈 곳을 잃고, 원장이 어휘 밖의 코드를 받는다.
    """
    import ledger

    path = Path(root) / TAXONOMY_REL
    if not path.exists():
        add(TAXONOMY_REL, "taxonomy", "SKIP",
            "원장이 아직 없다 — `ledger.seed(root)` 가 시드를 만든다")
        return
    try:
        data = harness._read_json(path)
    except (OSError, ValueError) as exc:
        add(TAXONOMY_REL, "taxonomy", "FAIL", "읽지 못했다: %s" % exc)
        return
    for err in ledger.validate_taxonomy(data):
        add(TAXONOMY_REL, "taxonomy", "FAIL", err)


def _lint_reviewers(root, config, add):
    """스킬 파일 실재 · 작성자 격리 · code 유니크.

    **기동 전에, 무료로 잡는다** (§E10 첫 행). 05 가 없는 스킬을 부르면 라운드
    마다 헛돌고, 그것을 알게 되는 시점은 리뷰어를 이미 띄운 뒤다.
    """
    import review as review_mod

    for err in review_mod.validate(root, config):
        add(harness.CONFIG_REL, "reviewers", "FAIL", err)


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
                           _horizon_render(pid, loaded), None)

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
    if pid == "05-code-review":
        _plan_05_review(root, paths, s, ctx)
    st.save(paths, s)

    render, next_cmd = render_packet(root, phase, ctx, s, checks)
    return st.envelope("next", True, 0, s,
                       {"produces": [resolve(p.get("path"), ctx)
                                     for p in phase["front"].get("produces") or []],
                        "requires_report": checks,
                        "prescan": _prescan(root, loaded, ctx, s) if pid == "01-plan" else []},
                       render, next_cmd)


def _plan_05_review(root, paths, s, ctx):
    """05 진입 시 **누가 리뷰할지를 여기서 확정한다.**

    모델이 정하지 않는다. `when` glob 이 정하는 결정론이고, 모델이 정하면 같은
    diff 가 런마다 다른 리뷰를 받아 `escaped_05` 를 세는 것이 의미를 잃는다.
    """
    import precheck as pc
    import review as review_mod

    changed = pc.changed_files(root)
    profile = (s.get("profile") or {}).get("name") or "normal"
    routed = review_mod.route(ctx["config"], changed, profile)
    node = s.setdefault("phases", {}).setdefault("05-code-review", {})
    node["planned"] = [r["code"] for r in routed["reviewers"]]
    node["routing"] = routed
    node["mode"] = review_mod.mode(ctx["config"],
                                   pc._changed_lines(root, changed))
    return node


def _excluded_render(root):
    """"검토 제외" 목록. **기계 강제 규칙이 늘수록 05 가 자동으로 싸지고 좁아진다** —

    규칙 승격의 복리가 실현되는 지점이고, 그래서 이 목록이 길어지는 것이 좋은
    신호다. 드롭한 건수는 `dropped_by_enforcement` 로 센다 (조용히 버리지 않는다).
    """
    import ledger

    codes = ledger.excluded_categories(root)
    if not codes:
        return ("## 검토 제외\n\n(없다) — 아직 기계로 막는 규칙이 없다. "
                "원장이 쌓이면 여기가 채워지고 05 가 그만큼 좁아진다.")
    return ("## 검토 제외 — 리뷰어 프롬프트에 그대로 싣는다\n\n"
            "아래는 이미 기계가 막는다. 리뷰어가 지적하면 `record` 가 드롭하되 "
            "`dropped_by_enforcement` 로 **센다** — 조용히 버리지 않는다.\n\n"
            + "\n".join("- `%s`" % c for c in codes))


def _review_render(s):
    """봉투가 **누가 리뷰하는지와 무엇이 빠졌는지**를 말한다."""
    node = (s.get("phases") or {}).get("05-code-review") or {}
    routed = node.get("routing")
    if not routed:
        return ""
    lines = ["## 리뷰어 라우팅 (결정론 — 네가 정하지 않는다)", ""]
    if not routed["reviewers"]:
        lines += ["**매칭된 리뷰어가 0개다.** 그러면 `review05.status` 는 "
                  "`failed` 이고 등급이 `PASS_WITH_GAPS` 로 떨어진다 — "
                  "아무도 안 부른 것은 통과가 아니라 미수행이다.",
                  "",
                  "변경 경로가 `config.reviewers[].when` 어디에도 걸리지 않았다. "
                  "라우팅 결함일 수 있으니 보고서에 남긴다."]
        return "\n".join(lines)
    lines.append("모드: **%s** (%s)"
                 % (node.get("mode"),
                    "단일 에이전트가 체크리스트를 순차 적용한다"
                    if node.get("mode") == "merged" else
                    "관점별 병렬 fan-out"))
    lines.append("")
    for r in routed["reviewers"]:
        lines.append("- `%s` → `.claude/skills/%s/SKILL.md` (매칭 %d개)"
                     % (r["code"], r["skill"], r.get("matched_count", 0)))
    if routed.get("dropped"):
        lines += ["", "**상한으로 빠진 리뷰어**: %s — 조용히 사라진 것이 아니라 "
                      "예산 때문이고, 보고서에 남는다."
                  % ", ".join("`%s`" % d["code"] for d in routed["dropped"])]
    lines += ["", "프롬프트 첫 줄은 **스킬 파일을 읽으라는 지시**다. "
                  "본문을 복사하지 마라 — 리뷰어 수만큼 고정비가 곱해진다."]
    return "\n".join(lines)


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
    xv = _cross_verify_render(ctx["config"], s, front)
    if xv:
        parts.append(xv)
    if pid == "05-code-review":
        rv_render = _review_render(s)
        if rv_render:
            parts.append(rv_render)
        parts.append(_excluded_render(root))
    warns = [c for c in (checks or []) if c.get("warn")]
    if warns:
        parts.append("## 경고\n\n" + "\n".join("- %s" % c["message"] for c in warns))

    if (front.get("gate") or {}).get("runner") == "adapter" and pid == "04-gate":
        cmd = "python scripts/pipeline/cli.py gate --phase 04 --run-id %s" % s["run_id"]
    else:
        cmd = ("python scripts/pipeline/cli.py record --phase %s --file <산출물> "
               "--run-id %s" % (pid.split("-")[0], s["run_id"]))
    return "\n\n".join(p for p in parts if p), cmd


def _cross_verify_render(config, s, front):
    """교차검증기가 누구인지 봉투가 말한다.

    페이즈 파일 본문은 `${...}` 가 풀리지 않으므로(`_section` 이 원문을 그대로
    싣는다) 이 이름은 여기서만 나올 수 있다. **코어에 도구 이름을 박지 않는다** —
    config 를 읽을 뿐이고, 그래서 스택·도구를 바꿔도 코어는 그대로다.
    """
    if not (front.get("review") or {}).get("reviewers"):
        return ""
    if not any(r.get("kind") == "cross_verify"
               for r in front["review"]["reviewers"]):
        return ""
    cv = config.get("cross_verify") or {}
    mode = ((s.get("cross_verify") or {}).get("mode")) or "skipped"
    if mode == "primary":
        return ("## 교차검증\n\n외부 관측기 `%s` 를 쓴다. 이것이 있으면 "
                "**1라운드 수렴이 열린다** — 둘 다 폴백이 아니고 Major 이상이 "
                "0건이면 그 회차에서 끝난다." % cv.get("primary"))
    if mode == "fallback":
        return ("## 교차검증\n\n외부 관측기가 없어 폴백 `%s` 를 쓴다. "
                "**폴백이 섞이면 1라운드 수렴을 허용하지 않는다** — 독립 관측 "
                "둘이라는 전제가 약해지기 때문이고, 최소 2라운드를 돈다."
                % cv.get("fallback"))
    return ("## 교차검증\n\n교차검증기가 없다. 02 는 스킵되고 등급이 "
            "`PASS_WITH_GAPS` 로 강등된다 — 조용히 통과가 아니다.")


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


def _horizon_render(pid, loaded=None):
    """지평선 — 다음 페이즈가 없다. 둘을 가른다.

    `pid` 가 없으면 **런이 끝난 것**이고, 있으면 그 페이즈가 아직 없는 것이다.
    전에는 이 함수가 "01~04 까지가 범위다"라고 **범위를 문자열로 적고 있었고**,
    05 가 생긴 뒤에도 그대로 남아 `feature.md` 와 어긋나 있었다. 이제 범위는
    실재하는 페이즈 파일에서 유도한다 — 문자열을 두 곳에 두지 않는다.
    """
    if not pid:
        return ("## 런 완료\n\n"
                "마지막 페이즈까지 끝났다. `status` 로 등급과 남은 gap 을 본다.")
    scope = ""
    if loaded:
        ids = sorted(loaded)
        scope = "이 실행기의 범위는 `%s` ~ `%s` 다.\n" % (ids[0], ids[-1])
    return ("## 여기까지다\n\n"
            "%s다음 페이즈 `%s` 는 아직 구현되지 않았다.\n"
            "`status` 로 이 런의 등급과 남은 gap 을 본다." % (scope, pid))


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
                           _horizon_render(nxt, loaded), None)
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
    prev_open = _previous_open(rounds, round_, reviewer)
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
                      "keys": got["keys"], "blocking": got["blocking"],
                      "closed": got["closed"]}
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


def _previous_open(rounds, round_, reviewer=None):
    """**아직 열려 있는** 이전 회차의 지적. 사라지면 단조성 검사가 잡는다.

    닫힌 것은 뺀다. 안 빼면 3라운드 제출이 1라운드에서 이미 해소된 지적까지
    다시 적어야 통과하고, 그 목록이 리뷰어 프롬프트에 실리므로 **접두부가
    라운드마다 자란다** (M21 ②).

    `reviewer` 를 주면 그 리뷰어가 낸 것만 돌려준다. 두 리뷰어가 모두 `F-1` 을
    쓰므로 id 대조를 전역으로 하면 한 줄이 서로 다른 두 지적을 동시에
    해소로 계수한다 (M21 ③).
    """
    open_, closed = {}, set()
    for rn in sorted(rounds, key=int):
        if int(rn) >= round_:
            continue
        for code, sub in rounds[rn].items():
            for k in sub.get("keys") or []:
                open_.setdefault(k["key"], dict(k, reviewer=code))
            closed |= set(sub.get("closed") or [])
    out = [k for key, k in open_.items() if key not in closed]
    if reviewer is not None:
        out = [k for k in out if k.get("reviewer") == reviewer]
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
        st.demote(s, on_skip.get("grade") or st.GRADES[1], on_skip.get("gap"))
        gap = on_skip.get("gap")
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


# ------------------------------------------------------- 05 제출 처리

def _record_05(root, paths, s, phase_item, ctx, file, reviewer, round_):
    """리뷰어 제출 하나를 받는다. 전원이 모이면 병합하고 원장에 쌓는다.

    **findings 개수와 "리뷰가 수행됐는가"를 분리한다** — 리뷰어가 전부 실패해도
    findings 는 0건이고, 그 0을 "지적이 없다"로 읽으면 아무도 보지 않은 코드가
    통과한다 (§E1).
    """
    import ledger
    import review as review_mod

    if not reviewer:
        return st.envelope(
            "record", False, 2, s, {},
            "05 는 리뷰어별 제출이다. `--reviewer <code>` 를 붙인다.\n"
            "계약 대조는 `contract-trace` 가 따로 낸다.", None)
    if not file.exists():
        return st.envelope("record", False, 3, s, {}, "산출물이 없다: %s" % file, None)
    try:
        payload = harness._read_json(file)
    except (OSError, ValueError) as exc:
        return st.envelope("record", False, 8, s, {},
                           "JSON 을 읽지 못했다: %s" % exc, None)

    raw_path = file.with_name(file.name.replace(".json", ".raw.md"))
    if not raw_path.exists():
        return st.envelope("record", False, 8, s, {},
                           "리뷰어 원문이 없다: %s — 구조화 JSON 만으로는 "
                           "quote 를 검증할 수 없다" % raw_path.name, None)
    raw_text = raw_path.read_text(encoding="utf-8")

    node = s.setdefault("phases", {}).setdefault("05-code-review", {})
    if not (node.get("trace") or {}):
        return st.envelope(
            "record", False, 3, s, {},
            "계약 대조가 먼저다. `contract-trace --run-id %s` 를 돌린다 — "
            "무료이고, 여기서 잡히는 것을 리뷰어에게 보내면 리뷰어가 같은 것을 "
            "다시 발견하는 데 돈을 쓴다." % s["run_id"],
            "python scripts/pipeline/cli.py contract-trace --run-id %s" % s["run_id"])

    round_ = round_ or 1
    rounds = node.setdefault("rounds", {})
    prev_open = _previous_open(rounds, round_, reviewer)
    excluded = ledger.excluded_categories(root)
    got = review_mod.check(root, ctx["config"], payload, raw_text, prev_open,
                           excluded=excluded)
    if not got["ok"]:
        st.append_event(paths, "check_fail", cmd="record", phase="05-code-review",
                        reviewer=reviewer, errors=len(got["errors"]))
        st.save(paths, s)
        return st.envelope("record", False, 8, s, {"errors": got["errors"]},
                           "## 리뷰 제출 거부\n\n" +
                           "\n".join("- %s" % e for e in got["errors"]),
                           _same_command(s, "05"))

    slot = rounds.setdefault(str(round_), {})
    slot[reviewer] = {"mode": payload.get("mode") or "primary",
                      "keys": got["keys"], "blocking": got["blocking"],
                      "closed": got["closed"], "findings": got["findings"],
                      "dropped_by_enforcement": got["dropped_by_enforcement"],
                      "truncated": got["truncated"],
                      "need_more_context": payload.get("need_more_context") or []}
    st.save(paths, s)

    planned = node.get("planned") or [reviewer]
    missing = [c for c in planned if c not in slot]
    if missing:
        return st.envelope("record", True, 0, s,
                           {"round": round_, "waiting_for": missing},
                           "`%s` 리뷰를 받았다. 아직 `%s` 가 남았다."
                           % (reviewer, "`, `".join(missing)),
                           "python scripts/pipeline/cli.py record --phase 05 "
                           "--file <리뷰 json> --reviewer %s --round %d --run-id %s"
                           % (missing[0], round_, s["run_id"]))

    return _judge_05(root, paths, s, phase_item, ctx, round_, slot, node)


def _judge_05(root, paths, s, phase_item, ctx, round_, slot, node):
    """전원이 모였다. 병합 → 원장 → 수리 판정."""
    import ledger
    import review as review_mod

    subs = [dict(v, reviewer=code) for code, v in slot.items()]
    merged = review_mod.merge(subs)

    planned = node.get("planned") or sorted(slot)
    ok_count = sum(1 for v in slot.values() if v.get("keys") is not None)
    status = review_mod.status(len(planned), ok_count)

    s["review05"] = {
        "status": status,
        "reviewers_planned": len(planned),
        "reviewers_ok": ok_count,
        "mode": node.get("mode") or "fanout",
        "major": sum(1 for f in merged if f.get("severity") in verdict.BLOCKING),
        "need_more_context": [n for v in slot.values()
                              for n in (v.get("need_more_context") or [])],
        "dropped_by_enforcement": sum(v.get("dropped_by_enforcement") or 0
                                      for v in slot.values()),
        "truncated": any(v.get("truncated") for v in slot.values()),
    }
    if status != "ok":
        st.demote(s, st.GRADES[1], "review05:%s" % status)

    # 원장에 쌓는다. **계약 대조의 결과도 함께 쌓는다** — 기계가 찾은 것과
    # 리뷰어가 찾은 것이 같은 눈금 위에 있어야 승격 집계가 성립한다.
    rows = [dict(f, resolution=f.get("resolution") or "deferred",
                 source=f.get("source") or "reviewer")
            for f in merged]
    trace_path = paths.run_dir / "05_trace.json"
    if trace_path.exists() and not node.get("trace_ledgered"):
        trace = json.loads(trace_path.read_text(encoding="utf-8"))
        rows += [dict(f, resolution=f.get("resolution") or "deferred")
                 for f in trace.get("findings") or []]
        node["trace_ledgered"] = True
    try:
        ledger.append(root, s["run_id"], "05", rows)
    except ValueError as exc:
        # 어휘 밖의 category 는 조용히 버리지 않는다. 제출을 되돌린다.
        return st.envelope("record", False, 8, s, {"error": str(exc)},
                           "## 원장 어휘 밖\n\n%s" % exc, _same_command(s, "05"))

    staged = ledger.stage_promotions(root)
    (paths.run_dir / "05_promo_staged.json").write_text(
        json.dumps(staged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (paths.run_dir / "05_review.json").write_text(
        json.dumps({"round": round_, "review05": s["review05"],
                    "findings": merged}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8")
    st.save(paths, s)

    blocking = [f for f in merged if f.get("severity") in verdict.BLOCKING]
    if blocking:
        loop = phase_item["front"].get("loop") or {}
        used, _max, exceeded = st.counter_inc(s, "review_repair",
                                              loop.get("max") or 2)
        if exceeded:
            st.escalate(paths, s,
                        "05 의 Critical/Major %d건이 %d회 안에 해소되지 않았다"
                        % (len(blocking), loop.get("max") or 2),
                        ["계약 결함을 먼저 의심한다 — 같은 지적이 반복되면 "
                         "코드가 아니라 계약이 틀렸을 수 있다",
                         "이대로 진행한다(미해결 지적을 안고 간다)", "중단한다"],
                        phase="05-code-review")
            return _escalation_envelope("record", paths, s)
        st.save(paths, s)
        return st.envelope(
            "record", False, 4, s,
            {"blocking": len(blocking), "findings": blocking,
             "review05": s["review05"]},
            _review_repair_render(blocking, used + 1),
            "python scripts/pipeline/cli.py gate --phase 04 --stage scoped "
            "--run-id %s" % s["run_id"])

    return _advance_to_next(root, paths, s, phase_item, ctx)


def _review_repair_render(blocking, round_no):
    lines = ["## 수리가 필요하다 (%d회차)" % round_no, "",
             "Critical/Major %d건. **Minor 는 고치지 않는다** — 원장에 쌓이고 "
             "보고서로 간다." % len(blocking), ""]
    for f in blocking:
        raised = (" *(2인 합치로 %s → %s)*"
                  % (f["severity_raised_from"], f["severity"])
                  if f.get("severity_raised_from") else "")
        lines.append("- **%s** → `%s`: %s%s"
                     % (f.get("severity"), f.get("target_role"),
                        f.get("title"), raised))
    contract_defect = [f for f in blocking
                       if f.get("category") == "CONTRACT_DEFECT"]
    if contract_defect:
        lines += ["", "**`CONTRACT_DEFECT` 가 있다.** 이것은 수리 대상이 아니라 "
                      "에스컬레이션이다 — 계약은 메인 단독 소유다."]
    lines += ["", "고친 뒤 `gate --phase 04 --stage scoped` 로 재게이트하고, "
                  "델타 재리뷰 1명을 돌린 다음 다시 제출한다.",
              "**수리하면 지문이 바뀌어 영수증이 낡는다** — 06 이 자동으로 막으므로 "
              "재게이트를 잊을 수 없다."]
    return "\n".join(lines)


PR_CLOSED_STATES = ("closed", "merged")


def _record_07(root, paths, s, phase_item, ctx, file, reviewer, round_):
    """07 제출 — 외부·내장 리뷰를 받고 `escaped_05` 를 센다.

    **PR 이 닫혔거나 머지됐으면 아무것도 하지 않고 정상 종료한다** (§E8).
    이미 끝난 것을 수리하거나 머지된 코드에 코멘트를 다는 것은 소음이다.
    """
    import ledger
    import review07 as rv7

    file = Path(file)
    if not file.exists():
        return st.envelope("record", False, 3, s, {},
                           "산출물이 없다: %s" % file, None)
    try:
        payload = harness._read_json(file)
    except (OSError, ValueError) as exc:
        return st.envelope("record", False, 8, s, {},
                           "JSON 을 읽지 못했다: %s" % exc, None)

    pr_state = (s.get("pr") or {}).get("state")
    if pr_state in PR_CLOSED_STATES:
        st.demote(s, st.GRADES[1], "pr_%s" % pr_state)
        s.setdefault("review07", {}).update(
            {"external": {"status": "skipped_pr_%s" % pr_state, "major": 0},
             "code_review": "skipped", "escaped_05": 0})
        st.save(paths, s)
        return _advance_to_next(root, paths, s, phase_item, ctx)

    errors = []
    ext = payload.get("external") or {}
    if ext.get("status") not in rv7.EXTERNAL_STATUS:
        errors.append("`external.status` 는 %s 중 하나다 (받은 값: %r)"
                      % (" · ".join(rv7.EXTERNAL_STATUS), ext.get("status")))
    if payload.get("code_review") not in rv7.EFFORTS:
        errors.append("`code_review` 는 %s 중 하나다 (받은 값: %r)"
                      % (" · ".join(rv7.EFFORTS), payload.get("code_review")))

    findings = payload.get("findings") or []
    known = ledger.categories(root)
    for f in findings:
        if f.get("source") not in ledger.SOURCES:
            errors.append("finding %s: `source` 가 어휘 밖이다 (%r) — %s"
                          % (f.get("id"), f.get("source"),
                             " · ".join(ledger.SOURCES)))
        if f.get("category") not in known:
            errors.append("finding %s: taxonomy 에 없는 category 다 (%r)"
                          % (f.get("id"), f.get("category")))
        if f.get("severity") not in verdict.SEVERITIES:
            errors.append("finding %s: severity 가 어휘 밖이다 (%r)"
                          % (f.get("id"), f.get("severity")))

    if payload.get("change_requested") and not findings:
        errors.append("`change_requested` 가 참인데 findings 가 비었다 — "
                      "무엇을 고치라는 것인지 없이 차단만 하는 제출이다.")
    if errors:
        return st.envelope("record", False, 8, s, {"errors": errors},
                           "\n".join(["## 제출이 규약을 어겼다", ""]
                                     + ["- %s" % e for e in errors]),
                           None)

    got = rv7.escaped(root, findings, s["run_id"])
    # **dedup 은 버리는 것이 아니라 세는 것이다** — 여기서 처음 잡힌
    # Critical/Major 가 05 라우팅이 놓친 것이다.
    ledger.append(root, s["run_id"], "07",
                  [dict(f, resolution="deferred") for f in got["findings"]])

    s.setdefault("review07", {}).update(
        {"external": {"status": ext.get("status"),
                      "major": ext.get("major") or 0},
         "code_review": payload.get("code_review"),
         "escaped_05": got["escaped_05"],
         "deduped": got["deduped"],
         "human_comments": len(payload.get("human_comments") or [])})

    if payload.get("change_requested"):
        used, max_, exceeded = st.counter_inc(s, "pr_repair", 2)
        st.save(paths, s)
        if exceeded:
            st.escalate(paths, s, "외부 변경 요청이 수리 예산 안에서 안 닫혔다",
                        options=["사람이 직접 수리한 뒤 재개", "PR 을 닫는다",
                                 "중단"], phase="07-pr-review")
            st.save(paths, s)
            return _escalation_envelope("record", paths, s)
        return st.envelope("record", False, 10, s,
                           {"findings": findings, "repair": used},
                           "\n".join([
                               "## 변경 요청이 열려 있다", "",
                               "**미해결로 07 을 끝낼 수 없다.** PR 체크가 "
                               "빨간불인데 파이프라인이 초록불인 척하게 된다.",
                               "", "수리 %d/%d 회차다." % (used, max_)]),
                           None)

    st.save(paths, s)
    return _advance_to_next(root, paths, s, phase_item, ctx)


PR_STATES = ("open", "closed", "merged")


def _record_06(root, paths, s, phase_item, ctx, file, reviewer, round_):
    """06 제출 — 메인 세션이 forge 도구로 만든 PR 의 결과를 받는다.

    검사 셋이 전부 "번호가 갈라지는 것" 을 막는다. 07 이 PR 하나를 보고
    수리·코멘트·등급을 정하므로, 어느 PR 인지 흔들리면 그 뒤가 전부 흔들린다.
    """
    if not (s.get("pr") or {}).get("pushed"):
        return st.envelope("record", False, 3, s, {},
                           "\n".join([
                               "## 아직 push 하지 않았다", "",
                               "`pr` 을 먼저 돌려 push 와 요청서를 만든다.",
                               "",
                               "python scripts/pipeline/cli.py pr --run-id %s"
                               % s["run_id"]]),
                           None)

    file = Path(file)
    if not file.exists():
        return st.envelope("record", False, 3, s, {},
                           "산출물이 없다: %s" % file, None)
    try:
        payload = harness._read_json(file)
    except (OSError, ValueError) as exc:
        return st.envelope("record", False, 8, s, {},
                           "JSON 을 읽지 못했다: %s" % exc, None)

    errors = []
    number = payload.get("number")
    if not isinstance(number, int) or isinstance(number, bool):
        errors.append("`number` 는 정수여야 한다 (받은 값: %r). 문자열 번호는 "
                      "비교가 문자열 비교가 되어 갱신 판정이 흔들린다." % (number,))
    state = payload.get("state")
    if state not in PR_STATES:
        errors.append("`state` 는 %s 중 하나다 (받은 값: %r)"
                      % (" · ".join(PR_STATES), state))
    prev = (s.get("pr") or {}).get("number")
    if prev is not None and number != prev:
        errors.append("PR 번호가 갈라졌다: 기록은 #%s 인데 제출은 #%s 다. "
                      "**갱신이어야 할 것을 새로 만들었다** — 07 이 어느 PR 을 "
                      "볼지 모르게 된다." % (prev, number))
    if errors:
        return st.envelope("record", False, 8, s, {"errors": errors},
                           "\n".join(["## 제출이 규약을 어겼다", ""]
                                     + ["- %s" % e for e in errors]),
                           None)

    s.setdefault("pr", {}).update({
        "number": number, "state": state,
        "url": payload.get("url"),
        "created_at": payload.get("created_at") or st.stamp(),
    })
    st.append_event(paths, "pr_opened", cmd="record", phase="06-pr",
                    number=number, state=state)
    st.save(paths, s)
    return _advance_to_next(root, paths, s, phase_item, ctx)


_RECORD_HANDLERS = {"01-plan": _record_01, "02-cross-verify": _record_02,
                    "03-implement": _record_03, "05-code-review": _record_05,
                    "06-pr": _record_06,
                    "07-pr-review": _record_07}


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
        st.demote(s, report.get("grade") or st.GRADES[1])
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

# -------------------------------------------------------------------- precheck

def cmd_precheck(root, args):
    return st.emit(run_precheck(root, args.scope, args.run_id,
                               getattr(args, "phase", "05")))


def run_precheck(root, scope="pr", run_id=None, phase="05"):
    """05 진입과 06 에서 각 1회, 그리고 **재개마다** 다시 돈다 (§E13).

    런 없이도 돈다 — 무료 검사의 요점이 "시작하기 전에 안다"이므로 런을
    만들어야만 부를 수 있으면 그 값이 절반이 된다.
    """
    import precheck as pc

    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is not None and s.get("escalated"):
        return _escalation_envelope("precheck", paths, s)

    pid = _PRECHECK_PHASE.get(str(phase), "05-code-review")
    got = pc.run(root, scope=scope)

    if s is not None:
        # 명세의 state 스키마가 `precheck.at_05` 와 `at_06` 을 나란히 둔다 —
        # 같은 검사가 두 시점에 돌고 **그 사이에 값이 변하기 때문**이다 (§E13).
        # 한 칸에 덮어쓰면 06 이 05 의 예산을 지우고, 무엇이 언제 참이었는지
        # 보고서가 말할 수 없게 된다.
        slot = {"files": got["budget"]["files"], "lines": got["budget"]["lines"],
                "base_behind": _base_behind(got), "infra": got["infra_failures"],
                "exit": got["exit"], "classification": got["classification"]}
        s.setdefault("precheck", {})["at_%s" % str(phase).zfill(2)[:2]] = slot
        s.setdefault("phases", {}).setdefault(pid, {})["precheck"] = {
            "exit": got["exit"], "classification": got["classification"],
            "budget": got["budget"]}
        st.append_event(paths, "check_fail" if got["exit"] else "stage_done",
                        cmd="precheck", phase=pid, exit=got["exit"])
        st.save(paths, s)

        if got["exit"] == 10:
            # exit 10 은 **상태를 잠근다** (§2.3). 전에는 잠근다고 적어 두고
            # 실제로는 잠그지 않아, 인프라가 깨진 채로 다음 명령이 그냥 돌았다.
            st.escalate(paths, s, "인프라 선행 조건 실패 — precheck",
                        options=[c["message"] for c in got["checks"]
                                 if not c["ok"] and c["kind"] == "infra"],
                        phase=pid)
            st.save(paths, s)
            return _escalation_envelope("precheck", paths, s)

    return st.envelope("precheck", got["exit"] == 0, got["exit"], s, got,
                       _precheck_render(got),
                       None if got["exit"] else _precheck_next(pid, s))


_PRECHECK_PHASE = {"05": "05-code-review", "06": "06-pr"}


def _base_behind(got):
    """divergence 검사가 센 behind 수. 검사가 안 돌았으면 0 이 아니라 None 이다."""
    for c in got["checks"]:
        if c["name"] == "base":
            return c.get("behind")
    return None


def _precheck_next(pid, s):
    rid = " --run-id %s" % s["run_id"] if s else ""
    if pid == "06-pr":
        return None        # 06 의 exit 9 는 사람의 판단이다 — 다음 명령이 없다
    return "python scripts/pipeline/cli.py contract-trace" + rid


def _precheck_render(got):
    if got["exit"] == 0:
        return ("`precheck` 통과. 파일 %d · 줄 %d 로 예산 안이고 브랜치·base·"
                "인프라가 전부 맞다.\n계약 대조로 넘어간다."
                % (got["budget"]["files"], got["budget"]["lines"]))
    bad = [c for c in got["checks"] if not c["ok"]]
    head = ("## 인프라 선행 조건이 안 맞는다" if got["exit"] == 10 else
            "## 사람의 판단이 필요하다")
    lines = [head, ""]
    lines += ["- **%s**: %s" % (c["name"], c["message"]) for c in bad]
    if got["exit"] == 10:
        lines += ["", "**카운터를 소모하지 않았다.** 코드가 아니라 환경의 문제이므로 "
                      "재시도 예산을 태우지 않는다.",
                  "이대로 회귀를 돌리면 전부 빨간불이 되고, 그것을 코드 문제로 "
                  "읽게 된다."]
    else:
        lines += ["", "**자동으로 쪼개거나 리베이스하지 않는다.** 무엇을 할지 "
                      "정하고 다시 부른다."]
    return "\n".join(lines)


# --------------------------------------------------------------------- approve

def cmd_approve(root, args):
    return st.emit(run_approve(root, args.phase, revoke=args.revoke,
                               auto=args.auto, run_id=args.run_id))


def run_approve(root, phase="06", revoke=False, auto=False, run_id=None):
    """승인을 **이벤트로 못박는다.** 종료 코드 **0 / 3**.

    승인 시점의 **지문과 등급을 함께** 기록하는 것이 요점이다. 지문이 없으면
    "무엇을 승인했는가"가 남지 않아, 승인 뒤에 코드가 바뀌어도 그 승인이
    계속 유효해 보인다. 06 이 push 직전에 이 지문을 다시 보고 어긋나면
    exit 6 으로 재승인을 요구한다.

    `--auto` 의 범위는 **push + PR 생성까지**다 (§3.6). 06 시점의 등급은 외부
    리뷰를 아직 못 본 "예상" 이므로, 07 의 코멘트 게시는 등급을 재확인한 뒤다.
    """
    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("approve", False, 3, None, {},
                           "런이 없다. `init --feature` 로 시작한다.", None)
    if s.get("escalated"):
        return _escalation_envelope("approve", paths, s)

    pid = _PRECHECK_PHASE.get(str(phase), "06-pr")
    prev = _APPROVE_REQUIRES.get(pid)
    if prev and st.phase_status(s, prev) != "passed":
        return st.envelope("approve", False, 3, s, {"requires": prev},
                           "\n".join(["## 아직 승인할 수 없다", "",
                                      "`%s` 가 통과하지 않았다." % prev]),
                           None)

    node = s.setdefault("approval", {}).setdefault(str(phase).zfill(2)[:2], {})
    if revoke:
        node.update({"granted": False, "revoked_at": st.stamp(),
                     "reason": "사용자 철회"})
        st.append_event(paths, "approval_revoked", cmd="approve", phase=pid)
        st.save(paths, s)
        return st.envelope("approve", True, 0, s, {"approval": node},
                           "승인을 철회했다. 다시 승인하기 전에는 push 하지 않는다.",
                           None)

    config, _adapter, _cal = adapters.load(root)
    node.update({
        "granted": True,
        "mode": "auto" if auto else "user",
        "fingerprint": st.fingerprint(root, config),
        # **범위를 좁게 못박는다.** 07 의 코멘트 게시도, 머지도 여기 없다.
        "scope": "push+pr",
        "grade_at_grant": s.get("grade"),
        "at": st.stamp(),
    })
    st.append_event(paths, "approved", cmd="approve", phase=pid,
                    mode=node["mode"], grade=node["grade_at_grant"])
    st.save(paths, s)
    return st.envelope("approve", True, 0, s, {"approval": node},
                       _approve_render(node, pid),
                       "python scripts/pipeline/cli.py next --run-id %s"
                       % s["run_id"])


# 승인은 그 앞 페이즈가 끝난 뒤에만 뜻이 있다. 07 은 `inherited:06` 이라
# 자기 승인을 따로 받지 않는다 — 그래서 여기 없다.
_APPROVE_REQUIRES = {"06-pr": "05-code-review"}


def _approve_render(node, pid):
    return "\n".join([
        "## 승인 기록됨 — %s" % pid,
        "",
        "- 방식: **%s**" % node["mode"],
        "- 범위: **%s** (07 코멘트 게시와 머지는 포함하지 않는다)" % node["scope"],
        "- 승인 시점 등급: %s" % (node["grade_at_grant"] or "미정"),
        "",
        "이 뒤에 소스가 바뀌면 지문이 어긋나 **승인이 자동으로 무효**가 된다.",
    ])


# ---------------------------------------------------------------------- report

def cmd_report(root, args):
    return st.emit(run_report(root, args.out, args.run_id))


def run_report(root, out=None, run_id=None):
    """08 — 결정론 표 조립 + 필수 섹션 검사. 종료 코드 **0 / 3 / 6**.

    **보고서는 파이프라인을 실패시키지 않는다.** 섹션이 빠져도 산출하고
    원장에 기록만 한다 — 보고서가 런을 실패시키면 안 쓰는 것이 이득이 된다.
    """
    import report as rep

    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("report", False, 3, None, {},
                           "런이 없다. `init --feature` 로 시작한다.", None)

    if s.get("grade") == st.GRADES[2]:
        # 에스컬레이션으로 멈춘 런은 ESCALATION.md 가 보고서다. 그 위에
        # 성공한 것 같은 문서를 얹지 않는다 (§E12).
        return st.envelope("report", False, 3, s, {"grade": s.get("grade")},
                           "\n".join([
                               "## 08 을 돌리지 않는다", "",
                               "등급이 `INCOMPLETE` 다 — `ESCALATION.md` 가 "
                               "보고서를 겸한다.",
                               "", "`%s`" % paths.rel(paths.escalation)]),
                           None)

    staged = [p for p in (s.get("promotions") or [])
              if p.get("status") == "staged"]
    if staged:
        return st.envelope("report", False, 6, s, {"staged": staged},
                           "\n".join([
                               "## 승격이 종결되지 않았다", "",
                               "`staged` 가 %d 건 남아 있다. 08 은 미종결을 "
                               "통과시키지 않는다." % len(staged), "",
                               "python scripts/pipeline/cli.py promote --flush "
                               "--run-id %s" % s["run_id"]]),
                           "python scripts/pipeline/cli.py promote --flush "
                           "--run-id %s" % s["run_id"])

    src = paths.run_dir / "08_report_data.json"
    if not src.exists():
        return st.envelope("report", False, 3, s, {},
                           "`08_report_data.json` 이 없다 — 08 의 입력은 이 "
                           "파일 하나뿐이다 (20KB 이하).", None)
    try:
        data = harness._read_json(src)
    except (OSError, ValueError) as exc:
        data = {}
        st.append_event(paths, "check_fail", cmd="report", phase="08-report",
                        error=str(exc))

    _config, _adapter, cal = adapters.load(root)
    text, missing = rep.build(s, data, cal or {}, s.get("promotions") or [])

    target = Path(out) if out else (
        root / "docs" / "harness" / "pipeline" / "runs"
        / ("%s.md" % s["run_id"]))
    target.parent.mkdir(parents=True, exist_ok=True)
    # 같은 run_id 로 다시 쓰면 **덮어쓴다** — 최종본이 맞다.
    target.write_text(text, encoding="utf-8")

    if missing:
        st.append_event(paths, "check_fail", cmd="report", phase="08-report",
                        missing_sections=missing)
    st.save(paths, s)
    rel = str(target.relative_to(root)) if str(target).startswith(str(root)) \
        else str(target)
    return st.envelope("report", True, 0, s,
                       {"out": rel, "missing_sections": missing},
                       _report_render(rel, missing, s), None)


def _report_render(rel, missing, s):
    lines = ["## 보고서를 썼다", "", "`%s`" % rel, "",
             "완료 등급 **%s**%s" % (s.get("grade") or "미정",
                                    (" — " + ", ".join(s.get("gaps") or []))
                                    if s.get("gaps") else "")]
    if missing:
        lines += ["", "**필수 섹션이 빠졌다: %s**" % ", ".join(missing),
                  "원장에 기록했다. 다만 **보고서는 파이프라인을 실패시키지 "
                  "않는다.**"]
    return "\n".join(lines)


# ------------------------------------------------------------------- review07

def cmd_review07(root, args):
    return st.emit(run_review07(root, args.external, args.run_id))


def run_review07(root, external=None, run_id=None):
    """생략 조건과 effort 를 **결정론으로** 정한다. 종료 코드 0 / 3 / 8.

    모델이 effort 를 고르면 같은 상황이 런마다 다른 리뷰를 받고, 그러면
    `escaped_05` 가 생략 정책의 근거가 되지 못한다.
    """
    import review07 as rv7

    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("review07", False, 3, None, {},
                           "런이 없다. `init --feature` 로 시작한다.", None)
    if s.get("escalated"):
        return _escalation_envelope("review07", paths, s)

    config, _adapter, _cal = adapters.load(root)
    ext_cfg = config.get("external_pr_review") or {}

    if not ext_cfg.get("enabled"):
        # **봇이 꺼져 있으면 소스 자체가 없다.** 생략 조건은 `reviewed` 를
        # 요구하므로 성립하지 않고, 내장 리뷰가 항상 돈다.
        norm = {"status": "disabled", "major": 0, "findings": [],
                "human_comments": [], "change_requested": False,
                "note": "config.external_pr_review.enabled 가 false 다."}
    elif not external:
        norm = {"status": "timeout", "major": 0, "findings": [],
                "human_comments": [], "change_requested": False,
                "note": "외부 리뷰 파일이 주어지지 않았다 — 무응답으로 본다."}
    else:
        f = Path(external)
        if not f.exists():
            return st.envelope("review07", False, 3, s, {},
                               "외부 리뷰 파일이 없다: %s" % f, None)
        try:
            payload = harness._read_json(f)
        except (OSError, ValueError) as exc:
            return st.envelope("review07", False, 8, s, {},
                               "JSON 을 읽지 못했다: %s" % exc, None)
        if (payload.get("status") is not None
                and payload["status"] not in rv7.EXTERNAL_STATUS):
            return st.envelope("review07", False, 8, s,
                               {"status": payload.get("status")},
                               "`status` 는 %s 중 하나다 (받은 값: %r)"
                               % (" · ".join(rv7.EXTERNAL_STATUS),
                                  payload.get("status")), None)
        norm = rv7.normalize_external(payload)

    audit = rv7.audit_due(root)
    got = rv7.decide(s, norm, config, audit=audit)

    s.setdefault("audit", {}).update(
        {"is_audit_run": bool(audit),
         "reason": ("5런 주기" if audit else None)})
    s.setdefault("review07", {}).update(
        {"external": {"status": norm["status"], "major": norm["major"]},
         "code_review": got["effort"], "escaped_05": None})
    if got["gap"]:
        st.demote(s, st.GRADES[1], got["gap"])
    st.save(paths, s)

    data = dict(got, external=norm)
    return st.envelope("review07", True, 0, s, data, _review07_render(got, norm),
                       None if got["skip"] else
                       "/code-review --effort %s" % got["effort"])


def _review07_render(got, norm):
    lines = ["## 07 리뷰 판정", ""]
    lines.append("- 외부: **%s** (Major %d)" % (norm["status"], norm["major"]))
    lines.append("- 내장 리뷰: **%s**" % got["effort"])
    if got["audit_run"]:
        lines.append("- **감사 런이다**")
    lines += [""] + ["- %s" % r for r in got["reasons"]]
    if not got["skip"]:
        lines += ["", "`/code-review --effort %s` 를 그대로 부른다. "
                      "**effort 를 네가 고르지 마라.**" % got["effort"]]
    if norm.get("human_comments"):
        lines += ["", "사람 코멘트 %d 건은 **수리 대상이 아니라 보고 대상**이다."
                  % len(norm["human_comments"])]
    return "\n".join(lines)


# --------------------------------------------------------------------- promote

def cmd_promote(root, args):
    return st.emit(run_promote(root, scan=args.scan, stage=args.stage,
                               apply=args.apply, flush=args.flush,
                               verdict_file=args.verdict_file,
                               run_id=args.run_id))


def run_promote(root, scan=False, stage=False, apply=False, flush=False,
                verdict_file=None, run_id=None):
    """승격. 종료 코드 **0 / 4 / 6 / 8** (네 플래그가 한 행을 공유한다).

    명세는 `--apply` 단독의 종료 코드를 따로 적지 않았다 — **명세 미규정이고,
    여기서는 판정 위반을 8, 자동 쓰기 차단을 10 으로 쓴다.**
    """
    import promote as pm

    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("promote", False, 3, None, {},
                           "런이 없다. `init --feature` 로 시작한다.", None)
    if s.get("escalated"):
        return _escalation_envelope("promote", paths, s)

    if not (scan or stage or apply or flush):
        return st.envelope("promote", False, 2, s, {},
                           "플래그가 필요하다: --scan / --stage / --apply / --flush",
                           None)

    scanned = pm.scan(root)

    if flush:
        promos = s.setdefault("promotions", [])
        n = pm.flush(promos)
        st.save(paths, s)
        return st.envelope("promote", True, 0, s,
                           {"flushed": n, "promotions": promos},
                           "잔여 승격 %d 건을 `skipped` 로 종결했다 — 임계가 다시 "
                           "충족되면 다음 런에서 재승격 후보가 된다." % n, None)

    if scan or stage:
        promos = pm.stage(scanned["candidates"])
        s["promotions"] = promos
        st.save(paths, s)
        data = dict(scanned, promotions=promos)
        return st.envelope("promote", True, 0, s, data,
                           _promote_scan_render(scanned),
                           None if not scanned["needs_model"] else
                           "python scripts/pipeline/cli.py promote --apply "
                           "--verdict-file {07_promo_verdict.json} --run-id %s"
                           % s["run_id"])

    # --- apply
    if not verdict_file:
        return st.envelope("promote", False, 2, s, {},
                           "`--apply` 는 판정 파일이 필요하다: --verdict-file",
                           None)
    vf = Path(verdict_file)
    if not vf.exists():
        return st.envelope("promote", False, 3, s, {},
                           "판정 파일이 없다: %s" % vf, None)
    try:
        payload = harness._read_json(vf)
    except (OSError, ValueError) as exc:
        return st.envelope("promote", False, 8, s, {},
                           "JSON 을 읽지 못했다: %s" % exc, None)
    verdicts = payload.get("verdicts") or []

    staged_now = s.get("promotions") or pm.stage(scanned["candidates"])
    errors, blocked = pm.check_verdicts(root, verdicts, staged_now)
    if blocked:
        st.escalate(paths, s,
                    "승격 판정이 `contradicts` 다 — 기존 규칙과 싸운다",
                    options=["규칙을 사람이 조정한 뒤 재개",
                             "이 승격을 포기하고 진행", "중단"],
                    phase="07-pr-review")
        st.save(paths, s)
        return _escalation_envelope("promote", paths, s)
    if errors:
        return st.envelope("promote", False, 8, s, {"errors": errors},
                           "\n".join(["## 승격 판정이 규약을 어겼다", ""]
                                     + ["- %s" % e for e in errors]),
                           None)

    promos = staged_now
    promos, rows = pm.apply(root, s["run_id"], promos, verdicts)
    s["promotions"] = promos
    written = pm.changelog_append(root, rows)

    out = paths.run_dir / "07_promo_applied.json"
    _write_json(out, pm.applied_payload(s["run_id"], promos, rows, scanned))

    st.append_event(paths, "promoted", cmd="promote", phase="07-pr-review",
                    applied=sum(1 for p in promos if p["status"] == "applied"),
                    rejected=sum(1 for p in promos if p["status"] == "rejected"))
    st.save(paths, s)
    return st.envelope("promote", True, 0, s,
                       {"promotions": promos, "changelog_rows": written},
                       _promote_apply_render(promos, written), None)


def _promote_scan_render(got):
    if not got["candidates"]:
        lines = ["승격 후보가 없다 — **모델을 부르지 않고 종결한다.**", ""]
        if got["held"]:
            lines.append("다만 누적은 넘었는데 `distinct_runs` 에서 막힌 것이 "
                         "%d 건 있다:" % len(got["held"]))
            lines += ["- %s (%s)" % (h["category"], h["held_because"])
                      for h in got["held"]]
        else:
            lines.append("원장이 본 런은 %d 개다. 임계에 닿을 표본이 아직 "
                         "없다는 뜻이지 지적이 없었다는 뜻이 아니다."
                         % got["distinct_runs"])
        return "\n".join(lines)
    lines = ["## 승격 후보 %d 건" % len(got["candidates"]), ""]
    for c in got["candidates"]:
        lines.append("- **%s** (%s) — %d회 / %d런 · 목적지 `%s`"
                     % (c["category"], c["severity"], c["count"],
                        c["distinct_runs"], c.get("enforceable")))
    lines += ["", "각각에 `create` / `amend` / `skip` 판정을 내고 근거를 적는다.",
              "**`duplicate` 면 `create` 가 금지되고, `contradicts` 면 자동 "
              "쓰기가 차단된다.**"]
    return "\n".join(lines)


def _promote_apply_render(promos, written):
    by = {}
    for p in promos:
        by[p["status"]] = by.get(p["status"], 0) + 1
    lines = ["## 승격 적용", "",
             " · ".join("%s %d" % (k, v) for k, v in sorted(by.items())),
             "", "`rules_changelog.md` 에 %d 줄을 남겼다." % written]
    rejected = [p for p in promos if p["status"] == "rejected"]
    if rejected:
        lines += ["", "**거절된 것:**"]
        lines += ["- %s — %s" % (p["rule_id"], p["reason"]) for p in rejected]
    lines += ["", "승격은 **별도 브랜치**로 간다. 기능 PR 에 섞지 않는다."]
    return "\n".join(lines)


# -------------------------------------------------------------------------- pr

def cmd_pr(root, args):
    return st.emit(run_pr(root, args.run_id))


def run_pr(root, run_id=None):
    """06 의 6단계. **비용 오름차순이고 첫 실패에서 멈춘다.**

    명세는 06 의 절차를 페이즈로만 기술하고 어느 커맨드가 그것을 집행하는지
    정하지 않았다 (CLI 표에 `pr` 행이 없다). `approve` 가 별도 커맨드인 것과
    같은 형태로 여기 둔다 — **명세 미규정이고, 그렇게 표기한다.**
    """
    import pr as pr_mod

    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("pr", False, 3, None, {},
                           "런이 없다. `init --feature` 로 시작한다.", None)
    if s.get("escalated"):
        return _escalation_envelope("pr", paths, s)

    config, adapter, _cal = adapters.load(root)
    data = {}

    # 1. 브랜치 — 규약과 보호. **자동 생성하지 않는다.**
    ok, branch, msg = pr_mod.check_branch(root, config)
    data["branch"] = {"ok": ok, "name": branch, "message": msg}
    if not ok:
        return st.envelope("pr", False, 3, s, data,
                           "\n".join(["## 브랜치가 맞지 않는다", "", msg, "",
                                      "**브랜치를 자동으로 만들지 않는다.**"]),
                           None)

    # 2. 백그라운드 전체 회귀 조인 (04 의 join_before: 06-pr)
    join = pr_mod.join_pending(s)
    data["join"] = join
    if join.get("blocked"):
        return st.envelope("pr", False, 3, s, data,
                           "\n".join(["## 회귀가 아직 안 끝났다", "",
                                      join["reason"], "",
                                      "끝나기 전에 push 하지 않는다."]), None)

    # 3. 원격 상태 — 없으면 §P3 3지선다, non-FF 면 에스컬레이션
    rs = pr_mod.remote_state(root, config, branch)
    data["remote"] = rs
    if not rs["has_remote"]:
        return st.envelope("pr", False, 9, s, data, _no_remote_render(rs), None)
    if rs["non_ff"]:
        st.escalate(paths, s,
                    "원격 브랜치가 non-fast-forward 다 (%d 커밋 앞섬)"
                    % rs.get("behind", 0),
                    options=["원격을 로컬로 가져와 머지한 뒤 재개",
                             "원격 브랜치를 사람이 정리한 뒤 재개",
                             "중단"],
                    phase="06-pr")
        st.save(paths, s)
        return _escalation_envelope("pr", paths, s)

    # 4. 승인 — 없거나 철회됐으면 exit 9, 지문이 어긋나면 exit 6
    node = (s.get("approval") or {}).get("06") or {}
    if not node.get("granted"):
        return st.envelope("pr", False, 9, s, data,
                           _approval_prompt(root, s, rs, branch, config), None)
    fresh = st.fingerprint(root, config)
    if not st.fingerprint_matches(node.get("fingerprint") or {}, fresh):
        return st.envelope("pr", False, 6, s,
                           dict(data, saved=node.get("fingerprint"),
                                fresh=fresh),
                           "\n".join([
                               "## 승인이 무효가 됐다", "",
                               "승인 뒤에 소스가 바뀌었다. 그 승인은 **다른 "
                               "코드에 대한 것**이므로 재승인이 필요하다.", "",
                               "재승인: `python scripts/pipeline/cli.py "
                               "approve --phase 06 --run-id %s`" % s["run_id"]]),
                           None)

    # 5. 본문 조립 + 마스킹
    body = pr_mod.build_body(root, paths, s, config)
    body_path = paths.run_dir / "06_pr_body.md"
    body_path.parent.mkdir(parents=True, exist_ok=True)
    # §E4 — 산출물은 UTF-8 을 명시한다. 한글 식별자가 흔한 리포다.
    body_path.write_text(body, encoding="utf-8")
    data["body_file"] = paths.rel(body_path)

    # 6. 계약 삭제 → push → 요청서.
    # **삭제가 push 직전인 것이 요점이다** — 04 귀속과 05 대조가 계약을 계속
    # 읽으므로 그 전에 지우면 재개가 깨진다 (§E13).
    removed = _drop_contract(root, paths, s, build_context(root, paths, s))
    data["contract_removed"] = removed

    pushed = pr_mod.push(root, config, branch)
    data["push"] = pushed
    if not pushed["ok"]:
        st.escalate(paths, s, "push 가 실패했다 — 원격 ref 조회로 확인했다",
                    options=[pushed.get("detail") or "상세 없음"], phase="06-pr")
        st.save(paths, s)
        return _escalation_envelope("pr", paths, s)

    s.setdefault("pr", {}).update({
        "head": branch, "pushed": True, "pushed_at": st.stamp(),
        "remote": rs["remote"],
    })
    req = pr_mod.build_request(s, config, branch, paths.rel(body_path),
                              rs["remote"])
    req_path = paths.run_dir / "06_pr_req.json"
    _write_json(req_path, req)
    data["pr_req"] = paths.rel(req_path)

    st.append_event(paths, "pr_pushed", cmd="pr", phase="06-pr",
                    branch=branch, remote=rs["remote"])
    st.save(paths, s)
    return st.envelope("pr", True, 0, s, data, _pr_render(req, paths, req_path),
                       "python scripts/pipeline/cli.py record --phase 06 "
                       "--file {06_pr_result.json} --run-id %s" % s["run_id"])


def _drop_contract(root, paths, s, ctx):
    """계약 파일을 지운다. 없으면 없는 대로 사실을 남긴다.

    경로는 `state.contract.path` 를 먼저 보고, 없으면 `${run.contract_file}`
    로 낙하한다 — **계약 경로의 단일 출처는 후자**이고, 상태에 그 값이 안 실린
    런에서도 계약이 남지 않아야 한다. 남으면 다음 런이 남의 계약을 읽는다.
    """
    if (s.get("contract") or {}).get("mode") == "no_contract":
        return {"removed": False, "reason": "계약이 없다 (no_contract)"}
    rel = (s.get("contract") or {}).get("path") or resolve(
        "${run.contract_file}", ctx)
    if not rel:
        return {"removed": False, "reason": "계약 경로를 알 수 없다"}
    p = Path(root) / rel
    if not p.exists():
        return {"removed": False, "reason": "이미 없다", "path": rel}
    p.unlink()
    return {"removed": True, "path": rel}


def _no_remote_render(rs):
    return "\n".join([
        "## 원격이 없다 — 사람이 정한다",
        "",
        "`%s` 원격을 찾지 못했다. **자동으로 원격을 만들거나 브랜치를 만들지 "
        "않는다.**" % rs["remote"],
        "",
        "① 원격을 붙이고 재개",
        "② 로컬 커밋까지만 하고 종료 (등급 `PASS_WITH_GAPS`)",
        "③ 중단",
    ])


def _approval_prompt(root, s, rs, branch, config):
    """§3.6 의 승인 프로토콜. 마지막 줄이 범위를 못박는다."""
    import precheck as pc

    got = pc.run(root, scope="pr")
    b = got["budget"]
    r05 = s.get("review05") or {}
    gaps = s.get("gaps") or []
    skipped = [g for g in gaps if g.startswith("stage_absent:")] or ["없음"]
    return "\n".join([
        "## PR 생성 승인 요청",
        "",
        "%s  %s → %s      %d파일 / %d라인 (%s)"
        % (rs["remote"], branch,
           (config.get("vcs") or {}).get("base_branch") or "main",
           b["files"], b["lines"],
           "예산 내" if got["exit"] == 0 else "**예산 밖**"),
        "게이트: 스킵된 스테이지 %s" % ", ".join(skipped),
        "05: 리뷰어 %s/%s · Major %s"
        % (r05.get("reviewers_ok", "?"), r05.get("reviewers_planned", "?"),
           r05.get("major", "?")),
        "완료 등급 예상: %s%s"
        % (s.get("grade") or "미정",
           (" (" + ", ".join(gaps) + ")") if gaps else ""),
        "승인 범위: push + PR 생성.  07 코멘트 게시는 등급 재확인 후.  "
        "머지는 포함하지 않습니다.",
        "",
        "→ python scripts/pipeline/cli.py approve --phase 06 --run-id %s"
        % s["run_id"],
    ])


def _pr_render(req, paths, req_path):
    return "\n".join([
        "## push 완료 — 이제 PR 은 네가 만든다",
        "",
        "`%s` 를 읽고 **forge 도구로** PR 을 %s 한다."
        % (paths.rel(req_path),
           "갱신" if req["action"] == "update" else "생성"),
        "본문은 `%s` 다 — **이미 마스킹을 거쳤으니 다시 조립하지 마라.**"
        % req["body_file"],
        "",
        "- head: `%s` → base: `%s`" % (req["head"], req["base"]),
        "- 이미 있는 PR 이면 **생성하지 말고 갱신한다** (번호가 갈라진다)",
        "- **머지하지 마라.** 이 파이프라인의 범위는 PR 까지다",
        "",
        "끝나면 PR 번호와 상태를 `06_pr_result.json` 으로 내고 "
        "`record --phase 06` 을 부른다.",
    ])


# ------------------------------------------------------------------------ mask

def cmd_mask(root, args):
    return st.emit(run_mask(root, args.file, args.out, args.run_id))


def run_mask(root, file, out, run_id=None):
    """외부로 나가는 페이로드를 마스킹한다. 종료 코드 **0 / 1**.

    런이 없어도 돈다 — 06 이전에 본문 초안을 확인할 수 있어야 한다.
    실패가 exit 1(내부 오류)인 것은 명세의 CLI 표가 그렇게 정한다: 가리지
    못한 채로 내보내느니 멈추는 쪽이다.
    """
    import mask as mask_mod

    root = Path(root)
    paths, s = st.load(root, run_id)
    got = mask_mod.mask_file(root, file, out)
    ok = bool(got.get("ok"))
    if s is not None and ok:
        # 비밀 파일 부재는 **원장에 기록한다** — 경고이지 실패가 아니지만
        # "그때 패턴만 걸렸다"를 나중에 알 수 있어야 한다 (§8.2 06 마지막 행).
        st.append_event(paths, "stage_done", cmd="mask", phase=s.get("phase"),
                        hits=got["hits"],
                        secret_files_missing=got["secret_files_missing"])
        st.save(paths, s)
    return st.envelope("mask", ok, 0 if ok else 1, s, got,
                       _mask_render(got), None)


def _mask_render(got):
    if not got.get("ok"):
        return "\n".join([
            "## 마스킹 실패", "",
            got.get("error") or "알 수 없는 오류", "",
            "가리지 못한 채로 내보내지 않는다."])
    lines = ["`mask` 완료 — %d 곳을 가렸다." % got["hits"]]
    by = got.get("by_source") or {}
    if by:
        lines.append("출처별: " + " · ".join(
            "%s %d" % (k, v) for k, v in sorted(by.items()) if v))
    if got.get("secret_files_missing"):
        lines.append("")
        lines.append("**비밀 파일이 없어 패턴만 적용했다** (%s) — 경고이지 "
                     "실패가 아니다. 원장에 남겼다."
                     % ", ".join(got["secret_files_missing"]))
    return "\n".join(lines)


# --------------------------------------------------------------- contract-trace

def cmd_contract_trace(root, args):
    return st.emit(run_contract_trace(root, args.contract, args.run_id))


def run_contract_trace(root, contract=None, run_id=None):
    """계약 ↔ 코드 대조. **05 에서 두 번째로 도는 무료 검사다.**

    모델을 한 번도 부르지 않는다. 여기서 잡히는 것을 리뷰어에게 보내면 리뷰어가
    같은 것을 다시 발견하는 데 돈을 쓴다.

    exit 8 은 **Critical 이 남았다**는 뜻이고 "리뷰어를 부르기 전에 고쳐라"다.
    """
    import trace_contract

    root = Path(root)
    paths, s = st.load(root, run_id)
    if s is None:
        return st.envelope("contract-trace", False, 3, None, {}, "런이 없다.", None)
    if s.get("escalated"):
        return _escalation_envelope("contract-trace", paths, s)

    config, adapter, _cal = adapters.load(root)
    ctx = build_context(root, paths, s)
    no_contract = (s.get("contract") or {}).get("mode") == "no_contract"
    rel = contract or resolve("${run.contract_file}", ctx)
    full = root / rel
    if not no_contract and not full.exists():
        return st.envelope("contract-trace", False, 3, s, {"contract": str(rel)},
                           "계약 파일이 없다: %s — `no_contract` 런이면 "
                           "state.contract.mode 가 그렇게 적혀 있어야 한다" % rel,
                           None)

    got = trace_contract.run(root, config, adapter,
                             None if no_contract else full,
                             no_contract=no_contract)
    out = paths.run_dir / "05_trace.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(got, indent=2, ensure_ascii=False) + "\n",
                   encoding="utf-8")

    s.setdefault("phases", {}).setdefault("05-code-review", {})["trace"] = {
        "status": got["status"], "blocking": got.get("blocking", 0),
        "skipped": got.get("skipped") or []}
    st.append_event(paths, "submit_received", cmd="contract-trace",
                    phase="05-code-review", file=paths.rel(out))
    st.save(paths, s)

    exit_ = 8 if got.get("blocking") else 0
    return st.envelope("contract-trace", exit_ == 0, exit_, s, got,
                       _trace_render(got, rel),
                       None if exit_ else
                       "python scripts/pipeline/cli.py record --phase 05 "
                       "--file <리뷰 json> --reviewer <code> --run-id %s" % s["run_id"])


def _trace_render(got, rel):
    if got["status"] == "skipped_no_contract":
        return ("## 계약 대조 — 수행하지 않았다\n\n"
                "`no_contract` 런이다. 계약이 없으므로 대조할 것이 없고, "
                "**이것은 통과가 아니라 미수행이다** — 보고서가 그렇게 적는다.")
    lines = ["## 계약 대조 (`%s`)" % rel, ""]
    lines.append("검사 %d종 수행 · 지적 %d건"
                 % (len(got["checks_run"]), len(got["findings"])))
    if got.get("skipped"):
        lines.append("**건너뛴 검사**: %s — 통과가 아니라 미수행이다. "
                     "어댑터에 `entrypoint_resolver` 가 없다."
                     % ", ".join("`%s`" % s for s in got["skipped"]))
    warn_only = [f for f in got["findings"] if f.get("resolution") == "warn_only"]
    if warn_only:
        lines.append("`warn_only` %d건 — baseline 기간이라 지적으로 올리지 않는다. "
                     "보고서에는 남는다." % len(warn_only))
    blocking = [f for f in got["findings"]
                if f["severity"] == "critical" and f.get("resolution") != "warn_only"]
    if blocking:
        lines += ["", "### 리뷰어를 부르기 전에 고칠 것 (Critical %d건)" % len(blocking)]
        for f in blocking:
            lines.append("- `%s` → **%s**: %s"
                         % (f["code"], f["target_role"], f["title"]))
        lines += ["", "고친 뒤 `gate --phase 04 --stage scoped` 로 재게이트하고 "
                      "이 명령을 다시 친다."]
    else:
        lines += ["", "Critical 0건. 리뷰어 라우팅으로 넘어간다."]
    return "\n".join(lines)


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

    sp = sub.add_parser("report", add_help=False)
    sp.add_argument("--out", dest="out", default=None)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("review07", add_help=False)
    sp.add_argument("--external", dest="external", default=None)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("promote", add_help=False)
    sp.add_argument("--scan", dest="scan", action="store_true")
    sp.add_argument("--stage", dest="stage", action="store_true")
    sp.add_argument("--apply", dest="apply", action="store_true")
    sp.add_argument("--flush", dest="flush", action="store_true")
    sp.add_argument("--verdict-file", dest="verdict_file", default=None)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("pr", add_help=False)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("approve", add_help=False)
    sp.add_argument("--phase", dest="phase", default="06", choices=["06"])
    sp.add_argument("--revoke", dest="revoke", action="store_true")
    sp.add_argument("--auto", dest="auto", action="store_true")
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("mask", add_help=False)
    sp.add_argument("--file", dest="file", required=True)
    sp.add_argument("--out", dest="out", required=True)
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("precheck", add_help=False)
    sp.add_argument("--scope", dest="scope", default="pr",
                    choices=["pr"])
    sp.add_argument("--phase", dest="phase", default="05", choices=["05", "06"])
    sp.add_argument("--run-id", dest="run_id", default=None)

    sp = sub.add_parser("contract-trace", add_help=False)
    sp.add_argument("--contract", dest="contract", default=None)
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
    "contract-trace": cmd_contract_trace,
    "precheck": cmd_precheck,
    "mask": cmd_mask,
    "approve": cmd_approve,
    "pr": cmd_pr,
    "promote": cmd_promote,
    "review07": cmd_review07,
    "report": cmd_report,
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
