#!/usr/bin/env python3
"""규칙 원장 — 지적을 쌓고, 임계를 넘은 것을 승격 후보로 올린다.

원장은 **파일 하나**다(`findings.jsonl`). append-only 라서 머지 충돌이 자명하게
union 이고, 집계 파일을 따로 두지 않는다 — 수백 줄 규모라 매번 재계산하는 편이
싸고, 파생 파일을 두면 동기화 버그만 생긴다.

`taxonomy.json` 은 셋의 단일 출처다: **원장 어휘 · 승격 목적지 · 리뷰 범위.**
그래서 이 파일이 손상되면 셋이 동시에 조용히 틀어지고, `lint-phases` 와
`doctor` 가 그것을 잡는다.

이 모듈은 **읽고 쓸 뿐 판단하지 않는다.** 어느 규칙을 실제로 승격할지는 07 의
일이고(05 는 `staged` 까지), 중복·충돌 판정은 사람과 모델의 몫이다.
"""

import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

import harness  # noqa: E402
import state as st  # noqa: E402
import verdict  # noqa: E402

LEDGER_DIR_REL = "docs/harness/pipeline/ledger"
TAXONOMY_REL = LEDGER_DIR_REL + "/taxonomy.json"
FINDINGS_REL = LEDGER_DIR_REL + "/findings.jsonl"
CHANGELOG_REL = LEDGER_DIR_REL + "/rules_changelog.md"

# 승격 목적지의 어휘. `none` 은 승격하지 않는 것(에스컬레이션 전용)이다.
ENFORCEABLE = ("lint", "check", "prose", "none")
# 기계가 막을 수 있는 것들. 이 목적지를 가진 category 를 산문으로 승격하면 거부한다.
MACHINE_ENFORCED = ("lint", "check")

STATUS = ("active", "proposed", "retired", "escalate_only", "unpromotable")
# 승격 자체가 성립하지 않는 상태. 임계를 넘어도 후보가 되지 않는다.
NEVER_PROMOTE = ("escalate_only", "unpromotable", "retired")

RESOLUTIONS = ("repaired", "deferred", "dropped_by_enforcement", "warn_only")
SOURCES = ("reviewer", "code-review", "external", "human", "contract-trace")

# (누적 횟수, 최소 distinct_runs). **여섯 숫자 전부 미검증 상속값이다** —
# 원본에서 왔고 이 리포에서 재본 적이 없다. 첫 세 런의 원장이 이 값을 검사한다:
# 승격이 한 번도 없으면 임계가 높은 것이고, 매 런 발생하면 낮은 것이다.
THRESHOLDS = {"critical": (2, 2), "major": (3, 2), "minor": (5, 3)}

# 승격 집계에서 빼는 resolution. baseline 기간(§E6)의 관측은 오탐률을 아직
# 모르는 상태의 것이라 학습 근거가 될 수 없다.
EXCLUDED_FROM_COUNT = ("warn_only",)

_SEVERITY_RANK = {"minor": 0, "major": 1, "critical": 2}

