#!/usr/bin/env python3
"""`contract-trace` — 계약이 말한 것이 코드에 실제로 있는가.

**05 에서 두 번째로 도는 검사이고 무료다.** 리뷰어를 부르기 전에 여기서 잡으면
뒤에서 되돌릴 일이 없다. 모델을 한 번도 부르지 않는다.

검사는 다섯이다:

| 코드 | 무엇 | 심각도 |
|---|---|---|
| `missing_impl`            | 계약의 유닛이 소스에 있는가        | critical |
| `missing_error_symbol`    | 오류 어휘 상수가 실재하는가        | critical |
| `missing_entrypoint`      | 진입점이 실재하는가                | critical |
| `untested_contract_item`  | 그 유닛을 참조하는 테스트가 있는가 | major (첫 3런 warn_only) |
| `out_of_contract`         | 계약에 없는 신규 public 심볼      | major (첫 3런 warn_only) |

**파일명이 `trace.py` 가 아닌 이유**: 이 패키지는 `sys.path` 에 자기 디렉터리를
넣으므로 모듈 이름이 프로세스 전역 최상위가 된다. `trace` 는 stdlib 모듈이고,
그 이름을 쓰면 stdlib 을 가린다.

**스킵을 통과로 적지 않는다.** `entrypoint_resolver` 가 없으면 그 검사만 빠지고
그 사실이 `skipped` 에 남는다. `no_contract` 런은 `skipped_no_contract` 다.
"""

import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

import harness  # noqa: E402
import contract as contract_mod  # noqa: E402
import ledger  # noqa: E402

CHECKS = ("missing_impl", "missing_error_symbol", "missing_entrypoint",
          "untested_contract_item", "out_of_contract")

# 오탐이 잦은 둘. 상위 계층 테스트로만 커버되거나 테스트가 심볼명을 직접 쓰지
# 않는 스타일일 수 있고, 생성 코드가 `out_of_contract` 오탐을 만든다.
BASELINE_CHECKS = ("untested_contract_item", "out_of_contract")

DEFAULT_BASELINE_RUNS = 3

# 계약 대조에서 나온 지적이 원장에 들어갈 때의 category.
# 계약과 코드가 어긋난 것은 "계약 결함"과 다르다 — 여기서는 코드가 계약을
# 아직 안 지킨 것이고, 계약 자체가 틀렸다는 판정은 리뷰어·사람의 몫이다.
CATEGORY = {
    "missing_impl": "BOUNDARY_VIOLATION",
    "missing_error_symbol": "BOUNDARY_VIOLATION",
    "missing_entrypoint": "BOUNDARY_VIOLATION",
    "untested_contract_item": "TEST_MISSING_FAILURE_PATH",
    "out_of_contract": "NAMING",
}

# 소스에서 밖으로 나가는 이름. 스택 지식이 아니라 **표기 관습**이라 코어에 둔다 —
# 어댑터가 이것을 덮고 싶으면 `attribution.public_symbol_regex` 로 준다.
#
# 첫 글자를 `[A-Za-z_$]` 로 쓰지 않는다. 그러면 **한글 식별자를 통째로 놓치고**,
# 이 리포처럼 비ASCII 식별자가 흔한 곳에서 검사가 조용히 아무것도 안 잡는다
# (§E4 가 인코딩에서 경고하는 것과 같은 자리다). `[^\W\d]` 는 유니코드 word
# 문자 중 숫자가 아닌 것이다.
_DEFAULT_PUBLIC = (r"^\s*export\s+(?:async\s+)?(?:function|const|class|type|"
                   r"interface|enum)\s+(?P<name>[^\W\d][\w$]*)")


