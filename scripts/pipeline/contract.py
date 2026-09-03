#!/usr/bin/env python3
"""계약 파싱과 스코프 선택자 조립.

절 제목은 **코어의 것이 아니다.** `config.contract.sections` 가 단일 출처이고,
언어를 바꾸려면 그 값과 템플릿만 고치면 된다 — 이 파일에는 어느 언어의 제목도
박혀 있지 않다.

선택자는 **테스트 이름이 아니라 파일 경로**로 조립한다. 이름 필터는 러너가 모든
파일을 수집·변환하고 환경을 세운 *뒤에* 거르므로 비용을 줄이지 못한다. 이 리포의
실측에서 이름 필터는 전체 대비 100.2%, 경로 필터는 14.6%(6.8배 싸다)였다.
"""

import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

import harness  # noqa: E402

_BACKTICK = re.compile(r"`([^`]+)`")
_SEPARATORS = ("·", "::", "#", " > ")
_SYMBOL = re.compile(r"[A-Za-z_][\w$]*")
_METHOD_PATH = re.compile(r"^\s*(?P<method>[A-Z]+)\s+(?P<path>/\S*)")


def section(text, heading):
    """헤딩 줄부터 다음 `## ` 까지. 없으면 빈 문자열."""
    if not heading:
        return ""
    lines = text.splitlines()
    try:
        start = next(i for i, l in enumerate(lines) if l.strip() == heading)
    except StopIteration:
        return ""
    out = []
    for line in lines[start + 1:]:
        if line.startswith("## "):
            break
        out.append(line)
    return "\n".join(out)


def parse(text, config):
    """{units: [...], entrypoints: [...], errors: [...]}.

    각 유닛은 `{container, symbol, raw}` 다. **컨테이너와 심볼을 함께** 본다 —
    심볼명만 보면 흔한 이름이 다른 파일에서 거짓 통과한다.
    """
    sections = (config.get("contract") or {}).get("sections") or {}
    return {
        "units": _units(section(text, sections.get("units"))),
        "entrypoints": _entrypoints(section(text, sections.get("entrypoints"))),
        "errors": _errors(section(text, sections.get("errors"))),
    }


def symbols(parsed):
    """계약이 이름 붙인 것 전부. 귀속의 `in_contract` 판정이 쓴다."""
    out = set()
    for u in parsed.get("units") or []:
        if u.get("symbol"):
            out.add(u["symbol"])
    for e in parsed.get("errors") or []:
        out.add(e)
    return out


def _units(block):
    out = []
    for line in block.splitlines():
        if not line.strip().startswith("-"):
            continue
        spans = _BACKTICK.findall(line)
        if not spans:
            continue
        container, symbol = _split(spans[0])
        out.append({"container": container, "symbol": symbol, "raw": spans[0]})
    return out


def _split(span):
    for sep in _SEPARATORS:
        if sep in span:
            left, right = span.split(sep, 1)
            return left.strip(), _first_symbol(right)
    return None, _first_symbol(span)


def _first_symbol(text):
    m = _SYMBOL.search(text or "")
    return m.group(0) if m else None


def _entrypoints(block):
    out = []
    for line in block.splitlines():
        if not line.strip().startswith("-"):
            continue
        for span in _BACKTICK.findall(line) or [line.strip("- ").strip()]:
            m = _METHOD_PATH.match(span)
            if m:
                out.append({"method": m.group("method"), "path": m.group("path"),
                            "raw": span.strip()})
                break
    return out


def _errors(block):
    out = []
    for line in block.splitlines():
        if not line.strip().startswith("-"):
            continue
        for span in _BACKTICK.findall(line):
            name = _first_symbol(span)
            if name and name.isupper():
                out.append(name)
                break
    return out


# --------------------------------------------------------------- 선택자 조립

def test_selectors(root, config, adapter, parsed, repo_files=None):
    """계약 심볼 → 소스 경로 → **테스트 파일 경로**.

    반환: {"paths": [...], "unmatched": [...], "entrypoint_resolver": "..."}

    스택 지식은 전부 `adapter.attribution.test_file_globs` 라는 **데이터**에
    있다. 코어에 확장자도 네이밍 규칙도 없다.
    """
    files = repo_files if repo_files is not None else harness.list_files(root)
    tests = [f for f in files
             if harness.glob_any(
                 (adapter.get("attribution") or {}).get("test_file_globs") or [], f)]

    sources, unmatched = [], []
    for unit in parsed.get("units") or []:
        src = _source_for_container(unit.get("container"), files)
        if src:
            sources.append(src)
        else:
            unmatched.append({"kind": "unit", "raw": unit.get("raw"),
                              "why": "컨테이너를 리포의 파일과 맞추지 못했다"})

    resolver = (adapter.get("entrypoint_resolver") or {}).get("kind") or "none"
    for ep in parsed.get("entrypoints") or []:
        if resolver == "none":
            unmatched.append({"kind": "entrypoint", "raw": ep.get("raw"),
                              "why": "진입점 해석기가 없다 — 이 검사만 건너뛴다"})
            continue
        src = _source_for_entrypoint(adapter, ep, files)
        if src:
            sources.append(src)
        else:
            unmatched.append({"kind": "entrypoint", "raw": ep.get("raw"),
                              "why": "진입점을 파일로 해석하지 못했다"})

    paths = []
    for src in sources:
        for t in _tests_for_source(src, tests):
            if t not in paths:
                paths.append(t)
    return {"paths": sorted(paths), "unmatched": unmatched,
            "entrypoint_resolver": resolver}


def _source_for_container(container, files):
    """`lib/match.ts` → `src/lib/match.ts`. 접미사 일치로 실재를 확인한다."""
    if not container:
        return None
    needle = container.replace("\\", "/").lstrip("./")
    exact = [f for f in files if f == needle]
    if exact:
        return exact[0]
    suffix = [f for f in files if f.endswith("/" + needle)]
    return suffix[0] if len(suffix) == 1 else (suffix[0] if suffix else None)


def _source_for_entrypoint(adapter, ep, files):
    resolver = adapter.get("entrypoint_resolver") or {}
    for entry in resolver.get("map") or []:
        route, target = entry.get("route"), entry.get("file")
        if not route or not target:
            continue
        rx = re.compile("^" + re.escape(route).replace(r"\{p\}", "(?P<p>.+)") + "$")
        m = rx.match(ep.get("path") or "")
        if not m:
            continue
        candidate = target.replace("{p}", m.group("p"))
        if candidate in files:
            return candidate
    return None


def _tests_for_source(src, tests):
    """소스의 stem 으로 시작하는 테스트 파일 전부."""
    stem = Path(src).name.split(".")[0]
    return [t for t in tests if Path(t).name.split(".")[0] == stem]