SEED_TAXONOMY = {
    "version": 1,
    "_note": ("스택 비종속 코드만 시드로 배포한다. 프로젝트가 코드를 **추가**하는 "
              "것은 자유이고, doctor 와 lint-phases 가 유니크·어휘·rule 참조 "
              "실재를 검증한다. status 가 active 이고 enforceable 이 prose 가 "
              "아닌 것만 05 의 '검토 제외' 목록에 들어간다 — 기계 강제 규칙이 "
              "늘수록 05 가 자동으로 싸지고 좁아진다."),
    "categories": [
        {"code": "BOUNDARY_VIOLATION", "enforceable": "lint",
         "rule": "no-restricted-imports", "status": "active",
         "note": "레이어 경계를 넘는 import"},
        {"code": "NAMING", "enforceable": "lint",
         "rule": "naming-convention", "status": "active",
         "note": "네이밍 규약 위반"},
        {"code": "RESPONSE_SHAPE", "enforceable": "lint",
         "rule": "response-shape", "status": "proposed",
         "note": "응답 형태의 일관성. 어휘만 두고 규칙은 아직 없다"},
        {"code": "INPUT_VALIDATION", "enforceable": "lint",
         "rule": "input-validation", "status": "proposed",
         "note": "경계에서의 입력 검증 누락"},
        {"code": "AUTHZ_MISSING_RULE", "enforceable": "prose", "status": "active",
         "note": "인가 규칙 누락. 캐치올 위치는 기계가 판정하지 못한다"},
        {"code": "MIG_DESTRUCTIVE", "enforceable": "check", "status": "active",
         "rule": "migration", "note": "되돌릴 수 없는 스키마 변경"},
        {"code": "MIG_MISSING", "enforceable": "check", "status": "proposed",
         "rule": "migration", "note": "스키마 변경에 마이그레이션이 없다"},
        {"code": "TX_BOUNDARY", "enforceable": "prose", "status": "active",
         "note": "트랜잭션 경계"},
        {"code": "CONCURRENCY", "enforceable": "prose", "status": "active",
         "note": "동시성·락 순서"},
        {"code": "TEST_MISSING_FAILURE_PATH", "enforceable": "prose",
         "status": "active", "note": "실패 경로가 테스트되지 않았다"},
        {"code": "CONTRACT_DEFECT", "enforceable": "none",
         "status": "escalate_only",
         "note": "계약은 메인 단독 소유다. 수리가 아니라 에스컬레이션이고 "
                 "자동 승격 대상이 아니다"},
        {"code": "other/*", "enforceable": "prose", "status": "unpromotable",
         "note": "분류되지 않은 것. 어휘 밖으로 새지 않게 받아 두되 승격하지 않는다"},
    ],
}

CHANGELOG_HEADER = """# 규칙 승격 이력

> 이 파일은 `promote` 가 쓴다. 사람이 직접 적지 않는다.
> 승격은 **07 에서 런당 한 번**이고, 05 는 `staged` 까지만 만든다.

각 줄이 담는 것 — 날짜 / `run_id` / `rule_id` / category / `enforceable` /
근거 런과 횟수 / 중복·충돌 판정 / 실제 조치 / 베이스라인 diff / 철회 사유.

**`lint` 승격은 베이스라인 diff 를 반드시 남긴다.** 없으면 "규칙은 추가했는데
아무것도 안 막는다"가 조용히 통과한다.

| 날짜 | run_id | rule_id | category | enforceable | 근거 | 판정 | 조치 | 베이스라인 diff | 철회 사유 |
|---|---|---|---|---|---|---|---|---|---|
"""


# --------------------------------------------------------------------- 시드

def seed(root):
    """세 파일을 만든다. **이미 있으면 손대지 않는다** — 원장은 append-only 다."""
    root = Path(root)
    d = root / LEDGER_DIR_REL
    d.mkdir(parents=True, exist_ok=True)

    tax = root / TAXONOMY_REL
    if not tax.exists():
        tax.write_text(json.dumps(SEED_TAXONOMY, indent=2, ensure_ascii=False) + "\n",
                       encoding="utf-8")
    findings = root / FINDINGS_REL
    if not findings.exists():
        findings.write_text("", encoding="utf-8")
    log = root / CHANGELOG_REL
    if not log.exists():
        log.write_text(CHANGELOG_HEADER, encoding="utf-8")
    return d


# ------------------------------------------------------------------ taxonomy

def load_taxonomy(root):
    return harness._read_json(Path(root) / TAXONOMY_REL)


def categories(root):
    """{code: category}. 파일이 없으면 빈 dict — 없는 것과 빈 것을 구분한다."""
    try:
        data = load_taxonomy(root)
    except (OSError, ValueError):
        return {}
    return {c.get("code"): c for c in data.get("categories") or []}


def excluded_categories(root):
    """05 의 "검토 제외" 목록. `active` + 기계 강제 가능한 것만.

    이 목록이 길어질수록 리뷰어 프롬프트가 짧아지고 05 가 싸진다 — 규칙 승격의
    복리가 실현되는 지점이다. 반대로 `prose` 는 기계가 못 막으므로 여기 넣으면
    아무도 안 보는 규칙이 된다.
    """
    return [code for code, c in sorted(categories(root).items())
            if c.get("status") == "active"
            and c.get("enforceable") in MACHINE_ENFORCED]


