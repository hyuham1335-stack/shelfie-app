#!/usr/bin/env python3
"""`precheck` — 05 의 첫 검사이고 무료다.

예산 · 브랜치 · base divergence · 인프라를 정적으로 본다. 모델을 부르지 않고
러너도 돌리지 않는다. **뒤에서 되돌릴 일을 여기서 먼저 잡는다.**

종료 코드가 둘로 갈리는 것이 요점이다:

- **exit 9** — 사용자 판단 대기. 상태를 잠그지 않는다. 예산 초과·브랜치
  불일치·base behind 가 여기다. **자동 분할도 자동 리베이스도 하지 않는다** —
  범위와 히스토리는 사람의 것이다.
- **exit 10** — 인프라 실패. 상태를 잠그고, **카운터를 소모하지 않는다** (§E9).
  프로브가 실패한 채로 전체 회귀를 돌리면 한꺼번에 빨간불이 되고, 그것을
  코드 문제로 읽게 된다.

§E13 이 **재개 시 재검사를 필수**로 두므로 이 함수는 05 진입에서 한 번,
06 에서 다시, 재개마다 또 불린다. 그래서 싸야 한다.
"""

import os
import socket
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

import harness  # noqa: E402
import adapters  # noqa: E402


def run(root, scope="pr", changed=None, config=None, adapter=None):
    """반환: {"exit", "checks":[...], "budget":{...}, "classification", ...}

    `classification` 은 실패 3분류의 어휘다 — `policy` / `infra` / None.
    """
    root = Path(root)
    if config is None or adapter is None:
        config, adapter, _cal = adapters.load(root)

    checks = []
    if changed is None:
        changed = changed_files(root)

    budget = _check_budget(root, config, changed, checks)
    _check_branch(root, config, checks)
    _check_divergence(root, config, checks)
    infra = _check_infra(adapter, changed, checks)

    policy_failed = [c for c in checks if not c["ok"] and c["kind"] == "policy"]
    if infra:
        return _result(10, checks, budget, "infra", changed,
                       counter_consumed=False, infra=infra)
    if policy_failed:
        return _result(9, checks, budget, "policy", changed,
                       counter_consumed=True)
    return _result(0, checks, budget, None, changed, counter_consumed=False)


def _result(exit_, checks, budget, classification, changed, counter_consumed,
            infra=None):
    return {"exit": exit_, "checks": checks, "budget": budget,
            "classification": classification,
            "counter_consumed": counter_consumed,
            "changed_count": len(changed),
            "infra_failures": infra or [],
            "note": ("인프라 실패는 카운터를 소모하지 않는다 — 코드가 아니라 "
                     "환경의 문제이므로 재시도 예산을 태울 이유가 없다."
                     if classification == "infra" else
                     "예산·브랜치·divergence 는 사람이 판단한다. 자동으로 "
                     "쪼개거나 리베이스하지 않는다.")}


def _add(checks, name, ok, kind, message=""):
    checks.append({"name": name, "ok": ok, "kind": kind, "message": message})


# ------------------------------------------------------------------- 변경 집합

def changed_files(root):
    """미커밋 변경 + 새 파일. **새 파일을 빼면 예산이 사실보다 작게 잡힌다.**

    `git diff` 는 추적되지 않는 파일을 못 본다 — 안 보는 것이지 없는 것이
    아니다. 03 이 방금 만든 파일이 정확히 그 상태다.
    """
    out = set()
    # `-uall` 이 없으면 git 이 **새 디렉터리를 한 줄로 뭉친다**(`?? src/x/`).
    # 그러면 파일 열 개짜리 새 폴더가 예산에 1 로 잡히고, 03 이 만든 새
    # 모듈이 정확히 그 형태다 — 예산이 사실보다 작게 잡히는 경로다.
    r = harness._git(root, "status", "--porcelain", "-uall")
    if r is not None and r.returncode == 0:
        for line in r.stdout.splitlines():
            if len(line) > 3:
                out.add(line[3:].strip().strip('"').replace("\\", "/"))
    return sorted(out)


def _changed_lines(root, changed):
    """추적분은 `git diff --numstat`, 새 파일은 줄 수를 직접 센다."""
    total = 0
    r = harness._git(root, "diff", "--numstat", "HEAD")
    counted = set()
    if r is not None and r.returncode == 0:
        for line in r.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) == 3:
                add, dele, path = parts
                counted.add(path.strip().replace("\\", "/"))
                for n in (add, dele):
                    if n.isdigit():
                        total += int(n)
    for rel in changed:
        if rel in counted:
            continue
        p = Path(root) / rel
        try:
            total += len(p.read_text(encoding="utf-8").splitlines())
        except (OSError, UnicodeDecodeError):
            continue
    return total


# --------------------------------------------------------------------- 검사들

