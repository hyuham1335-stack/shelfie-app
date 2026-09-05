#!/usr/bin/env python3
"""05 의 리뷰어 라우팅과 판정.

**라우팅은 결정론이다.** `config.reviewers[].when` glob 이 변경 파일에 걸리면
그 리뷰어가 켜지고, 우선순위는 배열 순서다. 모델이 "누구를 부를까"를 판단하지
않는다 — 판단하면 같은 diff 가 런마다 다른 리뷰를 받는다.

여기서 막는 것 둘:

1. **리뷰어가 전부 실패해도 findings 는 0건이다.** 그러면 "지적이 없다"가
   "리뷰가 됐다"로 읽히고, 아무도 안 본 코드가 통과한다. 그래서 `status()` 가
   findings 개수와 **분리된** 신호를 낸다 (§E1).
2. **작성자는 리뷰어가 될 수 없다.** `config.roles[].agent` 와 겹치는 스킬은
   `validate()` 가 거부한다.

glob 매칭은 `harness.glob_any` 를 그대로 쓴다. 소유 판정과 라우팅이 서로 다른
glob 엔진을 쓰면 같은 경로가 두 곳에서 다르게 읽힌다 — 이 리포가 이미 겪은
실패다 (M11 · M17).
"""

import re
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.path.insert(0, str(_HERE.parent))

import harness  # noqa: E402
import verdict  # noqa: E402

SKILLS_REL = ".claude/skills"

DEFAULT_CAPS = {"small": 1, "normal": 3}
DEFAULT_MERGE_BELOW = 150
DEFAULT_FINDINGS_MAX = 50

# 05 가 산출하는 리뷰 파일의 이름. `code` 축약을 쓰는 것은 경로 240자 상한
# 때문이고(§E4), 리뷰어가 다섯이면 이름이 길 때 실제로 닿는다.
REVIEW_FILE = "05_review_%s.json"


def skill_path(root, skill):
    return Path(root) / SKILLS_REL / skill / "SKILL.md"


# ----------------------------------------------------------------------- 검증

def validate(root, config):
    """기동 **전에** 값싸게 잡는 것들. 반환: [오류 문자열].

    런 중간에 알게 되면 앞 페이즈에 쓴 시간이 이미 낭비된 뒤다 (§E10 첫 행).
    """
    errors = []
    reviewers = config.get("reviewers") or []
    if not reviewers:
        # 리뷰어가 0개인 것은 설정 오류일 수도, 의도일 수도 있다. 막지 않고
        # 드러낸다 — 다만 그 런의 review05.status 는 failed 다.
        return errors

    authors = {r.get("agent") for r in config.get("roles") or []}
    seen_code, seen_priority = {}, {}
    for r in reviewers:
        code, skill = r.get("code"), r.get("skill")
        if code in seen_code:
            errors.append("리뷰어 code 가 유니크하지 않다: %r" % code)
        seen_code[code] = skill
        pri = r.get("priority")
        if pri is not None and pri in seen_priority:
            errors.append("리뷰어 priority %r 가 %s 와 겹친다 — 순서가 "
                          "결정론이 아니게 된다" % (pri, seen_priority[pri]))
        seen_priority[pri] = code

        if skill in authors:
            errors.append(
                "리뷰어 %r 의 스킬 %r 이 작성자 역할과 같다 — **작성자 격리**가 "
                "깨진다. 자기 코드를 리뷰한 것은 독립 관측이 아니다" % (code, skill))
        if not skill_path(root, skill).is_file():
            errors.append("리뷰어 %r 의 스킬 파일이 없다: %s/%s/SKILL.md — "
                          "기동 전에 잡는다" % (code, SKILLS_REL, skill))
        if not (r.get("when") or []):
            errors.append("리뷰어 %r 에 when glob 이 없다 — 영원히 켜지지 않는다"
                          % code)
    return errors


# --------------------------------------------------------------------- 라우팅