def run(root, config, adapter, contract_path, no_contract=False, changed=None,
        baseline_runs=None):
    """다섯 검사를 돌린다. 반환은 그대로 `05_trace.json` 이 된다."""
    root = Path(root)
    if no_contract or not contract_path:
        # §E3. 계약이 없는 런은 정상 경로다. 다만 **통과가 아니다** —
        # 보고서가 "계약 대조가 없었다"고 말해야 한다.
        return {"status": "skipped_no_contract", "findings": [],
                "checks_run": [], "skipped": list(CHECKS),
                "entrypoint_resolver": None,
                "note": "계약이 없는 런이다. 계약 대조를 수행하지 않았다 — "
                        "통과가 아니라 미수행이다."}

    text = Path(contract_path).read_text(encoding="utf-8")
    parsed = contract_mod.parse(text, config)
    files = repo_files(root)

    resolver = (adapter.get("entrypoint_resolver") or {}).get("kind") or "none"
    baseline_runs = (baseline_runs if baseline_runs is not None
                     else _baseline_runs(config))
    in_baseline = ledger.in_baseline(root, baseline_runs)

    primary = config.get("primary_role") or "impl"
    test_role = _test_role(config)

    findings, checks_run, skipped = [], [], []

    checks_run.append("missing_impl")
    findings += _missing_impl(root, parsed, files, primary)

    checks_run.append("missing_error_symbol")
    findings += _missing_error_symbol(root, parsed, config, files, primary)

    if resolver == "none":
        skipped.append("missing_entrypoint")
    else:
        checks_run.append("missing_entrypoint")
        findings += _missing_entrypoint(adapter, parsed, files, primary)

    checks_run.append("untested_contract_item")
    findings += _untested(root, config, adapter, parsed, files, test_role)

    checks_run.append("out_of_contract")
    findings += _out_of_contract(root, adapter, parsed, changed, primary)

    for f in findings:
        if f["code"] in BASELINE_CHECKS and in_baseline:
            f["resolution"] = "warn_only"
            f["why_warn_only"] = (
                "baseline 기간이다 — 원장이 본 런이 %d 로 %d 에 못 미친다. "
                "오탐률을 보고 나서 승격한다 (미검증 상속값)."
                % (ledger.distinct_runs(root), baseline_runs))
        else:
            f.setdefault("resolution", "deferred")

    blocking = [f for f in findings
                if f["severity"] == "critical" and f["resolution"] != "warn_only"]
    return {
        "status": "ok",
        "findings": findings,
        "checks_run": checks_run,
        "skipped": skipped,
        "entrypoint_resolver": resolver,
        "baseline": {"in_baseline": in_baseline,
                     "distinct_runs": ledger.distinct_runs(root),
                     "baseline_runs": baseline_runs},
        "blocking": len(blocking),
        "contract": {"units": len(parsed.get("units") or []),
                     "entrypoints": len(parsed.get("entrypoints") or []),
                     "errors": len(parsed.get("errors") or []),
                     "dropped": parsed.get("dropped") or []},
        "note": ("Critical 은 리뷰어를 부르기 전에 선수리한다 — 계약과 코드가 "
                 "어긋난 채로 리뷰하면 리뷰어가 그것을 다시 발견하는 데 돈을 쓴다."),
    }


def repo_files(root):
    """추적 파일 **+ 아직 커밋되지 않은 새 파일.**

    `harness.list_files` 는 `git ls-files` 라서 추적 파일만 낸다. 05 가 도는
    시점은 03 이 방금 코드를 쓴 직후이고 **그 파일들은 아직 추적되지 않는다** —
    추적분만 보면 새로 만든 유닛이 전부 `missing_impl` 로 잡히고, 이 검사가
    가장 필요한 런에서 정확히 반대로 동작한다.

    무시 목록(`--exclude-standard`)은 존중한다. `_workspace/` 의 계약 파일이
    소스로 세어지면 안 된다.
    """
    files = set(harness.list_files(root))
    r = harness._git(root, "ls-files", "--others", "--exclude-standard")
    if r is not None and r.returncode == 0:
        files |= {line.strip().replace("\\", "/")
                  for line in r.stdout.splitlines() if line.strip()}
    return sorted(files)


def _baseline_runs(config):
    return ((config.get("review") or {}).get("baseline_runs")
            or DEFAULT_BASELINE_RUNS)


def _test_role(config):
    """테스트 파일을 소유한 역할. 없으면 primary 로 낙하한다."""
    for role in config.get("roles") or []:
        owns = role.get("owns") or []
        if any("test" in o or "spec" in o for o in owns):
            return role.get("id")
    return config.get("primary_role") or "impl"


def _finding(code, severity, role, title, **kw):
    out = {"code": code, "severity": severity, "target_role": role,
           "title": title, "category": CATEGORY[code], "source": "contract-trace"}
    out.update(kw)
    return out


# ------------------------------------------------------------- missing_impl