def _check_budget(root, config, changed, checks):
    budget = config.get("budget") or {}
    files, lines = len(changed), _changed_lines(root, changed)
    over = []
    if budget.get("files_max") and files > budget["files_max"]:
        over.append("파일 %d > %d" % (files, budget["files_max"]))
    if budget.get("lines_max") and lines > budget["lines_max"]:
        over.append("줄 %d > %d" % (lines, budget["lines_max"]))
    _add(checks, "예산", not over, "policy",
         ("범위가 예산을 넘었다 (%s). **자동으로 쪼개지 않는다** — 나눌지 "
          "그대로 갈지는 사람이 정한다." % ", ".join(over)) if over else
         "파일 %d · 줄 %d" % (files, lines))
    return {"files": files, "lines": lines,
            "files_max": budget.get("files_max"),
            "lines_max": budget.get("lines_max")}


def _check_branch(root, config, checks):
    vcs = config.get("vcs") or {}
    r = harness._git(root, "rev-parse", "--abbrev-ref", "HEAD")
    branch = r.stdout.strip() if r is not None and r.returncode == 0 else None
    if branch is None:
        _add(checks, "브랜치", True, "policy", "git 이 답하지 못했다 — 검사를 건너뛴다")
        return
    if branch in (vcs.get("protected") or []):
        _add(checks, "브랜치", False, "policy",
             "보호 브랜치 %r 위에서 작업 중이다. **브랜치를 자동으로 만들지 "
             "않는다** — 어디서 갈라질지는 사람이 정한다." % branch)
        return
    pattern = vcs.get("branch_pattern")
    if pattern:
        import re
        if not re.match(pattern, branch):
            _add(checks, "브랜치", False, "policy",
                 "브랜치 %r 이 규약 %r 과 맞지 않는다" % (branch, pattern))
            return
    _add(checks, "브랜치", True, "policy", branch)


def _check_divergence(root, config, checks):
    """base 가 앞서 있으면 멈춘다. **자동 리베이스 금지.**"""
    base = (config.get("vcs") or {}).get("base_branch")
    if not base:
        _add(checks, "base", True, "policy", "base 브랜치가 설정에 없다")
        return
    r = harness._git(root, "rev-list", "--left-right", "--count",
                     "%s...HEAD" % base)
    if r is None or r.returncode != 0:
        _add(checks, "base", True, "policy",
             "base %r 을 찾지 못했다 — 그린필드일 수 있다. 06 이 다시 본다" % base)
        return
    parts = r.stdout.split()
    behind = int(parts[0]) if parts and parts[0].isdigit() else 0
    ahead = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    if behind:
        _add(checks, "base", False, "policy",
             "base(%s) 가 %d 커밋 앞서 있다. **자동으로 리베이스하지 않는다** — "
             "머지할지 리베이스할지는 사람이 정한다." % (base, behind))
        return
    _add(checks, "base", True, "policy", "%s 대비 +%d" % (base, ahead))


def _check_infra(adapter, changed, checks):
    """`required_when_touched` 에 걸린 프로브만 실행한다.

    안 건드린 영역의 프로브까지 요구하면 키 하나 없다고 온 파이프라인이
    멈춘다. 반대로 건드렸는데 프로브를 건너뛰면 전체 회귀가 한꺼번에
    빨간불이 되고 그것을 코드 문제로 읽게 된다 (§E9).
    """
    failures = []
    for probe in adapter.get("infra_preflight") or []:
        touched = probe.get("required_when_touched")
        if touched and not any(harness.glob_any(touched, c) for c in changed):
            continue
        ok, detail = _probe(probe)
        # detail 에 값은 절대 싣지 않는다 — precheck 결과는 원장·보고서로 가고
        # 그것들은 리포에 남는다. 존재 여부만 남긴다.
        _add(checks, "인프라:%s" % probe.get("name"), ok, "infra", detail)
        if not ok:
            failures.append({"name": probe.get("name"), "kind": probe.get("kind"),
                             "detail": detail})
    return failures


def _probe(probe):
    kind = probe.get("kind")
    if kind == "env":
        var = probe.get("var") or ""
        present = bool(os.environ.get(var))
        return present, ("환경변수 %s 가 설정돼 있다" % var if present else
                         "환경변수 %s 가 없다 — 이 영역을 건드렸으므로 회귀가 "
                         "환경 때문에 실패한다" % var)
    if kind == "tcp":
        host, port = probe.get("host") or "127.0.0.1", probe.get("port")
        try:
            with socket.create_connection((host, int(port)), timeout=2):
                return True, "%s:%s 에 붙었다" % (host, port)
        except (OSError, TypeError, ValueError):
            return False, "%s:%s 에 붙지 못했다" % (host, port)
    if kind == "cmd":
        return (harness._resolve_bin(Path.cwd(), probe.get("bin") or "") is not None,
                "실행 파일 %r" % probe.get("bin"))
    return True, "알 수 없는 프로브 종류 %r — 건너뛴다" % kind