def validate_taxonomy(data):
    """[오류 문자열]. 빈 리스트면 통과다."""
    errors = []
    cats = data.get("categories")
    if not isinstance(cats, list) or not cats:
        return ["categories 가 비어 있거나 배열이 아니다"]

    codes = [c.get("code") for c in cats]
    if len(codes) != len(set(codes)):
        dup = sorted({c for c in codes if codes.count(c) > 1})
        errors.append("코드가 유니크하지 않다: %s" % ", ".join(map(str, dup)))

    for c in cats:
        code = c.get("code")
        if not code:
            errors.append("code 가 없는 항목이 있다")
            continue
        enf = c.get("enforceable")
        if enf not in ENFORCEABLE:
            errors.append("%s 의 enforceable 이 어휘 밖이다: %r (%s)"
                          % (code, enf, ", ".join(ENFORCEABLE)))
        stat = c.get("status")
        if stat not in STATUS:
            errors.append("%s 의 status 가 어휘 밖이다: %r (%s)"
                          % (code, stat, ", ".join(STATUS)))
        # 기계 강제 목적지인데 어느 규칙인지 안 적으면 승격이 갈 곳을 모른다.
        if enf in MACHINE_ENFORCED and not c.get("rule"):
            errors.append("%s 는 enforceable=%s 인데 rule 참조가 없다 — "
                          "어디로 승격할지 아무도 모른다" % (code, enf))
    return errors


def check_destination(root, code, enforceable):
    """산문 승격이 허용되는가. 허용되면 None, 아니면 ValueError.

    **기계로 막을 수 있는 규칙의 산문 승격은 거부한다** (exit 8). 이것이
    `instruction_slot_budget` 과 맞물려, 그 예산이 진짜 기계가 못 잡는 규칙에만
    쓰이게 만든다.
    """
    cat = categories(root).get(code)
    if cat is None:
        raise ValueError("taxonomy 에 없는 category 다: %r" % code)
    if enforceable == "prose" and cat.get("enforceable") in MACHINE_ENFORCED:
        raise ValueError(
            "%s 는 %s 로 막을 수 있는데 산문으로 승격하려 한다 — 산문은 "
            "영구 비용이고 기계 규칙은 런타임 비용이 0 이다"
            % (code, cat.get("enforceable")))
    return None


# ------------------------------------------------------------------ findings

def finding_key(f):
    """`sha1(category | target_role | normalize_title)`.

    **경로를 키에 넣지 않는다** — "동일 유형"은 파일을 가로질러야 의미가 있다.
    01 의 판정과 같은 함수를 쓴다. 두 곳에서 키가 갈라지면 05 의 단조성과
    승격 집계가 서로 다른 것을 세게 된다.
    """
    return verdict.finding_key(f)


def append(root, run_id, phase, findings):
    """원장에 줄을 더한다. 반환: 쓴 줄 수.

    어휘 밖의 category·resolution 은 **조용히 받지 않는다.** 받으면 승격 집계가
    아무도 모르는 축으로 갈라지고, 그 사실이 어디에도 드러나지 않는다.
    """
    root = Path(root)
    known = categories(root)
    rows = []
    for f in findings or []:
        code = f.get("category")
        if code not in known:
            raise ValueError("taxonomy 에 없는 category 다: %r — 새 코드를 쓰려면 "
                             "%s 에 먼저 넣는다" % (code, TAXONOMY_REL))
        res = f.get("resolution")
        if res not in RESOLUTIONS:
            raise ValueError("resolution 이 어휘 밖이다: %r (%s)"
                             % (res, ", ".join(RESOLUTIONS)))
        src = f.get("source")
        if src is not None and src not in SOURCES:
            raise ValueError("source 가 어휘 밖이다: %r (%s)"
                             % (src, ", ".join(SOURCES)))
        rows.append({
            "run_id": run_id,
            "phase": phase,
            "finding_key": finding_key(f),
            "category": code,
            "severity": f.get("severity"),
            "target_role": f.get("target_role"),
            "title_norm": verdict.normalize_ws(f.get("title") or ""),
            "resolution": res,
            "repaired_by": f.get("repaired_by"),
            "reported_by": f.get("reported_by") or [],
            "source": src,
            "ts": st.stamp(),
        })

    if not rows:
        return 0
    path = root / FINDINGS_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