def route(config, changed, profile="normal", source_globs=None):
    """변경 파일 → 켜질 리뷰어. 결정론이다.

    반환: {"reviewers":[...], "dropped":[...], "capped":bool, "cap":n,
           "profile":..., "source_changed":bool}

    `dropped` 는 **매칭됐지만 상한에 걸려 빠진** 리뷰어다. 조용히 버리면
    "그 관점은 볼 게 없었다"와 "예산이 없었다"가 같은 침묵이 된다.
    """
    changed = [c.replace("\\", "/") for c in (changed or [])]
    reviewers = sorted(config.get("reviewers") or [],
                       key=lambda r: (r.get("priority") if r.get("priority")
                                      is not None else 999))
    source_changed = _source_changed(config, changed, source_globs)

    matched = []
    for r in reviewers:
        if r.get("only_when_no_source_change") and source_changed:
            continue
        hits = [c for c in changed if harness.glob_any(r.get("when") or [], c)]
        if hits:
            matched.append(dict(r, matched_paths=hits[:20],
                                matched_count=len(hits)))

    cap = _cap(config, profile)
    kept, dropped = matched[:cap], matched[cap:]
    return {
        "reviewers": kept,
        "dropped": [{"code": d["code"], "skill": d["skill"],
                     "why": "프로파일 %s 의 상한 %d 를 넘었다" % (profile, cap)}
                    for d in dropped],
        "capped": bool(dropped),
        "cap": cap,
        "profile": profile,
        "source_changed": source_changed,
    }


def _cap(config, profile):
    caps = ((config.get("review") or {}).get("profile_caps") or DEFAULT_CAPS)
    return caps.get(profile) or DEFAULT_CAPS.get(profile) or 1


def _source_changed(config, changed, source_globs=None):
    """소스 변경이 하나라도 있는가. **역할이 소유한 것이 소스의 정의다.**

    판정은 `harness.owns_file` 에 맡긴다 — `owns` 와 `excludes` 를 함께 보는
    규칙이고, 그 규칙이 여기서 갈라지면 03 의 소유 검사와 05 의 라우팅이 같은
    경로를 다르게 읽는다 (M11 · M17 이 기록한 실패다).
    """
    if source_globs is not None:
        return any(harness.glob_any(source_globs, c) for c in changed)
    return any(harness.owns_file(role, c)
               for role in config.get("roles") or []
               for c in changed)


def mode(config, diff_lines):
    """`merged` 또는 `fanout`.

    작은 diff 는 단일 에이전트가 체크리스트를 순차 적용한다 — 같은 diff 를
    관점 수만큼 다시 보내는 것이 그 크기에서는 손해이기 때문이다.
    """
    limit = ((config.get("review") or {}).get("merge_below_diff_lines")
             or DEFAULT_MERGE_BELOW)
    return "merged" if (diff_lines or 0) <= limit else "fanout"


def status(planned, ok):
    """`review05.status` — **findings 개수와 분리한다** (§E1).

    리뷰어가 전부 실패해도 findings 는 0건이다. 그 0을 "지적이 없다"로 읽으면
    아무도 리뷰하지 않은 코드가 통과한다. 그래서 "리뷰가 수행됐는가"를 별도
    신호로 만든다. **계획된 리뷰어가 0개인 것도 `failed` 다** — 라우팅이 아무도
    부르지 않은 것은 통과가 아니라 미수행이다.
    """
    if not planned or not ok:
        return "failed"
    if ok < planned:
        return "degraded"
    return "ok"


# 나쁜 쪽으로 갈수록 크다. `state.GRADES` 의 단조 강등과 같은 규율이다.
STATUS_RANK = {"ok": 0, "degraded": 1, "failed": 2}


