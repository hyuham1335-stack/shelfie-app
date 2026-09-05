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
    units, dropped = _units(section(text, sections.get("units")))
    return {
        "units": units,
        "dropped": dropped,
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
    """(유닛, 버려진 것). **들여쓴 불릿은 유닛이 아니다.**

    유닛은 최상위 불릿 하나에 하나다. 들여쓴 줄은 그 유닛의 정상·예외 서술이고,
    거기 백틱이 있다고 유닛으로 세면 설명이 많은 계약일수록 유닛이 부풀어
    프로파일 판정과 스코프 선택이 함께 오염된다.

    컨테이너와 심볼이 **둘 다** 없는 것도 유닛이 아니다 — 이 파서의 전제가
    컨테이너명+심볼명 쌍이기 때문이다. 다만 **조용히 버리지 않는다.** 무엇이 왜
    빠졌는지 둘째 반환값에 남는다.
    """
    out, dropped = [], []
    for line in block.splitlines():
        if not line.startswith("-"):
            continue
        spans = _BACKTICK.findall(line)
        if not spans:
            continue
        container, symbol = _split(spans[0])
        item = {"container": container, "symbol": symbol, "raw": spans[0]}
        if container and symbol:
            out.append(item)
        else:
            dropped.append(dict(item, reason="컨테이너명과 심볼명 쌍이 아니다"))
    return out, dropped


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
        got = _tests_for_source(root, src, tests, parsed)
        if not got:
            # **조용히 0경로를 기여하지 않는다.** 컨테이너는 풀렸는데 대응
            # 테스트가 없는 소스가 지금까지 `unmatched` 에 남지 않아, scoped 가
            # 실제보다 좁게 돌고 아무도 몰랐다 (M28).
            unmatched.append({"kind": "source", "raw": src,
                              "why": "대응 테스트를 찾지 못했다"})
        for t in got:
            if t not in paths:
                paths.append(t)

    # **넓히면 퇴화를 재야 한다.** 선택 경로가 전체 테스트에 가까우면 그것은
    # scoped 가 아니라 full 이고, "scoped 통과" 라고 적는 것이 새 자리의
    # 조용한 통과가 된다.
    ratio = (float(len(paths)) / len(tests)) if tests else 0.0
    return {"paths": sorted(paths), "unmatched": unmatched,
            "entrypoint_resolver": resolver,
            "selected": len(paths), "test_files": len(tests),
            "selected_ratio": round(ratio, 3),
            "degenerate": bool(tests) and ratio >= DEGENERATE_RATIO}


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


# scoped 가 사실상 full 이 되는 지점. 넘으면 퇴화로 표기한다.
DEGENERATE_RATIO = 0.9


def _tests_for_source(root, src, tests, parsed=None):
    """이 소스를 검증하는 테스트 파일. **stem 일치 ∪ 내용 참조.**

    stem 일치만 보면 `page.tsx` → `edge-cases.test.tsx` 같은 통합 테스트가
    빠져 **수리 루프 안에서 한 번도 안 돌고** `full` 이 뒤에서 잡는다 (M28).

    내용 참조는 소스의 stem 을 **경로 형태로** 찾는다(`./match`·`/match'`).
    stem 을 그냥 포함으로 보면 `match` 가 `mismatch.test.ts` 를 끌고 오고,
    `id`·`api` 같은 짧은 stem 은 사실상 전체를 고른다.

    스택 지식은 넣지 않는다 — 확장자도 네이밍 규칙도 보지 않고 문자열만 본다.
    """
    stem = Path(src).name.split(".")[0]
    out = [t for t in tests if Path(t).name.split(".")[0] == stem]
    needles = ["/%s'" % stem, '/%s"' % stem, "/%s.js" % stem, "/%s'" % stem]
    needles += ["'%s'" % stem, '"%s"' % stem]
    for t in tests:
        if t in out:
            continue
        try:
            text = (Path(root) / t).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if any(n in text for n in needles):
            out.append(t)
    return out