def _missing_impl(root, parsed, files, primary):
    """**컨테이너명 + 심볼명 쌍**으로 찾는다.

    심볼명만 보면 흔한 이름이 다른 파일에 있어 거짓 통과한다. 컨테이너를 리포의
    파일과 맞추지 못하면 통과가 아니라 `container_resolved: false` 로 낙하한다 —
    "못 찾았다"가 "없다"보다 약한 판정이지만 **침묵보다는 강하다.**
    """
    out = []
    for unit in parsed.get("units") or []:
        symbol = unit.get("symbol")
        src = contract_mod._source_for_container(unit.get("container"), files)
        if src is None:
            out.append(_finding(
                "missing_impl", "critical", primary,
                "계약의 유닛 %s 를 담을 파일을 찾지 못했다" % unit.get("raw"),
                container=unit.get("container"), symbol=symbol,
                container_resolved=False,
                evidence="컨테이너 %r 이 리포의 어느 파일과도 맞지 않는다"
                         % unit.get("container")))
            continue
        if not _has_symbol(root / src, symbol):
            out.append(_finding(
                "missing_impl", "critical", primary,
                "계약의 유닛 %s 가 소스에 없다" % unit.get("raw"),
                container=unit.get("container"), symbol=symbol, path=src,
                container_resolved=True,
                evidence="%s 에 %r 이 없다" % (src, symbol)))
    return out


def _has_symbol(path, symbol):
    if not symbol:
        return False
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return False
    return re.search(r"\b%s\b" % re.escape(symbol), text) is not None


# ------------------------------------------------------ missing_error_symbol

def _missing_error_symbol(root, parsed, config, files, primary):
    """오류 어휘 상수는 **리포 어디에든** 있으면 된다.

    유닛과 달리 계약이 그 상수가 어느 파일에 사는지 말하지 않는다. 그래서 여기만
    전역 검색이고, 그 대가로 흔한 이름에 약하다 — 다만 오류 상수는 대문자
    스네이크라 충돌 위험이 낮다.
    """
    out = []
    for name in parsed.get("errors") or []:
        if not _found_anywhere(root, files, name):
            out.append(_finding(
                "missing_error_symbol", "critical", primary,
                "계약의 오류 어휘 %s 가 소스에 없다" % name,
                symbol=name,
                evidence="리포의 어느 소스에도 %r 이 없다" % name))
    return out


def _found_anywhere(root, files, needle):
    rx = re.compile(r"\b%s\b" % re.escape(needle))
    for rel in files:
        p = Path(root) / rel
        if p.suffix not in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".py",
                            ".java", ".kt", ".go", ".rs"):
            continue
        try:
            if rx.search(p.read_text(encoding="utf-8")):
                return True
        except (OSError, UnicodeDecodeError):
            continue
    return False


# --------------------------------------------------------- missing_entrypoint

def _missing_entrypoint(adapter, parsed, files, primary):
    out = []
    for ep in parsed.get("entrypoints") or []:
        src = contract_mod._source_for_entrypoint(adapter, ep, files)
        if src is None:
            out.append(_finding(
                "missing_entrypoint", "critical", primary,
                "계약의 진입점 %s 가 실재하지 않는다" % ep.get("raw"),
                method=ep.get("method"), route=ep.get("path"),
                evidence="어댑터의 entrypoint_resolver 가 %r 을 파일로 해석하지 "
                         "못했다" % ep.get("path")))
    return out


# ---------------------------------------------------- untested_contract_item

def _untested(root, config, adapter, parsed, files, test_role):
    """심볼 문자열 **또는** 진입점 경로 — 둘 다 실패할 때만 지적한다 (§E6).

    커버리지 도구가 없는 상태에서 이 검사가 "테스트 약화" 탐지를 대신한다.
    """
    globs = (adapter.get("attribution") or {}).get("test_file_globs") or []
    tests = [f for f in files if harness.glob_any(globs, f)]
    blob = _concat(root, tests)
    out = []
    for unit in parsed.get("units") or []:
        symbol = unit.get("symbol")
        if not symbol:
            continue
        if re.search(r"\b%s\b" % re.escape(symbol), blob):
            continue
        link = _entrypoint_link(root, adapter, unit, parsed, files, blob)
        if link["covered"]:
            continue
        out.append(_finding(
            "untested_contract_item", "major", test_role,
            "계약의 유닛 %s 를 참조하는 테스트가 없다" % unit.get("raw"),
            symbol=symbol, container=unit.get("container"),
            entrypoint_link=link["state"],
            evidence="테스트 파일 %d개 어디에도 %r 이 없고, 이 유닛과 연결된 "
                     "진입점 경로도 없다 (진입점 연결: %s)"
                     % (len(tests), symbol, link["state"])))
    return out