def supersede(root, run_id, phase, keys, **updates):
    """이미 쌓인 관측의 상태를 **덧붙여** 갱신한다. 반환: 쓴 줄 수.

    줄을 고쳐 쓰지 않는다 — 같은 신원의 새 줄을 append 하고 `observations`
    가 마지막을 채택한다. 그래서 append-only 의 union-머지 성질이 유지된다.

    `keys` 중 이 (run_id, phase) 에 **실재하지 않는** 것은 조용히 만들지
    않는다. 없는 것을 갱신하는 것은 갱신이 아니라 날조다.
    """
    prior = {}
    for r in read_all(root):
        if r.get("_corrupt"):
            continue
        if r.get("run_id") == run_id and r.get("phase") == phase:
            prior[r.get("finding_key")] = r
    rows = []
    for key in keys or []:
        base = prior.get(key)
        if base is None:
            continue
        row = dict(base)
        row.update(updates)
        row["ts"] = st.stamp()
        rows.append(row)
    if not rows:
        return 0
    for row in rows:
        if row.get("resolution") not in RESOLUTIONS:
            raise ValueError("resolution 이 어휘 밖이다: %r (%s)"
                             % (row.get("resolution"), ", ".join(RESOLUTIONS)))
    path = Path(root) / FINDINGS_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return len(rows)


def read_all(root):
    """원장 전부. 손상된 줄은 **건너뛰지 않고 드러낸다** — 조용히 줄면 집계가 틀린다."""
    path = Path(root) / FINDINGS_REL
    if not path.exists():
        return []
    out = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            out.append({"_corrupt": True, "_line": i})
    return out


def observations(root):
    """원장을 **관측 단위**로 접은 것. 집계는 전부 이것을 쓴다.

    행의 신원은 `(run_id, phase, finding_key)` 이고, 같은 신원의 뒷줄은 새
    발생이 아니라 **승계**다 — 가변 필드(`resolution`·`repaired_by`)는 마지막
    줄이 이기고 `severity` 는 최대다.

    **왜 접기를 읽기에 두는가.** 원장 파일은 append-only 다(`open("a")`). 그
    성질이 값을 하는 이유가 있다 — tracked 파일이라 브랜치 머지가 자명하게
    union 이고, 줄을 제자리 수정하면 동시 런의 lost-update 가 생긴다. 그래서
    가변성을 쓰기가 아니라 읽기로 옮긴다. `read_all` 은 원문 감사용으로
    그대로 남고 **한 줄도 사라지지 않는다.**

    `phase` 를 신원에 넣는 것이 선택이다. `(run_id, finding_key)` 로만 접으면
    05 와 07 의 관측이 합쳐져 `count` 가 `distinct_runs` 를 완전히 흡수하고,
    임계 여섯 숫자 중 셋이 죽은 값이 된다. M30 이 지적한 것은 라운드 중복이지
    페이즈 간 합산이 아니다.

    **머지 시 순서 비결정성**: 두 브랜치가 같은 신원에 다른 resolution 을
    덧붙이면 접기 결과가 인터리브 순서에 달린다. `ts` 로 정렬해 결정론으로
    만들되, "뒤 `ts` 가 이긴다" 는 임의 선택임을 적어 둔다.
    """
    folded = {}
    order = []
    rows = [r for r in read_all(root) if not r.get("_corrupt")]
    rows.sort(key=lambda r: r.get("ts") or "")
    for row in rows:
        ident = (row.get("run_id"), row.get("phase"), row.get("finding_key"))
        prev = folded.get(ident)
        if prev is None:
            folded[ident] = dict(row, first_seen=row.get("ts"),
                                 last_seen=row.get("ts"), superseded=0)
            order.append(ident)
            continue
        rank = _SEVERITY_RANK.get(row.get("severity"), -1)
        keep_sev = prev.get("severity")
        if rank > _SEVERITY_RANK.get(keep_sev, -1):
            keep_sev = row.get("severity")
        first = prev.get("first_seen")
        n = prev.get("superseded", 0) + 1
        folded[ident] = dict(row, severity=keep_sev, first_seen=first,
                             last_seen=row.get("ts"), superseded=n)
    return [folded[i] for i in order]


