#!/usr/bin/env python3
"""
Harness Step Executor — phase 내 step을 순차 실행하고 자가 교정한다.

Usage:
    python3 scripts/execute.py <phase-dir> [--push]
"""

import argparse
import contextlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent

# 실행 중 상태 파일 (M10). 산출물이 아니라 실행 중 상태이므로 .gitignore 대상이다.
RUNNING_FILENAME = "RUNNING"
HEARTBEAT_INTERVAL_SEC = 30
# 이 시간 넘게 heartbeat 가 갱신되지 않으면 죽은 런으로 본다. 간격의 10배로,
# 세션이 잠깐 멈칫한 것과 프로세스가 사라진 것을 가르기에 충분히 넉넉하다.
STALE_AFTER_SEC = 300


def _force_utf8_output():
    """실행기 자신의 출력을 UTF-8 로 고정한다.

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


_force_utf8_output()


class _Stopwatch:
    """경과 시간을 **언제 읽어도** 유효하게 돌려준다.

    finally 에서만 값을 채우면 호출부가 with 블록 안에서 읽을 때 언제나 0 이고,
    실행기가 표시하는 step 소요가 전부 0s 가 된다(파일럿에서 두 런 동안
    그랬다). 진행 중에는 실시간으로 계산하고, 끝나면 그 시점 값으로 고정한다.
    """

    __slots__ = ("_t0", "_final")

    def __init__(self):
        self._t0 = time.monotonic()
        self._final = None

    @property
    def elapsed(self) -> float:
        if self._final is not None:
            return self._final
        return time.monotonic() - self._t0

    def freeze(self):
        self._final = time.monotonic() - self._t0


@contextlib.contextmanager
def progress_indicator(label: str):
    """진행 표시기. `.elapsed` 로 경과 시간을 읽는다 (블록 안에서도 유효하다).

    스피너는 터미널에서만 띄운다. `\\r` 로 덮이는 것은 TTY 에서뿐이고,
    리다이렉트된 로그에서는 프레임이 전부 쌓여 실제 출력을 가린다.
    """
    frames = "◐◓◑◒"
    stop = threading.Event()
    watch = _Stopwatch()
    stream = sys.stderr
    animated = bool(getattr(stream, "isatty", lambda: False)())

    def _animate():
        idx = 0
        while not stop.wait(0.12):
            stream.write(f"\r{frames[idx % len(frames)]} {label} [{int(watch.elapsed)}s]")
            stream.flush()
            idx += 1
        stream.write("\r" + " " * (len(label) + 20) + "\r")
        stream.flush()

    th = None
    if animated:
        th = threading.Thread(target=_animate, daemon=True)
        th.start()
    else:
        # 비대화형에서는 스피너 대신 시작 한 줄. flush 하지 않으면 블록 버퍼링에
        # 걸려 프로세스가 끝날 때까지 아무것도 보이지 않는다.
        print(f"  ▶ {label}", flush=True)

    try:
        yield watch
    finally:
        watch.freeze()
        stop.set()
        if th is not None:
            th.join()


class RunningFile:
    """실행 중 상태를 `phases/{phase}/RUNNING` 으로 외재화한다 (파일럿 결함 M10).

    `started_at` 은 있고 `step{N}-output.json` 은 없는 상태가 "진행 중"과
    "죽었음"을 **동시에** 뜻해 관찰자가 둘을 구분할 수 없었다. 런 #4에서
    감독 세션이 9분째 작업 중이던 step 을 "끊겼다"로 오독해 산출물을 되돌렸고,
    원래 계획은 실행기를 하나 더 띄우는 것이었다 — 그랬다면 둘이 같은
    index.json 을 두고 다퉜다.

    생존 판정은 **heartbeat 신선도**로 한다. pid 는 사람이 읽으라고 남기되
    기계 판정에 쓰지 않는다 — Windows 에서 `os.kill(pid, 0)` 은 생존 확인이
    아니라 **프로세스 종료**다. CPython 의 os.kill 은 Windows 에서
    CTRL_C_EVENT·CTRL_BREAK_EVENT 가 아닌 모든 시그널을 OpenProcess +
    TerminateProcess(handle, sig) 로 처리한다. POSIX 의 관용구를 그대로 옮기면
    M10 이 막으려는 사고를 M10 수정이 일으킨다.
    """

    def __init__(self, path: Path, stamp, *, clock=None,
                 interval: float = HEARTBEAT_INTERVAL_SEC,
                 stale_after: float = STALE_AFTER_SEC):
        self._path = path
        self._stamp = stamp            # () -> str, 실행기와 같은 타임스탬프 형식
        self._clock = clock or (lambda: datetime.now(StepExecutor.TZ))
        self._interval = interval
        self._stale_after = stale_after
        self._state: Optional[dict] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    @property
    def path(self) -> Path:
        return self._path

    def read(self, attempts: int = 5, delay: float = 0.02) -> Optional[dict]:
        """디스크의 RUNNING 을 읽는다. **파일이 없을 때만** None 이다.

        Windows 에서는 heartbeat 의 os.replace 와 읽기가 겹치면 공유 위반으로
        열기 자체가 실패한다. 그 일시적 실패를 "실행 중인 런이 없다"로 읽으면
        두 번째 실행기가 그대로 시작한다 — 파일이 있는데 못 읽었다면 빈 dict 를
        돌려 **살아 있는 쪽으로** 판정하게 한다 (is_fresh 가 같은 규율이다).
        """
        for _ in range(attempts):
            if not self._path.exists():
                return None
            try:
                data = json.loads(self._path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                time.sleep(delay)
                continue
            if isinstance(data, dict):
                return data
            time.sleep(delay)
        return {} if self._path.exists() else None

    def age_sec(self, state: dict) -> Optional[float]:
        """heartbeat 가 얼마나 낡았는지. 읽을 수 없으면 None(= 판정 불가)."""
        beat = state.get("heartbeat") or state.get("started_at")
        if not isinstance(beat, str):
            return None
        try:
            then = datetime.strptime(beat, "%Y-%m-%dT%H:%M:%S%z")
        except ValueError:
            return None
        return (self._clock() - then).total_seconds()

    def is_fresh(self, state: dict) -> bool:
        """heartbeat 를 읽을 수 없으면 **살아 있다고 본다.**

        모르는 상태에서 남의 런을 죽은 것으로 단정하는 쪽이 위험하다 —
        M10 이 낸 사고가 정확히 그 오판이었다.
        """
        age = self.age_sec(state)
        return True if age is None else age < self._stale_after

    def claim(self, phase: str, step: Optional[int] = None):
        """RUNNING 을 이 프로세스 것으로 쓰고 heartbeat 스레드를 띄운다."""
        now = self._stamp()
        self._state = {
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "phase": phase,
            "step": step,
            "started_at": now,
            "heartbeat": now,
        }
        self._flush()
        self._stop.clear()
        # daemon 스레드다. 실행기가 예기치 않게 죽으면 heartbeat 도 함께 멈추고,
        # 그 정지가 곧 "죽었다"는 신호가 된다.
        self._thread = threading.Thread(target=self._beat, daemon=True)
        self._thread.start()

    def set_step(self, step: int):
        if self._state is None:
            return
        self._state["step"] = step
        self._flush()

    def release(self):
        """스레드를 세우고 파일을 지운다. 여러 번 불러도 안전하다."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._interval + 1)
            self._thread = None
        self._state = None
        try:
            self._path.unlink()
        except OSError:
            pass

    # --- 내부 ---

    def _beat(self):
        while not self._stop.wait(self._interval):
            if self._state is None:
                return
            self._state["heartbeat"] = self._stamp()
            self._flush()

    def _flush(self):
        """임시 파일에 쓴 뒤 원자적으로 갈아끼운다.

        제자리 쓰기는 truncate 와 write 사이에 **빈 파일**을 노출한다.
        heartbeat 는 30초마다 도는데, 하필 그 순간 다른 실행기가 읽으면
        read() 가 None 을 돌려주고 "실행 중인 런이 없다"로 판정해 그대로
        시작한다 — RUNNING 파일이 막으려는 바로 그 사고다.
        """
        if self._state is None:
            return
        tmp = self._path.with_name(self._path.name + ".tmp")
        try:
            tmp.write_text(
                json.dumps(self._state, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            # 상태 파일을 못 써도 런을 죽이지 않는다. 관측 장치가 작업을
            # 중단시키면 관측이 결함이 된다 (M8 과 같은 규율).
            try:
                tmp.unlink()
            except OSError:
                pass


class StepExecutor:
    """Phase 디렉토리 안의 step들을 순차 실행하는 하네스."""

    MAX_RETRIES = 3
    # step 파일의 '읽어야 할 파일' 절과 그 안의 docs/*.md 참조 (M15 교차검증)
    _READ_SECTION_RE = re.compile(r"^##[^\n]*읽어야 할 파일[^\n]*$(.*?)(?=^##\s|\Z)",
                                  re.M | re.S)
    _DOC_REF_RE = re.compile(r"docs/([A-Za-z0-9_.\-]+)\.md")
    # 같은 절에서 소스 경로도 긁는다. 프로젝트 고유명사를 코어에 두지 않으려고
    # "src/" 같은 접두사가 아니라 '문서가 아니면서 실재하는 파일'로 판정한다 (M16).
    _PATH_REF_RE = re.compile(r"[\w][\w./\-]*\.[A-Za-z0-9]+")
    SOURCE_INJECT_MAX_CHARS = 60000
    LANG_BY_EXT = {".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx",
                   ".mjs": "js", ".json": "json", ".py": "python",
                   ".md": "markdown", ".css": "css", ".sql": "sql"}
    FEAT_MSG = "feat({phase}): step {num} — {name}"
    CHORE_MSG = "chore({phase}): step {num} output"
    TZ = timezone(timedelta(hours=9))

    def __init__(self, phase_dir_name: str, *, auto_push: bool = False):
        self._root = str(ROOT)
        self._phases_dir = ROOT / "phases"
        self._phase_dir = self._phases_dir / phase_dir_name
        self._phase_dir_name = phase_dir_name
        self._top_index_file = self._phases_dir / "index.json"
        self._auto_push = auto_push

        if not self._phase_dir.is_dir():
            print(f"ERROR: {self._phase_dir} not found")
            sys.exit(1)

        self._index_file = self._phase_dir / "index.json"
        if not self._index_file.exists():
            print(f"ERROR: {self._index_file} not found")
            sys.exit(1)

        idx = self._read_json(self._index_file)
        self._project = idx.get("project", "project")
        self._phase_name = idx.get("phase", phase_dir_name)
        self._total = len(idx["steps"])

        self._running = RunningFile(self._phase_dir / RUNNING_FILENAME, self._stamp)
        # 죽은 런이 어느 step 에서 끊겼는지. claim 전에 읽어 둬야 한다.
        self._stale_step: Optional[int] = None
        self._retry_limit = self._resolve_retry_limit()

    def run(self):
        self._print_header()
        self._check_blockers()
        self._claim_running()
        try:
            self._checkout_branch()
            self._ensure_created_at()
            self._execute_all_steps()
            self._finalize()
        finally:
            # blocked·error 의 sys.exit 도 SystemExit 로 여기를 지난다.
            self._running.release()

    # --- 실행 중 상태 (M10) ---

    def _claim_running(self):
        prior = self._running.read()
        if prior is not None:
            if self._running.is_fresh(prior):
                age = self._running.age_sec(prior)
                print(f"\n  ERROR: 이 phase 를 이미 실행 중인 실행기가 있다.")
                print(f"    pid {prior.get('pid')} @ {prior.get('host')} · "
                      f"step {prior.get('step')} · 시작 {prior.get('started_at')}")
                if age is not None:
                    print(f"    마지막 heartbeat {int(age)}초 전 — 살아 있다.")
                else:
                    print(f"    heartbeat 를 읽을 수 없다 — 살아 있다고 본다.")
                print(f"    실행기 둘이 같은 index.json 을 고치면 산출물이 서로를 덮는다.")
                print(f"    정말 죽은 런이면 {self._running.path} 를 지우고 다시 돌려라.")
                sys.exit(2)

            self._stale_step = prior.get("step") if isinstance(prior.get("step"), int) else None
            age = self._running.age_sec(prior)
            print(f"  ⟲ 죽은 런의 흔적을 회수한다 — pid {prior.get('pid')} · "
                  f"step {self._stale_step} · heartbeat {int(age or 0)}초 전 정지")

        self._running.claim(self._phase_name)

    # --- 재시도 상한 ---

    def _resolve_retry_limit(self) -> int:
        """상한은 실측에서 온다. 실측이 없으면 MAX_RETRIES 가 바닥값이다.

        MAX_RETRIES = 3 은 파일럿 20 step 동안 한 번도 발동하지 않은 상수였다.
        지우면 자가 교정 장치 자체가 사라지므로, 상수는 바닥값으로 남기고
        상한은 calibration 이 유도한 retry_budget 에 넘긴다 (ADR-H007).
        """
        try:
            config = self._read_json(ROOT / "harness" / "config.json")
            rel = config.get("calibration_file")
            if not rel:
                return self.MAX_RETRIES
            derived = self._read_json(ROOT / rel).get("derived") or {}
        except (OSError, ValueError, KeyError):
            return self.MAX_RETRIES
        budget = derived.get("retry_budget")
        if isinstance(budget, int) and budget >= 1:
            return budget
        return self.MAX_RETRIES

    # --- timestamps ---

    def _stamp(self) -> str:
        return datetime.now(self.TZ).strftime("%Y-%m-%dT%H:%M:%S%z")

    # --- JSON I/O ---

    @staticmethod
    def _read_json(p: Path) -> dict:
        return json.loads(p.read_text(encoding="utf-8"))

    @staticmethod
    def _write_json(p: Path, data: dict):
        p.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    # --- git ---

    def _run_git(self, *args) -> subprocess.CompletedProcess:
        # encoding 을 명시하지 않으면 로캘(cp949)로 디코드한다. 커밋 제목의
        # em dash(—)나 한글에서 리더 스레드가 UnicodeDecodeError 로 죽고,
        # communicate 가 IndexError 를 내며 실행기 전체가 무너진다 —
        # 파일럿 런 #3의 phase 를 중단시킨 결함이다. 평소에는 step 세션이
        # 스스로 커밋해 이 경로가 no-op 이라 두 런 동안 숨어 있었다.
        cmd = ["git"] + list(args)
        return subprocess.run(cmd, cwd=self._root, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")

    def _checkout_branch(self):
        branch = f"feat-{self._phase_name}"

        r = self._run_git("rev-parse", "--abbrev-ref", "HEAD")
        if r.returncode != 0:
            print(f"  ERROR: git을 사용할 수 없거나 git repo가 아닙니다.")
            print(f"  {r.stderr.strip()}")
            sys.exit(1)

        if r.stdout.strip() == branch:
            return

        r = self._run_git("rev-parse", "--verify", branch)
        r = self._run_git("checkout", branch) if r.returncode == 0 else self._run_git("checkout", "-b", branch)

        if r.returncode != 0:
            print(f"  ERROR: 브랜치 '{branch}' checkout 실패.")
            print(f"  {r.stderr.strip()}")
            print(f"  Hint: 변경사항을 stash하거나 commit한 후 다시 시도하세요.")
            sys.exit(1)

        print(f"  Branch: {branch}", flush=True)

    def _commit_step(self, step_num: int, step_name: str):
        output_rel = f"phases/{self._phase_dir_name}/step{step_num}-output.json"
        index_rel = f"phases/{self._phase_dir_name}/index.json"

        self._run_git("add", "-A")
        self._run_git("reset", "HEAD", "--", output_rel)
        self._run_git("reset", "HEAD", "--", index_rel)

        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = self.FEAT_MSG.format(phase=self._phase_name, num=step_num, name=step_name)
            r = self._run_git("commit", "-m", msg)
            if r.returncode == 0:
                print(f"  Commit: {msg}", flush=True)
            else:
                print(f"  WARN: 코드 커밋 실패: {r.stderr.strip()}")

        self._run_git("add", "-A")
        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = self.CHORE_MSG.format(phase=self._phase_name, num=step_num)
            r = self._run_git("commit", "-m", msg)
            if r.returncode != 0:
                print(f"  WARN: housekeeping 커밋 실패: {r.stderr.strip()}")

    # --- top-level index ---

    def _update_top_index(self, status: str):
        if not self._top_index_file.exists():
            return
        top = self._read_json(self._top_index_file)
        ts = self._stamp()
        for phase in top.get("phases", []):
            if phase.get("dir") == self._phase_dir_name:
                phase["status"] = status
                ts_key = {"completed": "completed_at", "error": "failed_at", "blocked": "blocked_at"}.get(status)
                if ts_key:
                    phase[ts_key] = ts
                break
        self._write_json(self._top_index_file, top)

    # --- guardrails & context ---

    def _load_guardrails(self, docs: Optional[list] = None) -> str:
        """프롬프트 접두부. docs 가 None 이면 docs/*.md 전량, 리스트면 그것만.

        CLAUDE.md 는 언제나 넣는다 — CRITICAL 규칙의 원본이라 뺄 수 없다.

        전량 주입은 다섯 런 동안 청구 토큰의 대부분을 썼다: cache_read 는
        turn 마다 접두부를 다시 읽은 양이고 그 접두부의 86.9%가 이 문서들이었다.
        step 이 쓰지 않는 문서를 750 turn 내내 재독하는 것이 비용의 정체다 (M15).
        """
        sections = []
        claude_md = ROOT / "CLAUDE.md"
        if claude_md.exists():
            sections.append(f"## 프로젝트 규칙 (CLAUDE.md)\n\n{claude_md.read_text(encoding='utf-8')}")
        docs_dir = ROOT / "docs"
        if docs_dir.is_dir():
            available = {d.stem: d for d in sorted(docs_dir.glob("*.md"))}
            if docs is None:
                chosen = [available[k] for k in sorted(available)]
            else:
                unknown = sorted(set(docs) - set(available))
                if unknown:
                    print(f"\n  ERROR: docs/ 에 없는 문서를 지정했다: {', '.join(unknown)}")
                    print(f"    있는 것: {', '.join(sorted(available))}")
                    print(f"    없는 문서를 조용히 건너뛰면 규칙이 소리 없이 빠진다.")
                    sys.exit(2)
                chosen = [available[k] for k in sorted(set(docs))]
            for doc in chosen:
                sections.append(f"## {doc.stem}\n\n{doc.read_text(encoding='utf-8')}")
        return "\n\n---\n\n".join(sections) if sections else ""

    def _resolve_step_docs(self, step: dict) -> Optional[list]:
        """이 step 에 주입할 docs/ 문서 이름(확장자 없이). None 이면 전량이다.

        우선순위는 step 의 docs 필드 → config 의 project.guardrail_docs 다.
        어느 쪽도 없으면 None 을 돌려주고, 호출부가 그것을 '미선택'으로 드러낸다.
        """
        docs = step.get("docs")
        if isinstance(docs, list):
            return [str(d) for d in docs]
        try:
            config = self._read_json(ROOT / "harness" / "config.json")
        except (OSError, ValueError):
            return None
        default = (config.get("project") or {}).get("guardrail_docs")
        if isinstance(default, list):
            return [str(d) for d in default]
        return None

    def _docs_declared_in_step_file(self, step_num: int) -> set:
        """step 파일의 '읽어야 할 파일' 절에 적힌 docs/*.md 이름."""
        step_file = self._phase_dir / f"step{step_num}.md"
        if not step_file.exists():
            return set()
        m = self._READ_SECTION_RE.search(step_file.read_text(encoding="utf-8"))
        if not m:
            return set()
        return set(self._DOC_REF_RE.findall(m.group(1)))

    def _resolve_step_sources(self, step: dict) -> Optional[list]:
        """이 step 프롬프트에 실을 소스 파일. None 이면 싣지 않는다(기존 동작)."""
        srcs = step.get("sources")
        if isinstance(srcs, list):
            return [str(p).lstrip("/") for p in srcs]
        return None

    def _source_cap(self) -> int:
        try:
            config = self._read_json(ROOT / "harness" / "config.json")
        except (OSError, ValueError):
            return self.SOURCE_INJECT_MAX_CHARS
        cap = (config.get("project") or {}).get("source_inject_max_chars")
        if isinstance(cap, int) and not isinstance(cap, bool) and cap > 0:
            return cap
        return self.SOURCE_INJECT_MAX_CHARS

    @staticmethod
    def _longest_backtick_run(text: str) -> int:
        return max((len(r) for r in re.findall(r"`+", text)), default=0)

    def _load_sources(self, paths: Optional[list]) -> str:
        """step 이 지목한 파일을 접두부에 싣는다.

        읽기 turn 336회가 유발한 접두부 재독이 다섯 런 재독 부담의 44.0%였다.
        파일을 turn k 에서 읽으면 s·(T−k) + 그 turn 의 접두부 재독이고 미리
        실으면 s·T 다 — 실측(s≈3,400 · k≈9.5 · 접두부≈133,000)에서 읽기 하나를
        없앨 때마다 약 10만 문자·turn 이 절약된다 (M16).

        단 접두부는 **모든 turn 에 곱해진다.** 상한이 없으면 개선이 아니라 악화다.
        """
        if not paths:
            return ""
        blocks = []
        total = 0
        for rel in paths:
            p = ROOT / rel
            if not p.is_file():
                print(f"\n  ERROR: steps[].sources 에 실재하지 않는 파일이 있다: {rel}")
                print(f"    이 절은 '이미 있는 것'을 싣는다. 이 step 이 만들 파일은 넣지 마라.")
                sys.exit(2)
            body = p.read_text(encoding="utf-8", errors="replace")
            total += len(body)
            fence = "`" * max(3, self._longest_backtick_run(body) + 1)
            lang = self.LANG_BY_EXT.get(p.suffix, "")
            blocks.append(f"### {rel}\n\n{fence}{lang}\n{body.rstrip()}\n{fence}")
        cap = self._source_cap()
        if total > cap:
            print(f"\n  ERROR: steps[].sources 합계가 {total:,}자로 상한 {cap:,}자를 넘는다.")
            print(f"    접두부는 모든 turn 에 곱해진다 — 상한 없는 첨부는 개선이 아니라 악화다.")
            print(f"    파일을 줄이거나 config 의 project.source_inject_max_chars 를 올려라.")
            sys.exit(2)
        head = ("## 소스 (step 시작 시점의 내용이다)\n\n"
                "이 step 이 지목한 파일이라 미리 실었다. **다시 읽지 마라.**\n"
                "단 네가 고친 뒤의 내용은 여기에 반영되지 않는다 — "
                "편집한 파일을 다시 확인해야 하면 그때 읽어라.")
        return head + "\n\n" + "\n\n".join(blocks)

    def _sources_declared_in_step_file(self, step_num: int) -> set:
        """'읽어야 할 파일' 절에 적힌 것 중 문서가 아니면서 실재하는 파일."""
        step_file = self._phase_dir / f"step{step_num}.md"
        if not step_file.exists():
            return set()
        m = self._READ_SECTION_RE.search(step_file.read_text(encoding="utf-8"))
        if not m:
            return set()
        out = set()
        for raw in self._PATH_REF_RE.findall(m.group(1)):
            rel = raw.lstrip("/")
            if rel.startswith("docs/"):
                continue
            if (ROOT / rel).is_file():
                out.add(rel)
        return out

    def _verify_source_selection(self, step_num: int, sources: Optional[list]):
        """선언과 첨부가 어긋난 채로 시작하지 않는다 (docs 와 같은 규율)."""
        if sources is None:
            return
        missing = sorted(self._sources_declared_in_step_file(step_num) - set(sources))
        if not missing:
            return
        print(f"\n  ERROR: step {step_num} 의 '읽어야 할 파일'에 있는 소스가 sources 에 없다.")
        print(f"    빠진 것: {', '.join(missing)}")
        print(f"    phases/{self._phase_dir_name}/index.json 의 steps[].sources 를 맞추거나")
        print(f"    step 파일에서 그 파일을 빼라.")
        sys.exit(2)

    def _verify_doc_selection(self, step_num: int, docs: Optional[list]):
        """선언과 주입이 어긋난 채로 시작하지 않는다.

        프로즈를 **주입 목록으로 쓰지 않고 검증에만** 쓴다. 파싱이 빗나가도
        문서가 조용히 빠지지 않게 하려는 것이다 — 설계자가 step 파일에는
        적고 index.json 필드에는 빠뜨리면 그 step 은 필요한 규칙을 못 본다.
        """
        if docs is None:
            return
        missing = sorted(self._docs_declared_in_step_file(step_num) - set(docs))
        if not missing:
            return
        print(f"\n  ERROR: step {step_num} 의 '읽어야 할 파일'에 있는 문서가 주입 목록에 없다.")
        print(f"    빠진 것: {', '.join(missing)}")
        print(f"    주입 목록: {docs}")
        print(f"    phases/{self._phase_dir_name}/index.json 의 steps[].docs 를 맞추거나")
        print(f"    step 파일에서 그 문서를 빼라.")
        sys.exit(2)

    @staticmethod
    def _build_step_context(index: dict) -> str:
        lines = [
            f"- Step {s['step']} ({s['name']}): {s['summary']}"
            for s in index["steps"]
            if s["status"] == "completed" and s.get("summary")
        ]
        if not lines:
            return ""
        return "## 이전 Step 산출물\n\n" + "\n".join(lines) + "\n\n"

    def _prior_attempt_exists(self, step_num: int) -> bool:
        """이 step 이 이전 실행에서 이미 한 번 돌았는지 본다.

        런 #3에서 사용량 한도는 세션이 코드·테스트를 다 쓰고 index.json 을
        갱신하기 직전에 떨어졌다 — status 는 pending 인데 산출물은 디스크에
        있는 상태다. 실행기가 이 사실을 세션에게 알려주지 않으면 세션이
        검증된 산출물을 처음부터 다시 쓸 수 있다.

        출력 파일은 claude 서브프로세스가 **반환한 뒤에야** 쓰인다. 세션이
        도중에 죽으면 부분 수정된 소스만 남고 출력 파일이 없어 이 신호가
        비어 있었다 — M10 의 좁은 형태다. 죽은 런의 RUNNING 이 이 step 을
        지목하면 그것도 재개 신호로 본다.
        """
        if (self._phase_dir / f"step{step_num}-output.json").exists():
            return True
        return self._stale_step == step_num

    def _build_preamble(self, guardrails: str, step_context: str,
                        prev_error: Optional[str] = None,
                        resumed: bool = False, sources: str = "") -> str:
        commit_example = self.FEAT_MSG.format(
            phase=self._phase_name, num="N", name="<step-name>"
        )
        resume_section = ""
        if resumed:
            resume_section = """
## ⚠ 재개 — 이 step 은 이전 실행에서 시작됐다가 끊겼다

이전 실행의 출력 파일이 남아 있다. **코드·테스트가 이미 디스크에 있을 수 있다.**
처음부터 다시 쓰지 마라. 먼저 무엇이 이미 있는지 읽고, AC 로 검증한 뒤
모자란 것만 채워라. 통과하고 있는 산출물을 덮어쓰면 검증된 작업이 사라진다.

---

"""

        retry_section = ""
        if prev_error:
            retry_section = (
                f"\n## ⚠ 이전 시도 실패 — 아래 에러를 반드시 참고하여 수정하라\n\n"
                f"{prev_error}\n\n---\n\n"
            )
        return (
            f"당신은 {self._project} 프로젝트의 개발자입니다. 아래 step을 수행하세요.\n\n"
            f"{guardrails}\n\n---\n\n"
            f"{(sources + chr(10)*2 + '---' + chr(10)*2) if sources else ''}"
            f"{step_context}{resume_section}{retry_section}"
            f"## 작업 규칙\n\n"
            f"1. 이전 step에서 작성된 코드를 확인하고 일관성을 유지하라.\n"
            f"2. 이 step에 명시된 작업만 수행하라. 추가 기능이나 파일을 만들지 마라.\n"
            f"3. 기존 테스트를 깨뜨리지 마라.\n"
            f"4. AC(Acceptance Criteria) 검증을 직접 실행하라.\n"
            f"5. /phases/{self._phase_dir_name}/index.json의 해당 step status를 업데이트하라:\n"
            f"   - AC 통과 → \"completed\" + \"summary\" 필드에 이 step의 산출물을 한 줄로 요약\n"
            f"   - {self._retry_limit}회 수정 시도 후에도 실패 → \"error\" + \"error_message\" 기록\n"
            f"   - 사용자 개입이 필요한 경우 (API 키, 인증, 수동 설정 등) → \"blocked\" + \"blocked_reason\" 기록 후 즉시 중단\n"
            f"6. **실행기 소유 필드를 쓰지 마라.** started_at · completed_at · failed_at ·\n"
            f"   blocked_at · created_at · attempts 는 전부 실행기가 기록한다. 네가 쓰면\n"
            f"   형식이 어긋나 실측이 오염된다. index.json 에서 네가 고칠 것은 status 와\n"
            f"   summary · error_message · blocked_reason 뿐이다.\n"
            f"   phases/{self._phase_dir_name}/RUNNING 도 실행기 것이다. 읽지도 지우지도 마라.\n"
            f"7. 모든 변경사항을 커밋하라:\n"
            f"   {commit_example}\n\n---\n\n"
        )

    # --- Claude 호출 ---

    def _invoke_claude(self, step: dict, preamble: str) -> dict:
        step_num, step_name = step["step"], step["name"]
        step_file = self._phase_dir / f"step{step_num}.md"

        if not step_file.exists():
            print(f"  ERROR: {step_file} not found")
            sys.exit(1)

        prompt = preamble + step_file.read_text(encoding="utf-8")

        # 프롬프트는 stdin 으로 넘긴다. 명령행 인자로 넘기면 가드레일
        # (CLAUDE.md + docs/*.md)이 커지는 순간 Windows CreateProcess 의
        # 인자 상한(32,767자)을 넘겨 WinError 206 으로 죽는다 — 이 리포는
        # 가드레일만 97KB라 인자 경로가 구조적으로 성립하지 않는다.
        # encoding 을 명시하지 않으면 로캘(cp949)로 인코딩돼 한글 프롬프트가 깨진다.
        result = subprocess.run(
            ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "json"],
            input=prompt,
            cwd=self._root, capture_output=True, text=True, encoding="utf-8", timeout=1800,
        )

        if result.returncode != 0:
            print(f"\n  WARN: Claude가 비정상 종료됨 (code {result.returncode})")
            if result.stderr:
                print(f"  stderr: {result.stderr[:500]}")

        output = {
            "step": step_num, "name": step_name,
            "exitCode": result.returncode,
            "prompt_chars": len(prompt),
            "stdout": result.stdout, "stderr": result.stderr,
        }
        out_path = self._phase_dir / f"step{step_num}-output.json"
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        return output

    @staticmethod
    def _extract_usage(output: dict) -> dict:
        """claude -p 의 JSON 에서 과금 지표를 뽑는다. 모르는 값은 키를 만들지 않는다.

        0 으로 채우면 '재지 않았다'와 '0 이었다'가 같은 칸에 들어가 실측이
        오염된다 — attempts 에서 이미 겪은 실패다 (ADR-H007).
        """
        try:
            payload = json.loads(output.get("stdout") or "{}")
        except (ValueError, TypeError):
            return {}
        if not isinstance(payload, dict):
            return {}
        rec = {}
        cost = payload.get("total_cost_usd")
        if isinstance(cost, (int, float)) and not isinstance(cost, bool):
            rec["cost_usd"] = round(float(cost), 4)
        turns = payload.get("num_turns")
        if isinstance(turns, int) and not isinstance(turns, bool):
            rec["turns"] = turns
        usage = payload.get("usage")
        if isinstance(usage, dict):
            for src_key, dst_key in (("cache_read_input_tokens", "cache_read"),
                                     ("cache_creation_input_tokens", "cache_write"),
                                     ("output_tokens", "output_tokens")):
                val = usage.get(src_key)
                if isinstance(val, int) and not isinstance(val, bool):
                    rec[dst_key] = val
        return rec

    def _record_run(self, index: dict, step_num: int, *, attempt: int, outcome: str,
                    elapsed: float, out: dict, guard_info: dict):
        """시도 하나의 실측을 남긴다 (M12).

        실행기는 소요와 비용을 알면서 화면에 찍고 버렸다. 재개된 step 은
        started_at 이 첫 시도 것이라 completed_at 과의 차가 대기 시간을
        포함한다 — 런 #5 step 2 는 유도값 3573s, 실제 520s 였다.

        시도마다 한 항목이어야 하는 이유도 그 런에 있다: 재개 실행이
        step{N}-output.json 을 덮어써 한도 중단분의 비용이 사라졌다.
        성공한 시도만 적으면 차단·실패의 비용이 장부에서 증발한다.
        """
        entry = {"attempt": attempt, "outcome": outcome,
                 "elapsed_sec": int(elapsed), "at": self._stamp()}
        entry.update(guard_info)
        if isinstance(out.get("prompt_chars"), int):
            entry["prompt_chars"] = out["prompt_chars"]
        entry.update(self._extract_usage(out))
        for s in index["steps"]:
            if s["step"] == step_num:
                s.setdefault("runs", []).append(entry)
                break

    @staticmethod
    def _usage_limit_reason(output: dict) -> Optional[str]:
        """세션 사용량 한도(429)로 잘렸으면 그 사유를, 아니면 None 을 돌려준다.

        한도는 코드 결함이 아니라 외부 조건이다. 자가 교정 3회를 태우고
        error 로 적으면 (1) 파일럿의 재시도 통계가 '자가 교정 실패'로
        오염되고 (2) 사용자는 고칠 수 없는 실패를 고치려 든다.
        """
        if output.get("exitCode", 0) == 0:
            return None
        try:
            payload = json.loads(output.get("stdout") or "{}")
        except (ValueError, TypeError):
            return None
        if not isinstance(payload, dict) or not payload.get("is_error"):
            return None
        if payload.get("api_error_status") != 429:
            return None
        return str(payload.get("result") or "세션 사용량 한도")

    # --- 헤더 & 검증 ---

    def _print_header(self):
        print(f"\n{'='*60}")
        print(f"  Harness Step Executor")
        print(f"  Phase: {self._phase_name} | Steps: {self._total}")
        if self._auto_push:
            print(f"  Auto-push: enabled")
        print(f"{'='*60}")

    def _check_blockers(self):
        index = self._read_json(self._index_file)
        for s in reversed(index["steps"]):
            if s["status"] == "error":
                print(f"\n  ✗ Step {s['step']} ({s['name']}) failed.")
                print(f"  Error: {s.get('error_message', 'unknown')}")
                print(f"  Fix and reset status to 'pending' to retry.")
                sys.exit(1)
            if s["status"] == "blocked":
                print(f"\n  ⏸ Step {s['step']} ({s['name']}) blocked.")
                print(f"  Reason: {s.get('blocked_reason', 'unknown')}")
                print(f"  Resolve and reset status to 'pending' to retry.")
                sys.exit(2)
            if s["status"] != "pending":
                break

    def _ensure_created_at(self):
        index = self._read_json(self._index_file)
        if "created_at" not in index:
            index["created_at"] = self._stamp()
            self._write_json(self._index_file, index)

    # --- 실행 루프 ---

    def _execute_single_step(self, step: dict, guardrails: Optional[str] = None) -> bool:
        """단일 step 실행 (재시도 포함). 완료되면 True, 실패/차단이면 False.

        guardrails 를 주면 그대로 쓴다(오버라이드). 주지 않으면 이 step 이
        고른 문서만 주입한다 (M15).
        """
        step_num, step_name = step["step"], step["name"]
        done = sum(1 for s in self._read_json(self._index_file)["steps"] if s["status"] == "completed")
        prev_error = None

        docs = None
        if guardrails is None:
            docs = self._resolve_step_docs(step)
            self._verify_doc_selection(step_num, docs)
            guardrails = self._load_guardrails(docs)
            if docs is None:
                print(f"  ⚠ 문서 미선택 — 전량 주입 ({len(guardrails):,}자). "
                      f"step 이 쓰는 것만 고르면 접두부가 줄어든다.", flush=True)
            else:
                print(f"  문서 {len(docs)}종 주입 ({len(guardrails):,}자)", flush=True)
        sources = self._resolve_step_sources(step)
        self._verify_source_selection(step_num, sources)
        source_block = self._load_sources(sources)
        if source_block:
            print(f"  소스 {len(sources)}개 첨부 ({len(source_block):,}자) — "
                  f"읽기 turn 하나가 접두부 전체를 다시 읽게 만든다", flush=True)
        guard_info = {"guardrail_docs": "all" if docs is None else sorted(docs),
                      "guardrail_chars": len(guardrails),
                      "source_chars": len(source_block)}
        # 같은 런의 재시도는 재개가 아니다 — 그쪽에는 retry_section 이 따로 붙는다.
        prior_attempt = self._prior_attempt_exists(step_num)
        if prior_attempt:
            print(f"  ↺ Step {step_num}: 이전 실행의 산출물이 있다 — 세션에 재개를 알린다", flush=True)

        for attempt in range(1, self._retry_limit + 1):
            index = self._read_json(self._index_file)
            step_context = self._build_step_context(index)
            preamble = self._build_preamble(guardrails, step_context, prev_error,
                                            resumed=prior_attempt and prev_error is None,
                                            sources=source_block)

            tag = f"Step {step_num}/{self._total - 1} ({done} done): {step_name}"
            if attempt > 1:
                tag += f" [retry {attempt}/{self._retry_limit}]"

            with progress_indicator(tag) as pi:
                out = self._invoke_claude(step, preamble)
            elapsed = int(pi.elapsed)

            index = self._read_json(self._index_file)
            status = next((s.get("status", "pending") for s in index["steps"] if s["step"] == step_num), "pending")
            ts = self._stamp()

            limit_reason = self._usage_limit_reason(out)
            if limit_reason and status not in ("completed", "blocked"):
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["status"] = "blocked"
                        s["blocked_reason"] = f"사용량 한도로 세션이 잘렸다 — {limit_reason}"
                        s.pop("error_message", None)
                self._write_json(self._index_file, index)
                status = "blocked"

            if status == "completed":
                outcome = "completed"
            elif status == "blocked":
                outcome = "blocked"
            elif attempt < self._retry_limit:
                outcome = "retry"
            else:
                outcome = "error"
            self._record_run(index, step_num, attempt=attempt, outcome=outcome,
                             elapsed=elapsed, out=out, guard_info=guard_info)

            if status == "completed":
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["completed_at"] = ts
                        s["attempts"] = attempt
                self._write_json(self._index_file, index)
                self._commit_step(step_num, step_name)
                print(f"  ✓ Step {step_num}: {step_name} [{elapsed}s]", flush=True)
                return True

            if status == "blocked":
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["blocked_at"] = ts
                        s["attempts"] = attempt
                self._write_json(self._index_file, index)
                reason = next((s.get("blocked_reason", "") for s in index["steps"] if s["step"] == step_num), "")
                print(f"  ⏸ Step {step_num}: {step_name} blocked [{elapsed}s]", flush=True)
                print(f"    Reason: {reason}")
                self._update_top_index("blocked")
                sys.exit(2)

            err_msg = next(
                (s.get("error_message", "Step did not update status") for s in index["steps"] if s["step"] == step_num),
                "Step did not update status",
            )

            if attempt < self._retry_limit:
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["status"] = "pending"
                        s["attempts"] = attempt
                        s.pop("error_message", None)
                self._write_json(self._index_file, index)
                prev_error = err_msg
                print(f"  ↻ Step {step_num}: retry {attempt}/{self._retry_limit} — {err_msg}", flush=True)
            else:
                for s in index["steps"]:
                    if s["step"] == step_num:
                        s["status"] = "error"
                        s["error_message"] = f"[{self._retry_limit}회 시도 후 실패] {err_msg}"
                        s["failed_at"] = ts
                        s["attempts"] = attempt
                self._write_json(self._index_file, index)
                self._commit_step(step_num, step_name)
                print(f"  ✗ Step {step_num}: {step_name} failed after {self._retry_limit} attempts [{elapsed}s]", flush=True)
                print(f"    Error: {err_msg}")
                self._update_top_index("error")
                sys.exit(1)

        return False  # unreachable

    def _execute_all_steps(self):
        while True:
            index = self._read_json(self._index_file)
            pending = next((s for s in index["steps"] if s["status"] == "pending"), None)
            if pending is None:
                print("\n  All steps completed!")
                return

            step_num = pending["step"]
            # RUNNING 이 어느 step 에서 도는지 먼저 남긴다. started_at 만으로는
            # "진행 중"과 "죽었음"이 갈리지 않는다 (M10).
            self._running.set_step(step_num)
            for s in index["steps"]:
                if s["step"] == step_num and "started_at" not in s:
                    s["started_at"] = self._stamp()
                    self._write_json(self._index_file, index)
                    break

            self._execute_single_step(pending)

    def _finalize(self):
        index = self._read_json(self._index_file)
        index["completed_at"] = self._stamp()
        self._write_json(self._index_file, index)
        self._update_top_index("completed")

        self._run_git("add", "-A")
        if self._run_git("diff", "--cached", "--quiet").returncode != 0:
            msg = f"chore({self._phase_name}): mark phase completed"
            r = self._run_git("commit", "-m", msg)
            if r.returncode == 0:
                print(f"  ✓ {msg}")

        if self._auto_push:
            branch = f"feat-{self._phase_name}"
            r = self._run_git("push", "-u", "origin", branch)
            if r.returncode != 0:
                print(f"\n  ERROR: git push 실패: {r.stderr.strip()}")
                sys.exit(1)
            print(f"  ✓ Pushed to origin/{branch}")

        print(f"\n{'='*60}")
        print(f"  Phase '{self._phase_name}' completed!")
        print(f"{'='*60}")


def main():
    parser = argparse.ArgumentParser(description="Harness Step Executor")
    parser.add_argument("phase_dir", help="Phase directory name (e.g. 0-mvp)")
    parser.add_argument("--push", action="store_true", help="Push branch after completion")
    args = parser.parse_args()

    StepExecutor(args.phase_dir, auto_push=args.push).run()


if __name__ == "__main__":
    main()