def worst_status(statuses):
    """라운드별 status 들의 **최악**. 런의 `review05.status` 는 이 값이다.

    델타 재리뷰가 1명이면 그 라운드의 분모가 1 이라 깨끗한 재리뷰가
    `ok` 를 만든다. 그것을 런의 값으로 쓰면 **1라운드의 `degraded` 가
    조용히 지워진다** — G-4 가 막으려던 구멍이 옆문으로 다시 열린다.
    그래서 status 는 런 안에서 좋아지지 않는다.

    빈 목록은 `failed` 다. 라운드가 하나도 없는 것은 미수행이지 통과가 아니다.
    """
    ranked = [STATUS_RANK.get(x, 2) for x in statuses or []]
    if not ranked:
        return "failed"
    worst = max(ranked)
    for name, rank in STATUS_RANK.items():
        if rank == worst:
            return name
    return "failed"


# ------------------------------------------------------------------ 제출 판정

def flatten(payload):
    """`by_checklist` → 평면 findings. 01 의 검사를 그대로 재사용하기 위해서다.

    `findings` 를 직접 준 제출도 받는다 — 통합 모드가 아닌 리뷰어가 그렇게 낼
    수 있고, 형태 하나를 강요해서 exit 8 을 늘릴 이유가 없다.
    """
    if payload.get("findings") is not None:
        return list(payload["findings"])
    out = []
    for items in (payload.get("by_checklist") or {}).values():
        out += list(items or [])
    return out


def check(root, config, payload, raw_text, previous_open, excluded=None):
    """05 리뷰 제출의 판정. 01 의 `check_review` + 05 특화 넷.

    반환: {"ok","exit","errors","keys","closed","blocking","findings",
           "dropped_by_enforcement","truncated"}
    """
    errors = []
    excluded = set(excluded or [])

    # ① by_checklist 는 **0건인 체크리스트도 명시**해야 한다. 안 그러면
    #    "안 봤다"와 "보고 아무것도 없었다"가 같은 침묵이 된다 (§E10).
    if payload.get("findings") is None:
        by = payload.get("by_checklist")
        if not isinstance(by, dict) or not by:
            errors.append(
                "by_checklist 가 없거나 비었다 — 0건인 체크리스트도 빈 배열로 "
                "명시한다. 누락과 '보고 아무것도 없었다'를 구분해야 한다")

    # ② 작성자 격리. config 가 이미 검사하지만 제출 시점에도 막는다 —
    #    설정을 바꾸지 않고 reviewer 이름만 바꿔 내는 경로가 남는다.
    authors = {r.get("agent") for r in config.get("roles") or []}
    codes = {r.get("code") for r in config.get("reviewers") or []}
    skills = {r.get("code"): r.get("skill") for r in config.get("reviewers") or []}
    who = payload.get("reviewer")
    if who in authors or skills.get(who) in authors:
        errors.append("리뷰어 %r 이 작성자 역할이다 — 자기 코드를 리뷰한 것은 "
                      "독립 관측이 아니다" % who)
    elif codes and who not in codes:
        errors.append("리뷰어 %r 이 config.reviewers 에 없다 — 라우팅이 부르지 "
                      "않은 리뷰어의 제출은 받지 않는다" % who)

    findings = flatten(payload)
    if errors:
        return _fail(errors)

    # ③ 01 의 검사를 **리뷰어가 낸 것 전부**에 건다. 드롭보다 먼저다 —
    #    원문의 심각도 헤딩은 리뷰어가 **쓴 만큼** 있고, 우리가 나중에 버릴
    #    것까지 세어 준다. 드롭을 먼저 하면 헤딩 개수가 안 맞아 exit 8 이 나고,
    #    그것은 리뷰어의 잘못이 아닌 것으로 리뷰어를 벌하는 것이다.
    got = verdict.check_review(dict(payload, findings=findings), raw_text,
                              previous_open)
    if not got["ok"]:
        return _fail(got["errors"])

    # ④ 이제 "검토 제외" 목록의 category 를 드롭한다. **조용히 버리지 않고
    #    센다** — 기계 강제 규칙이 늘수록 05 가 싸지는 것이 원장 승격의
    #    복리인데, 몇 건이었는지 안 세면 복리가 실현됐는지 알 수 없다.
    kept, dropped = [], []
    for f in findings:
        (dropped if f.get("category") in excluded else kept).append(f)
    dropped_keys = {verdict.finding_key(f) for f in dropped}
    got = dict(got,
               keys=[k for k in got["keys"] if k["key"] not in dropped_keys],
               blocking=sum(1 for f in kept
                            if f.get("severity") in verdict.BLOCKING))

    # ④ findings 상한. 넘으면 Critical/Major 만 남기고 절단하되 **절단 사실을
    #    남긴다** — 잘린 것이 없었던 것처럼 보이면 안 된다 (§E5).
    limit = ((config.get("review") or {}).get("findings_max")
             or DEFAULT_FINDINGS_MAX)
    truncated = False
    if len(kept) > limit:
        kept = [f for f in kept if f.get("severity") in verdict.BLOCKING][:limit]
        truncated = True

    return {"ok": True, "exit": 0, "errors": [], "keys": got["keys"],
            "closed": got["closed"], "blocking": got["blocking"],
            "findings": kept, "dropped_by_enforcement": len(dropped),
            "dropped_categories": sorted({f.get("category") for f in dropped}),
            "truncated": truncated}