def distinct_runs(root):
    """원장이 본 런의 수.

    **한계를 적어 둔다**: 지적을 한 건도 내지 않은 런은 여기 세어지지 않는다.
    baseline 기간(§E6)이 재려는 것이 `untested_contract_item` 의 **오탐률**이므로,
    관측이 0건인 런은 그 비율에 대해 아무 증거도 주지 않는다 — 그래서 세지 않는
    것이 맞다. 다만 "3런"이 달력의 3런이 아니라 **관측이 있었던 3런**이라는 뜻이다.
    """
    return len({r.get("run_id") for r in read_all(root)
                if not r.get("_corrupt") and r.get("run_id")})


def in_baseline(root, baseline_runs):
    """baseline 기간 안인가 — 안이면 오탐이 잦은 검사를 `warn_only` 로 낮춘다."""
    return distinct_runs(root) < (baseline_runs or 0)


# ------------------------------------------------------------------- 승격 계산

def stage_promotions(root):
    """임계를 넘은 finding_key 를 후보로 올린다. **05 는 여기까지다.**

    반환: {"candidates": [...], "held": [...], "distinct_runs": n,
           "thresholds": {...}}

    `held` 는 **누적은 넘었는데 `distinct_runs` 에서 막힌 것**이다. 조용히
    빠뜨리면 "임계가 높다"와 "런이 모자라다"가 같은 침묵이 된다.
    """
    cats = categories(root)
    buckets = {}
    for row in observations(root):
        if row.get("resolution") in EXCLUDED_FROM_COUNT:
            continue
        code = row.get("category")
        cat = cats.get(code) or {}
        if cat.get("status") in NEVER_PROMOTE:
            continue
        key = row.get("finding_key")
        b = buckets.setdefault(key, {
            "finding_key": key, "category": code,
            "target_role": row.get("target_role"),
            "title_norm": row.get("title_norm"),
            "enforceable": cat.get("enforceable"),
            "rule": cat.get("rule"),
            "count": 0, "runs": set(), "severity": "minor"})
        b["count"] += 1
        if row.get("run_id"):
            b["runs"].add(row["run_id"])
        if _SEVERITY_RANK.get(row.get("severity"), -1) > _SEVERITY_RANK[b["severity"]]:
            b["severity"] = row["severity"]

    candidates, held = [], []
    for b in buckets.values():
        need_count, need_runs = THRESHOLDS.get(b["severity"], (99, 99))
        runs = len(b["runs"])
        item = dict(b, runs=sorted(b["runs"]), distinct_runs=runs,
                    needs={"count": need_count, "distinct_runs": need_runs})
        if b["count"] < need_count:
            continue
        if runs < need_runs:
            # 여러 페이즈·소스가 같은 것을 본 것은 그 런의 특성이지 학습
            # 대상이 아니다. 막았다는 사실을 드러낸다.
            item["held_because"] = ("누적 %d 로 임계를 넘었지만 distinct_runs 가 "
                                    "%d 라 %d 에 못 미친다"
                                    % (b["count"], runs, need_runs))
            held.append(item)
            continue
        candidates.append(item)

    candidates.sort(key=lambda c: (-_SEVERITY_RANK[c["severity"]], c["category"]))
    return {"candidates": candidates, "held": held,
            "distinct_runs": distinct_runs(root),
            "thresholds": {k: {"count": v[0], "distinct_runs": v[1]}
                           for k, v in THRESHOLDS.items()},
            "note": "05 는 staged 까지다. 실제 쓰기는 07 에서 런당 한 번이다."}