def _entrypoint_link(root, adapter, unit, parsed, files, blob):
    """이 유닛이 **자기 진입점**의 경로 문자열로 커버되는가.

    반환: {"covered": bool, "state": "linked|unlinked|unresolved"}

    예전에는 `unit` 을 아예 안 읽고 "**아무** 진입점 경로가 blob 에 있는가"를
    답했다. 그래서 진입점 문자열 하나가 테스트 어딘가에 있으면 **전 유닛의
    지적이 억제됐다** — 사실상 이 검사가 꺼져 있었다 (G-2).

    연결은 한 홉까지 본다. 진입점이 해석한 파일이 ① 유닛의 컨테이너 파일이거나
    ② 그 파일 본문이 유닛의 심볼을 참조하면 연결이다. ②가 없으면 §E6 이
    진입점 폴백을 둔 이유(유닛이 라우트 핸들러가 **호출하는** 헬퍼인 경우)가
    사라진다.

    **해석에 실패하면 예전처럼 관대하게 낙하하되 그 사실을 남긴다.** 억제가
    침묵으로 일어나면 이 검사가 왜 조용한지 아무도 모른다.
    """
    symbol = unit.get("symbol") or ""
    container = (unit.get("container") or "").replace("\\", "/").lstrip("./")
    hit = None
    unresolved = False
    for ep in parsed.get("entrypoints") or []:
        path = ep.get("path")
        if not path or path not in blob:
            continue
        src = contract_mod._source_for_entrypoint(adapter, ep, files)
        if src is None:
            unresolved = True
            continue
        if container and (src == container or src.endswith("/" + container)):
            hit = src
            break
        try:
            text = (Path(root) / src).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            unresolved = True
            continue
        if symbol and re.search(r"\b%s\b" % re.escape(symbol), text):
            hit = src
            break
    if hit is not None:
        return {"covered": True, "state": "linked"}
    if unresolved:
        # 해석 실패는 "커버됐다" 가 아니다. 다만 왜 억제되지 않았는지 남긴다.
        return {"covered": False, "state": "unresolved"}
    return {"covered": False, "state": "unlinked"}


def _concat(root, rels):
    parts = []
    for rel in rels:
        try:
            parts.append((Path(root) / rel).read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
    return "\n".join(parts)


# ------------------------------------------------------------ out_of_contract

def _out_of_contract(root, adapter, parsed, changed, primary):
    """계약에 없는 신규 public 심볼.

    **변경된 파일만 본다.** 안 건드린 파일의 기존 심볼을 신규로 세면 리포 전체가
    지적이 되고, 그러면 이 검사는 첫 런에 꺼진다. `changed` 가 `None` 이면
    VCS 에 묻는다.
    """
    if changed is None:
        changed = _changed_files(root)
    if not changed:
        return []
    rx = re.compile(
        (adapter.get("attribution") or {}).get("public_symbol_regex")
        or _DEFAULT_PUBLIC, re.M)
    globs = (adapter.get("attribution") or {}).get("test_file_globs") or []

    known = contract_mod.symbols(parsed)
    out = []
    for rel in changed:
        if harness.glob_any(globs, rel):
            continue              # 테스트의 헬퍼는 계약의 대상이 아니다
        try:
            text = (Path(root) / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for m in rx.finditer(text):
            name = m.group("name")
            if name in known:
                continue
            out.append(_finding(
                "out_of_contract", "major", primary,
                "계약에 없는 public 심볼 %s 가 생겼다" % name,
                symbol=name, path=rel,
                evidence="%s 가 %r 을 내보내는데 계약이 그것을 말하지 않는다"
                         % (rel, name)))
    return out


def _changed_files(root):
    """base 대비 변경 + 미커밋. git 이 답하지 못하면 빈 목록이다.

    빈 목록은 "변경이 없다"가 아니라 **"모른다"** 이고, 그래서 이 검사가 조용히
    아무것도 못 잡는다. 호출부가 `changed` 를 명시적으로 주는 쪽이 정확하다.
    """
    out = []
    # `-uall` — 새 디렉터리를 한 줄로 뭉치면 그 안의 새 심볼을 통째로 놓친다.
    r = harness._git(root, "status", "--porcelain", "-uall")
    if r is not None and r.returncode == 0:
        for line in r.stdout.splitlines():
            if len(line) > 3:
                out.append(line[3:].strip().replace("\\", "/"))
    return sorted(set(out))