def _fail(errors, dropped=0):
    return {"ok": False, "exit": 8, "errors": errors, "keys": [], "closed": [],
            "blocking": 0, "findings": [], "dropped_by_enforcement": dropped,
            "dropped_categories": [], "truncated": False}


def merge(submissions):
    """여러 리뷰어의 findings 를 합친다.

    **2인 이상이 지적한 항목은 severity 를 한 단계 올린다** — 독립 관측의
    합치는 한 관측보다 강한 증거다.
    """
    ladder = ["minor", "major", "critical"]
    by_key = {}
    for sub in submissions:
        for f in sub.get("findings") or []:
            key = verdict.finding_key(f)
            slot = by_key.setdefault(key, {"finding": dict(f), "by": []})
            if sub.get("reviewer") not in slot["by"]:
                slot["by"].append(sub.get("reviewer"))

    out = []
    for key, slot in by_key.items():
        f = slot["finding"]
        f["reported_by"] = slot["by"]
        f["finding_key"] = key
        if len(slot["by"]) > 1:
            i = ladder.index(f.get("severity")) if f.get("severity") in ladder else 0
            if i < len(ladder) - 1:
                f["severity_raised_from"] = f.get("severity")
                f["severity"] = ladder[i + 1]
                f["why_raised"] = ("독립 리뷰어 %d명이 같은 것을 지적했다 — "
                                   "합치는 한 관측보다 강한 증거다" % len(slot["by"]))
        out.append(f)
    out.sort(key=lambda f: -ladder.index(f.get("severity"))
             if f.get("severity") in ladder else 0)
    return out


# --------------------------------------------------------------- 인라인 상한

def inline_budget(config, diff_text):
    """인라인으로 실을 수 있는가. 넘으면 경로 전달로 폴백한다 (§E5).

    폴백했다는 **사실이 원장에 남아야 한다** — 리뷰어가 diff 를 인라인으로 못
    받은 런은 다른 런이고, 그것이 findings 품질에 영향을 준다.
    """
    limit = ((config.get("review") or {}).get("inline_max") or {})
    lines = len((diff_text or "").splitlines())
    size = len((diff_text or "").encode("utf-8"))
    over = []
    if limit.get("lines") and lines > limit["lines"]:
        over.append("줄 %d > %d" % (lines, limit["lines"]))
    if limit.get("bytes") and size > limit["bytes"]:
        over.append("바이트 %d > %d" % (size, limit["bytes"]))
    return {"inline": not over, "lines": lines, "bytes": size,
            "over": over,
            "fallback": "경로 전달" if over else None}


_SEVERITY_HEADING = re.compile(r"(?mi)^#{1,6}\s*(critical|major|minor)\b")


def severity_headings(raw_text):
    """`.raw.md` 의 심각도 헤딩 수. 검증기가 findings 개수와 대조한다."""
    return len(_SEVERITY_HEADING.findall(raw_text or ""))
