#!/usr/bin/env python3
"""
백필 — 지난 런들이 남긴 세션 트랜스크립트에서 "끌어온 양"을 사후 집계한다.

ROADMAP 29. 실행기는 이제 런 중에 이 숫자를 재지만(execute.py 의
`_read_session_metrics`), 여덟 런 41 step 이 이미 지나갔다. 그 값은
트랜스크립트에 그대로 남아 있으므로 사후 집계가 된다 — 하지 않으면
ROADMAP 28 의 예산은 런 #9 부터 표본을 다시 쌓아야 한다.

Usage:
    python3 scripts/backfill_reads.py [--dry-run] [--phase <dir>]
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from execute import StepExecutor, _force_utf8_output  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# 백필이 채우는 칸. **이미 값이 있는 칸은 건드리지 않고, 빠진 칸만 채운다.**
#
# 처음에는 "이 중 하나라도 있으면 통째로 건너뛴다"였다. 그래서 계측이 늘어
# 새 키가 생겼을 때 41 step 이 전부 이미 옛 5종을 갖고 있어 **한 칸도
# 채워지지 않았다.** 빈 칸을 채우는 것은 "못 잰 것이 잰 것을 지우지 않는다"
# (M12·M14)를 깨지 않는다 — 지우는 것이 아니기 때문이다. --force 는 이번에도
# 두지 않는다.
PULL_KEYS = ("session_id", "tool_result_chars", "tool_result_count",
             "tool_output_chars", "tool_calls",
             # 합계에서 분포로 (PILOT-LOG "다음에 볼 것" 1번). 같은 양을
             # 끌어온 두 step 이 22 turn 과 44 turn 으로 갈린 이유를 가른다.
             "tool_result_p50", "tool_result_p90", "tool_result_max",
             "tool_result_repeat_chars", "tool_result_repeat_count")


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: dict):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8")


def _session_of(phase_dir: Path, step_num: int) -> Optional[str]:
    """step{N}-output.json 이 증명하는 세션. 없으면 None.

    이 파일은 **마지막 시도**만 남긴다 (M12 가 runs[] 를 만든 이유가 그것이다).
    그러므로 이 세션이 몇 번째 시도였는지는 여기서 알 수 없다.
    """
    out_path = phase_dir / f"step{step_num}-output.json"
    if not out_path.exists():
        return None
    try:
        return StepExecutor._session_id(_read_json(out_path))
    except (ValueError, OSError):
        return None


def backfill_phase(phase_dir: Path, *, dry_run: bool = False,
                   transcript_root: Optional[Path] = None) -> list:
    """한 phase 의 index.json 을 채운다. 무엇을 했는지 행으로 돌려준다."""
    index_path = phase_dir / "index.json"
    if not index_path.exists():
        return []
    index = _read_json(index_path)
    rows, changed = [], False

    for step in index.get("steps", []):
        num = step.get("step")
        row = {"phase": phase_dir.name, "step": num, "name": step.get("name"),
               "turns": None, "cost_usd": None, "preamble_chars": None,
               "action": "unmeasured"}
        runs = step.get("runs")
        last = runs[-1] if runs else None
        if isinstance(last, dict):
            for key in ("turns", "cost_usd", "preamble_chars"):
                row[key] = last.get(key)

        existing = {k: last[k] for k in PULL_KEYS
                    if isinstance(last, dict) and k in last}

        pull = StepExecutor._read_session_metrics(
            _session_of(phase_dir, num), transcript_root=transcript_root)
        if not pull:
            # 못 쟀다. 있던 값은 그대로 두고 그 사실만 적는다.
            if existing:
                row.update(existing, action="kept")
            rows.append(row)
            continue

        # 있는 칸은 그대로, 빠진 칸만. 이 한 줄이 "지우지 않는다"를 지킨다.
        missing = {k: v for k, v in pull.items() if k not in existing}
        row.update(existing)
        row.update(missing)
        if not missing:
            row["action"] = "kept"
            rows.append(row)
            continue

        row["action"] = "extended" if existing else "filled"
        rows.append(row)
        if dry_run:
            continue

        if isinstance(last, dict):
            last.update(missing)
            # reads_source 는 그 실측이 **언제 났는지**를 말하는 칸이다.
            # 사후로 칸을 더했다고 런 중에 잰 것이 backfill 이 되지는 않는다.
            last.setdefault("reads_source", "backfill")
        else:
            # 런 #1~#5 의 26 step 에는 runs[] 가 없다 — M12 가 그 다음에 생겼다.
            # 시도 번호를 지어내지 않는다. outcome 도 적지 않는다: 출력 파일은
            # 마지막 세션만 증명하고 그것이 몇 번째였는지는 증명하지 않는다.
            step.setdefault("runs", []).append(
                dict(missing, attempt=None, reads_source="backfill"))
        changed = True

    if changed and not dry_run:
        _write_json(index_path, index)
    return rows


def backfill(root: Path = ROOT, *, dry_run: bool = False, only: Optional[str] = None,
             transcript_root: Optional[Path] = None) -> list:
    """phases/index.json 이 아는 모든 phase 를 훑는다."""
    top_path = root / "phases" / "index.json"
    dirs = [p["dir"] for p in _read_json(top_path).get("phases", [])] \
        if top_path.exists() else []
    if only:
        dirs = [d for d in dirs if d == only] or [only]
    rows = []
    for d in dirs:
        rows.extend(backfill_phase(root / "phases" / d, dry_run=dry_run,
                                   transcript_root=transcript_root))
    return rows


def _print_table(rows: list, *, dry_run: bool):
    print(f"\n{'='*88}")
    print(f"  끌어온 양 백필 — {'모의 실행 (기록하지 않는다)' if dry_run else '기록'}")
    print(f"{'='*88}")
    head = f"{'phase':<16} {'#':>2} {'name':<16} {'끌어온 양':>10} {'건':>3} {'중앙':>7} " \
           f"{'p90':>7} {'최대':>8} {'재수신':>8} {'재':>3} {'turn':>4} {'비용':>6} {'접두부':>8}  상태"
    print(head)
    print("-" * len(head))
    def fmt(v, w):
        return " " * (w - 1) + "—" if v is None else f"{v:>{w},}"

    for r in rows:
        cost = r.get("cost_usd")
        cost_cell = "     —" if not cost else "{:>6}".format("$%.2f" % cost)
        print(f"{r['phase']:<16} {r['step']:>2} {str(r['name'])[:16]:<16} "
              f"{fmt(r.get('tool_result_chars'), 10)} "
              f"{fmt(r.get('tool_result_count'), 3)} "
              f"{fmt(r.get('tool_result_p50'), 7)} "
              f"{fmt(r.get('tool_result_p90'), 7)} "
              f"{fmt(r.get('tool_result_max'), 8)} "
              f"{fmt(r.get('tool_result_repeat_chars'), 8)} "
              f"{fmt(r.get('tool_result_repeat_count'), 3)} "
              f"{fmt(r.get('turns'), 4)} "
              f"{cost_cell} "
              f"{fmt(r.get('preamble_chars'), 8)}  {r['action']}")

    measured = [r for r in rows if isinstance(r.get("tool_result_chars"), int)]
    print("-" * len(head))
    print(f"  {len(measured)}/{len(rows)} step 측정됨 "
          f"(처음 채움 {sum(1 for r in rows if r['action'] == 'filled')} · "
          f"칸 추가 {sum(1 for r in rows if r['action'] == 'extended')} · "
          f"기존 유지 {sum(1 for r in rows if r['action'] == 'kept')} · "
          f"미측정 {sum(1 for r in rows if r['action'] == 'unmeasured')})")
    if measured:
        total = sum(r["tool_result_chars"] for r in measured)
        print(f"  끌어온 양 합계 {total:,}자 · step 당 평균 {total // len(measured):,}자")
    print("\n  상한은 걸지 않는다 — 걸면 step 설계가 그 값에 맞춰져 표본이 더는 "
          "생기지 않는다 (ADR-H010).")


def main():
    _force_utf8_output()
    parser = argparse.ArgumentParser(description="세션이 끌어온 양을 사후 집계한다")
    parser.add_argument("--dry-run", action="store_true",
                        help="표만 찍고 index.json 을 고치지 않는다")
    parser.add_argument("--phase", help="이 phase 디렉토리만 (기본: 전부)")
    args = parser.parse_args()

    rows = backfill(ROOT, dry_run=args.dry_run, only=args.phase)
    _print_table(rows, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
