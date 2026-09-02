"""
execute.py 리팩터링 안전망 테스트.
리팩터링 전후 동작이 동일한지 검증한다.
"""

import json
import os
import subprocess
import sys
import textwrap
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import execute as ex


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tmp_project(tmp_path):
    """phases/, CLAUDE.md, docs/ 를 갖춘 임시 프로젝트 구조."""
    phases_dir = tmp_path / "phases"
    phases_dir.mkdir()

    claude_md = tmp_path / "CLAUDE.md"
    claude_md.write_text("# Rules\n- rule one\n- rule two", encoding="utf-8")

    docs_dir = tmp_path / "docs"
    docs_dir.mkdir()
    (docs_dir / "arch.md").write_text("# Architecture\nSome content", encoding="utf-8")
    (docs_dir / "guide.md").write_text("# Guide\nAnother doc", encoding="utf-8")

    return tmp_path


@pytest.fixture
def phase_dir(tmp_project):
    """step 3개를 가진 phase 디렉토리."""
    d = tmp_project / "phases" / "0-mvp"
    d.mkdir()

    index = {
        "project": "TestProject",
        "phase": "mvp",
        "steps": [
            {"step": 0, "name": "setup", "status": "completed", "summary": "프로젝트 초기화 완료"},
            {"step": 1, "name": "core", "status": "completed", "summary": "핵심 로직 구현"},
            {"step": 2, "name": "ui", "status": "pending"},
        ],
    }
    (d / "index.json").write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")
    (d / "step2.md").write_text("# Step 2: UI\n\nUI를 구현하세요.", encoding="utf-8")

    return d


@pytest.fixture
def top_index(tmp_project):
    """phases/index.json (top-level)."""
    top = {
        "phases": [
            {"dir": "0-mvp", "status": "pending"},
            {"dir": "1-polish", "status": "pending"},
        ]
    }
    p = tmp_project / "phases" / "index.json"
    p.write_text(json.dumps(top, indent=2), encoding="utf-8")
    return p


@pytest.fixture
def executor(tmp_project, phase_dir):
    """테스트용 StepExecutor 인스턴스. git 호출은 별도 mock 필요."""
    with patch.object(ex, "ROOT", tmp_project):
        inst = ex.StepExecutor("0-mvp")
    # 내부 경로를 tmp_project 기준으로 재설정
    inst._root = str(tmp_project)
    inst._phases_dir = tmp_project / "phases"
    inst._phase_dir = phase_dir
    inst._phase_dir_name = "0-mvp"
    inst._index_file = phase_dir / "index.json"
    inst._top_index_file = tmp_project / "phases" / "index.json"
    return inst


# ---------------------------------------------------------------------------
# _stamp (= 이전 now_iso)
# ---------------------------------------------------------------------------

class TestStamp:
    def test_returns_kst_timestamp(self, executor):
        result = executor._stamp()
        assert "+0900" in result

    def test_format_is_iso(self, executor):
        result = executor._stamp()
        dt = datetime.strptime(result, "%Y-%m-%dT%H:%M:%S%z")
        assert dt.tzinfo is not None

    def test_is_current_time(self, executor):
        before = datetime.now(ex.StepExecutor.TZ).replace(microsecond=0)
        result = executor._stamp()
        after = datetime.now(ex.StepExecutor.TZ).replace(microsecond=0) + timedelta(seconds=1)
        parsed = datetime.strptime(result, "%Y-%m-%dT%H:%M:%S%z")
        assert before <= parsed <= after


# ---------------------------------------------------------------------------
# _read_json / _write_json
# ---------------------------------------------------------------------------

class TestJsonHelpers:
    def test_roundtrip(self, tmp_path):
        data = {"key": "값", "nested": [1, 2, 3]}
        p = tmp_path / "test.json"
        ex.StepExecutor._write_json(p, data)
        loaded = ex.StepExecutor._read_json(p)
        assert loaded == data

    def test_save_ensures_ascii_false(self, tmp_path):
        p = tmp_path / "test.json"
        ex.StepExecutor._write_json(p, {"한글": "테스트"})
        raw = p.read_text(encoding="utf-8")
        assert "한글" in raw
        assert "\\u" not in raw

    def test_save_indented(self, tmp_path):
        p = tmp_path / "test.json"
        ex.StepExecutor._write_json(p, {"a": 1})
        raw = p.read_text(encoding="utf-8")
        assert "\n" in raw

    def test_load_nonexistent_raises(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            ex.StepExecutor._read_json(tmp_path / "nope.json")


# ---------------------------------------------------------------------------
# _load_guardrails
# ---------------------------------------------------------------------------

class TestLoadGuardrails:
    def test_loads_claude_md_and_docs(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project):
            result = executor._load_guardrails()
        assert "# Rules" in result
        assert "rule one" in result
        assert "# Architecture" in result
        assert "# Guide" in result

    def test_sections_separated_by_divider(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project):
            result = executor._load_guardrails()
        assert "---" in result

    def test_docs_sorted_alphabetically(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project):
            result = executor._load_guardrails()
        arch_pos = result.index("arch")
        guide_pos = result.index("guide")
        assert arch_pos < guide_pos

    def test_no_claude_md(self, executor, tmp_project):
        (tmp_project / "CLAUDE.md").unlink()
        with patch.object(ex, "ROOT", tmp_project):
            result = executor._load_guardrails()
        assert "CLAUDE.md" not in result
        assert "Architecture" in result

    def test_no_docs_dir(self, executor, tmp_project):
        import shutil
        shutil.rmtree(tmp_project / "docs")
        with patch.object(ex, "ROOT", tmp_project):
            result = executor._load_guardrails()
        assert "Rules" in result
        assert "Architecture" not in result

    def test_empty_project(self, tmp_path):
        with patch.object(ex, "ROOT", tmp_path):
            # executor가 필요 없는 static-like 동작이므로 임시 인스턴스
            phases_dir = tmp_path / "phases" / "dummy"
            phases_dir.mkdir(parents=True)
            idx = {"project": "T", "phase": "t", "steps": []}
            (phases_dir / "index.json").write_text(json.dumps(idx), encoding="utf-8")
            inst = ex.StepExecutor.__new__(ex.StepExecutor)
            result = inst._load_guardrails()
        assert result == ""


# ---------------------------------------------------------------------------
# _build_step_context
# ---------------------------------------------------------------------------

class TestBuildStepContext:
    def test_includes_completed_with_summary(self, phase_dir):
        index = json.loads((phase_dir / "index.json").read_text(encoding="utf-8"))
        result = ex.StepExecutor._build_step_context(index)
        assert "Step 0 (setup): 프로젝트 초기화 완료" in result
        assert "Step 1 (core): 핵심 로직 구현" in result

    def test_excludes_pending(self, phase_dir):
        index = json.loads((phase_dir / "index.json").read_text(encoding="utf-8"))
        result = ex.StepExecutor._build_step_context(index)
        assert "ui" not in result

    def test_excludes_completed_without_summary(self, phase_dir):
        index = json.loads((phase_dir / "index.json").read_text(encoding="utf-8"))
        del index["steps"][0]["summary"]
        result = ex.StepExecutor._build_step_context(index)
        assert "setup" not in result
        assert "core" in result

    def test_empty_when_no_completed(self):
        index = {"steps": [{"step": 0, "name": "a", "status": "pending"}]}
        result = ex.StepExecutor._build_step_context(index)
        assert result == ""

    def test_has_header(self, phase_dir):
        index = json.loads((phase_dir / "index.json").read_text(encoding="utf-8"))
        result = ex.StepExecutor._build_step_context(index)
        assert result.startswith("## 이전 Step 산출물")


# ---------------------------------------------------------------------------
# _build_preamble
# ---------------------------------------------------------------------------

class TestBuildPreamble:
    def test_includes_project_name(self, executor):
        result = executor._build_preamble("", "")
        assert "TestProject" in result

    def test_includes_guardrails(self, executor):
        result = executor._build_preamble("GUARD_CONTENT", "")
        assert "GUARD_CONTENT" in result

    def test_includes_step_context(self, executor):
        ctx = "## 이전 Step 산출물\n\n- Step 0: done"
        result = executor._build_preamble("", ctx)
        assert "이전 Step 산출물" in result

    def test_includes_commit_example(self, executor):
        result = executor._build_preamble("", "")
        assert "feat(mvp):" in result

    def test_includes_rules(self, executor):
        result = executor._build_preamble("", "")
        assert "작업 규칙" in result
        assert "AC" in result

    def test_no_retry_section_by_default(self, executor):
        result = executor._build_preamble("", "")
        assert "이전 시도 실패" not in result

    def test_retry_section_with_prev_error(self, executor):
        result = executor._build_preamble("", "", prev_error="타입 에러 발생")
        assert "이전 시도 실패" in result
        assert "타입 에러 발생" in result

    def test_includes_max_retries(self, executor):
        result = executor._build_preamble("", "")
        assert str(ex.StepExecutor.MAX_RETRIES) in result

    def test_includes_index_path(self, executor):
        result = executor._build_preamble("", "")
        assert "/phases/0-mvp/index.json" in result

    def test_forbids_writing_timestamp_fields(self, executor):
        """타임스탬프는 실행기 소유다 (파일럿 M5).

        세션에게 index.json 을 고치라고만 하고 형식 규약을 주지 않으면,
        세션이 자기 형식으로 타임스탬프를 쓴다. 실측이 조용히 오염된다.
        """
        result = executor._build_preamble("", "")
        for field in ("started_at", "completed_at", "failed_at", "blocked_at", "created_at"):
            assert field in result, f"{field} 를 쓰지 말라는 지시가 없다"


# ---------------------------------------------------------------------------
# _update_top_index
# ---------------------------------------------------------------------------

class TestUpdateTopIndex:
    def test_completed(self, executor, top_index):
        executor._top_index_file = top_index
        executor._update_top_index("completed")
        data = json.loads(top_index.read_text(encoding="utf-8"))
        mvp = next(p for p in data["phases"] if p["dir"] == "0-mvp")
        assert mvp["status"] == "completed"
        assert "completed_at" in mvp

    def test_error(self, executor, top_index):
        executor._top_index_file = top_index
        executor._update_top_index("error")
        data = json.loads(top_index.read_text(encoding="utf-8"))
        mvp = next(p for p in data["phases"] if p["dir"] == "0-mvp")
        assert mvp["status"] == "error"
        assert "failed_at" in mvp

    def test_blocked(self, executor, top_index):
        executor._top_index_file = top_index
        executor._update_top_index("blocked")
        data = json.loads(top_index.read_text(encoding="utf-8"))
        mvp = next(p for p in data["phases"] if p["dir"] == "0-mvp")
        assert mvp["status"] == "blocked"
        assert "blocked_at" in mvp

    def test_other_phases_unchanged(self, executor, top_index):
        executor._top_index_file = top_index
        executor._update_top_index("completed")
        data = json.loads(top_index.read_text(encoding="utf-8"))
        polish = next(p for p in data["phases"] if p["dir"] == "1-polish")
        assert polish["status"] == "pending"

    def test_nonexistent_dir_is_noop(self, executor, top_index):
        executor._top_index_file = top_index
        executor._phase_dir_name = "no-such-dir"
        original = json.loads(top_index.read_text(encoding="utf-8"))
        executor._update_top_index("completed")
        after = json.loads(top_index.read_text(encoding="utf-8"))
        for p_before, p_after in zip(original["phases"], after["phases"]):
            assert p_before["status"] == p_after["status"]

    def test_no_top_index_file(self, executor, tmp_path):
        executor._top_index_file = tmp_path / "nonexistent.json"
        executor._update_top_index("completed")  # should not raise


# ---------------------------------------------------------------------------
# _checkout_branch (mocked)
# ---------------------------------------------------------------------------

class TestCheckoutBranch:
    def _mock_git(self, executor, responses):
        call_idx = {"i": 0}
        def fake_git(*args):
            idx = call_idx["i"]
            call_idx["i"] += 1
            if idx < len(responses):
                return responses[idx]
            return MagicMock(returncode=0, stdout="", stderr="")
        executor._run_git = fake_git

    def test_already_on_branch(self, executor):
        self._mock_git(executor, [
            MagicMock(returncode=0, stdout="feat-mvp\n", stderr=""),
        ])
        executor._checkout_branch()  # should return without checkout

    def test_branch_exists_checkout(self, executor):
        self._mock_git(executor, [
            MagicMock(returncode=0, stdout="main\n", stderr=""),
            MagicMock(returncode=0, stdout="", stderr=""),
            MagicMock(returncode=0, stdout="", stderr=""),
        ])
        executor._checkout_branch()

    def test_branch_not_exists_create(self, executor):
        self._mock_git(executor, [
            MagicMock(returncode=0, stdout="main\n", stderr=""),
            MagicMock(returncode=1, stdout="", stderr="not found"),
            MagicMock(returncode=0, stdout="", stderr=""),
        ])
        executor._checkout_branch()

    def test_checkout_fails_exits(self, executor):
        self._mock_git(executor, [
            MagicMock(returncode=0, stdout="main\n", stderr=""),
            MagicMock(returncode=1, stdout="", stderr=""),
            MagicMock(returncode=1, stdout="", stderr="dirty tree"),
        ])
        with pytest.raises(SystemExit) as exc_info:
            executor._checkout_branch()
        assert exc_info.value.code == 1

    def test_no_git_exits(self, executor):
        self._mock_git(executor, [
            MagicMock(returncode=1, stdout="", stderr="not a git repo"),
        ])
        with pytest.raises(SystemExit) as exc_info:
            executor._checkout_branch()
        assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# _commit_step (mocked)
# ---------------------------------------------------------------------------

def _porcelain(*paths):
    """git status --porcelain -z 출력을 흉내낸다 (NUL 구분)."""
    return "".join(" M %s%s" % (p, chr(0)) for p in paths)


def _git_stub(calls, changed, *, staged=True):
    """status 는 changed 를 돌려주고 나머지는 성공하는 가짜 git."""
    def fake_git(*args):
        calls.append(args)
        if args[0] == "status":
            return MagicMock(returncode=0, stdout=_porcelain(*changed), stderr="")
        if args[:2] == ("diff", "--cached"):
            return MagicMock(returncode=1 if staged else 0)
        return MagicMock(returncode=0, stdout="", stderr="")
    return fake_git


class TestCommitStep:
    """실행기가 커밋할 범위는 `git add -A` 가 아니라 소유 glob 에서 온다 (M11).

    런 #4 에서 `_finalize` 의 `git add -A` 가 미커밋 소스와 상태 파일을 한
    커밋에 담고 그 런의 실측 타임스탬프를 덮었다. 다섯 런 동안 숨어 있었던
    이유는 step 세션이 매번 스스로 커밋해 이 경로가 no-op 이었기 때문이다.
    """

    def test_two_phase_commit(self, executor):
        calls = []
        executor._run_git = _git_stub(
            calls, ["src/lib/thing.ts", "phases/0-mvp/index.json"])

        executor._commit_step(2, "ui")

        commit_calls = [c for c in calls if c[0] == "commit"]
        assert len(commit_calls) == 2
        assert "feat(mvp):" in commit_calls[0][2]
        assert "chore(mvp):" in commit_calls[1][2]

    def test_no_code_changes_skips_feat_commit(self, executor):
        calls = []
        executor._run_git = _git_stub(calls, ["phases/0-mvp/step2-output.json"])

        executor._commit_step(2, "ui")

        commit_msgs = [c[2] for c in calls if c[0] == "commit"]
        assert len(commit_msgs) == 1
        assert "chore" in commit_msgs[0]

    def test_feat_commit_carries_only_owned_paths(self, executor):
        """소유 밖 변경은 add 인자에 들어가지 않는다."""
        calls = []
        executor._run_git = _git_stub(
            calls, ["src/lib/thing.ts", "docs/TRD.md", "phases/0-mvp/index.json"])

        executor._commit_step(2, "ui")

        adds = [c for c in calls if c[0] == "add"]
        added = {p for c in adds for p in c[2:]}
        assert "src/lib/thing.ts" in added
        assert "docs/TRD.md" not in added, "문서는 메인 소유다 — 실행기가 커밋하지 않는다"
        assert not any(c[1] == "-A" for c in adds), "작업 트리 전체를 쓸어담지 않는다"

    def test_stray_change_is_surfaced(self, executor, capsys):
        """커밋하지 않은 소유 밖 변경은 조용히 두지 않고 드러낸다."""
        calls = []
        executor._run_git = _git_stub(calls, ["src/lib/thing.ts", "scripts/execute.py"])

        executor._commit_step(2, "ui")

        out = capsys.readouterr().out
        assert "소유 밖 변경" in out
        assert "scripts/execute.py" in out

    def test_top_level_index_is_committed(self, executor):
        """실행기가 쓰는 파일은 실행기가 커밋한다 (런 #8 에서 드러났다).

        `_update_top_index` 가 phases/index.json 에 phase 의 status 와
        completed_at 을 적는다. 소유 필터가 그것을 빼면 실행기가 자기가 고친
        파일을 "소유 밖"이라고 경고하며 커밋하지 않고 남긴다.
        """
        calls = []
        executor._run_git = _git_stub(calls, ["phases/index.json"])

        executor._commit_step(2, "ui")

        added = {p for c in calls if c[0] == "add" for p in c[2:]}
        assert "phases/index.json" in added

    def test_other_phase_metadata_is_not_committed(self, executor):
        """다른 phase 의 상태 파일은 이 런의 커밋에 섞이지 않는다 (런 #4 사고)."""
        calls = []
        executor._run_git = _git_stub(
            calls, ["phases/0-mvp/index.json", "phases/other/index.json"])

        executor._commit_step(2, "ui")

        added = {p for c in calls if c[0] == "add" for p in c[2:]}
        assert "phases/0-mvp/index.json" in added
        assert "phases/other/index.json" not in added

    def test_skips_commit_when_git_cannot_answer(self, executor, capsys):
        calls = []
        def fake_git(*args):
            calls.append(args)
            if args[0] == "status":
                return MagicMock(returncode=128, stdout="", stderr="not a repo")
            return MagicMock(returncode=0, stdout="", stderr="")
        executor._run_git = fake_git

        executor._commit_step(2, "ui")

        assert not [c for c in calls if c[0] == "commit"]
        assert "git status" in capsys.readouterr().out

    def test_rename_carries_both_sides(self, executor):
        """이름이 바뀐 파일은 원본 경로도 담아야 삭제가 커밋에 들어간다."""
        calls = []
        def fake_git(*args):
            calls.append(args)
            if args[0] == "status":
                stdout = "R  src/lib/new.ts%ssrc/lib/old.ts%s" % (chr(0), chr(0))
                return MagicMock(returncode=0, stdout=stdout, stderr="")
            if args[:2] == ("diff", "--cached"):
                return MagicMock(returncode=1)
            return MagicMock(returncode=0, stdout="", stderr="")
        executor._run_git = fake_git

        executor._commit_step(2, "ui")

        added = {p for c in calls if c[0] == "add" for p in c[2:]}
        assert added == {"src/lib/new.ts", "src/lib/old.ts"}


# ---------------------------------------------------------------------------
# _invoke_claude (mocked)
# ---------------------------------------------------------------------------

class TestInvokeClaude:
    def test_invokes_claude_with_correct_args(self, executor):
        mock_result = MagicMock(returncode=0, stdout='{"result": "ok"}', stderr="")
        step = {"step": 2, "name": "ui"}
        preamble = "PREAMBLE\n"

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            output = executor._invoke_claude(step, preamble)

        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "claude"
        assert "-p" in cmd
        assert "--dangerously-skip-permissions" in cmd
        assert "--output-format" in cmd

        # 프롬프트는 명령행 인자가 아니라 stdin 으로 간다.
        # 가드레일(CLAUDE.md + docs/*.md)이 커지면 Windows CreateProcess 인자
        # 상한(32,767자)을 넘겨 WinError 206 으로 죽기 때문이다.
        kwargs = mock_run.call_args[1]
        assert not any("PREAMBLE" in part for part in cmd)
        assert "PREAMBLE" in kwargs["input"]
        assert "UI를 구현하세요" in kwargs["input"]
        assert kwargs["encoding"] == "utf-8"

    def test_prompt_is_not_passed_as_argv(self, executor):
        """가드레일이 32KB를 넘어도 호출이 성립해야 한다 (WinError 206 회귀)."""
        mock_result = MagicMock(returncode=0, stdout='{"result": "ok"}', stderr="")
        step = {"step": 2, "name": "ui"}
        huge = "가" * 50_000

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            executor._invoke_claude(step, huge)

        cmd = mock_run.call_args[0][0]
        assert sum(len(part) for part in cmd) < 200
        assert huge in mock_run.call_args[1]["input"]

    def test_saves_output_json(self, executor):
        mock_result = MagicMock(returncode=0, stdout='{"ok": true}', stderr="")
        step = {"step": 2, "name": "ui"}

        with patch("subprocess.run", return_value=mock_result):
            executor._invoke_claude(step, "preamble")

        output_file = executor._phase_dir / "step2-output.json"
        assert output_file.exists()
        data = json.loads(output_file.read_text(encoding="utf-8"))
        assert data["step"] == 2
        assert data["name"] == "ui"
        assert data["exitCode"] == 0

    def test_nonexistent_step_file_exits(self, executor):
        step = {"step": 99, "name": "nonexistent"}
        with pytest.raises(SystemExit) as exc_info:
            executor._invoke_claude(step, "preamble")
        assert exc_info.value.code == 1

    def test_timeout_is_1800(self, executor):
        mock_result = MagicMock(returncode=0, stdout="{}", stderr="")
        step = {"step": 2, "name": "ui"}

        with patch("subprocess.run", return_value=mock_result) as mock_run:
            executor._invoke_claude(step, "preamble")

        assert mock_run.call_args[1]["timeout"] == 1800


# ---------------------------------------------------------------------------
# progress_indicator (= 이전 Spinner)
# ---------------------------------------------------------------------------

class TestProgressIndicator:
    def test_context_manager(self):
        import time
        with ex.progress_indicator("test") as pi:
            time.sleep(0.15)
        assert pi.elapsed >= 0.1

    def test_elapsed_increases(self):
        import time
        with ex.progress_indicator("test") as pi:
            time.sleep(0.2)
        assert pi.elapsed > 0

    def test_elapsed_readable_inside_the_block(self):
        """블록 안에서 읽어도 실제 경과 시간이 나와야 한다.

        finally 에서만 채우면 호출부가 with 안에서 읽을 때 언제나 0 이고,
        실행기가 표시하는 step 소요가 전부 0s 가 된다 (파일럿 M4).
        """
        import time
        with ex.progress_indicator("test") as pi:
            time.sleep(0.15)
            inside = pi.elapsed
        assert inside >= 0.1, "with 블록 안에서 읽은 경과 시간이 0이다"
        assert pi.elapsed >= inside

    def test_spinner_is_silent_when_stderr_is_not_a_tty(self):
        """리다이렉트된 로그를 스피너로 덮지 않는다 (파일럿 M2).

        \\r 로 덮이는 것은 터미널에서뿐이다. 파일에서는 프레임이 전부 쌓여
        실제 출력을 못 찾는다.
        """
        import io
        import time

        class NotATty(io.StringIO):
            def isatty(self):
                return False

        fake = NotATty()
        with patch.object(ex.sys, "stderr", fake):
            with ex.progress_indicator("test"):
                time.sleep(0.3)
        assert "◐" not in fake.getvalue()
        assert "◓" not in fake.getvalue()

    def test_spinner_runs_when_stderr_is_a_tty(self):
        import io
        import time

        class IsATty(io.StringIO):
            def isatty(self):
                return True

        fake = IsATty()
        with patch.object(ex.sys, "stderr", fake):
            with ex.progress_indicator("test"):
                time.sleep(0.3)
        assert "test" in fake.getvalue()


# ---------------------------------------------------------------------------
# main() CLI 파싱 (mocked)
# ---------------------------------------------------------------------------

class TestMainCli:
    def test_no_args_exits(self):
        with patch("sys.argv", ["execute.py"]):
            with pytest.raises(SystemExit) as exc_info:
                ex.main()
            assert exc_info.value.code == 2  # argparse exits with 2

    def test_invalid_phase_dir_exits(self):
        with patch("sys.argv", ["execute.py", "nonexistent"]):
            with patch.object(ex, "ROOT", Path("/tmp/fake_nonexistent")):
                with pytest.raises(SystemExit) as exc_info:
                    ex.main()
                assert exc_info.value.code == 1

    def test_missing_index_exits(self, tmp_project):
        (tmp_project / "phases" / "empty").mkdir()
        with patch("sys.argv", ["execute.py", "empty"]):
            with patch.object(ex, "ROOT", tmp_project):
                with pytest.raises(SystemExit) as exc_info:
                    ex.main()
                assert exc_info.value.code == 1


# ---------------------------------------------------------------------------
# _check_blockers (= 이전 main() error/blocked 체크)
# ---------------------------------------------------------------------------

class TestCheckBlockers:
    def _make_executor_with_steps(self, tmp_project, steps):
        d = tmp_project / "phases" / "test-phase"
        d.mkdir(exist_ok=True)
        index = {"project": "T", "phase": "test", "steps": steps}
        (d / "index.json").write_text(json.dumps(index), encoding="utf-8")

        with patch.object(ex, "ROOT", tmp_project):
            inst = ex.StepExecutor.__new__(ex.StepExecutor)
        inst._root = str(tmp_project)
        inst._phases_dir = tmp_project / "phases"
        inst._phase_dir = d
        inst._phase_dir_name = "test-phase"
        inst._index_file = d / "index.json"
        inst._top_index_file = tmp_project / "phases" / "index.json"
        inst._phase_name = "test"
        inst._total = len(steps)
        return inst

    def test_error_step_exits_1(self, tmp_project):
        steps = [
            {"step": 0, "name": "ok", "status": "completed"},
            {"step": 1, "name": "bad", "status": "error", "error_message": "fail"},
        ]
        inst = self._make_executor_with_steps(tmp_project, steps)
        with pytest.raises(SystemExit) as exc_info:
            inst._check_blockers()
        assert exc_info.value.code == 1

    def test_blocked_step_exits_2(self, tmp_project):
        steps = [
            {"step": 0, "name": "ok", "status": "completed"},
            {"step": 1, "name": "stuck", "status": "blocked", "blocked_reason": "API key"},
        ]
        inst = self._make_executor_with_steps(tmp_project, steps)
        with pytest.raises(SystemExit) as exc_info:
            inst._check_blockers()
        assert exc_info.value.code == 2


# ---------------------------------------------------------------------------
# _run_git 디코딩 (파일럿 런 #3 M6)
# ---------------------------------------------------------------------------

class TestRunGitDecoding:
    """git 출력을 로캘이 아니라 UTF-8 로 읽어야 한다.

    커밋 제목에 em dash(—)나 한글이 들어가면 cp949 로캘에서 리더 스레드가
    UnicodeDecodeError 로 죽고, subprocess.communicate 가 IndexError 를 내
    실행기 전체가 무너진다. 런 #3에서 phase 를 중단시킨 결함이다.
    """

    def test_decodes_as_utf8(self, executor):
        mock_result = MagicMock(returncode=0, stdout="", stderr="")
        with patch("subprocess.run", return_value=mock_result) as mock_run:
            executor._run_git("status")
        assert mock_run.call_args[1]["encoding"] == "utf-8"

    def test_undecodable_bytes_do_not_raise(self, executor):
        """깨진 바이트가 와도 예외 대신 값을 돌려준다."""
        mock_result = MagicMock(returncode=0, stdout="", stderr="")
        with patch("subprocess.run", return_value=mock_result) as mock_run:
            executor._run_git("commit", "-m", "feat(x): step 3 — resolve")
        assert mock_run.call_args[1].get("errors") == "replace"

    def test_real_git_output_with_em_dash(self, tmp_path):
        """실제 git 을 통과시킨다 (회귀 재현: 런 #3 step 3 커밋)."""
        subprocess.run(["git", "init", "-q"], cwd=str(tmp_path))
        subprocess.run(["git", "config", "user.email", "t@t"], cwd=str(tmp_path))
        subprocess.run(["git", "config", "user.name", "t"], cwd=str(tmp_path))
        (tmp_path / "a.txt").write_text("x", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=str(tmp_path))

        inst = ex.StepExecutor.__new__(ex.StepExecutor)
        inst._root = str(tmp_path)
        r = inst._run_git("commit", "-m", "feat(routes-core): step 3 — resolve-route")
        assert r.returncode == 0
        assert "resolve-route" in r.stdout


# ---------------------------------------------------------------------------
# 사용량 한도 (파일럿 런 #3 M7)
# ---------------------------------------------------------------------------

class TestUsageLimit:
    """429(세션 사용량 한도)는 코드 결함이 아니라 외부 조건이다.

    자가 교정 3회를 태우고 error 로 적으면 (1) 파일럿의 재시도 통계가
    오염되고 (2) 사용자가 고칠 수 없는 실패를 고치려 든다. blocked 로
    즉시 세워야 한다.
    """

    LIMIT_STDOUT = json.dumps({
        "is_error": True,
        "api_error_status": 429,
        "terminal_reason": "api_error",
        "result": "You've hit your session limit — resets 7:20pm (Asia/Seoul)",
    })

    def test_detects_429(self):
        out = {"exitCode": 1, "stdout": self.LIMIT_STDOUT, "stderr": ""}
        reason = ex.StepExecutor._usage_limit_reason(out)
        assert reason is not None
        assert "session limit" in reason

    def test_ignores_success(self):
        out = {"exitCode": 0, "stdout": self.LIMIT_STDOUT, "stderr": ""}
        assert ex.StepExecutor._usage_limit_reason(out) is None

    def test_ignores_other_errors(self):
        payload = json.dumps({"is_error": True, "api_error_status": 500, "result": "boom"})
        out = {"exitCode": 1, "stdout": payload, "stderr": ""}
        assert ex.StepExecutor._usage_limit_reason(out) is None

    def test_ignores_non_json(self):
        out = {"exitCode": 1, "stdout": "not json at all", "stderr": ""}
        assert ex.StepExecutor._usage_limit_reason(out) is None

    def test_ignores_empty_stdout(self):
        out = {"exitCode": 1, "stdout": "", "stderr": ""}
        assert ex.StepExecutor._usage_limit_reason(out) is None

    def test_blocks_without_burning_retries(self, executor):
        """한도에 걸리면 재시도하지 않고 exit 2 로 즉시 멈춘다."""
        out = {"exitCode": 1, "stdout": self.LIMIT_STDOUT, "stderr": ""}
        step = {"step": 2, "name": "ui", "status": "pending"}

        with patch.object(executor, "_invoke_claude", return_value=out) as inv, \
             patch.object(executor, "_run_git", return_value=MagicMock(returncode=0, stdout="", stderr="")), \
             patch.object(executor, "_update_top_index") as top:
            with pytest.raises(SystemExit) as exc_info:
                executor._execute_single_step(step, "guardrails")

        assert exc_info.value.code == 2
        assert inv.call_count == 1, "한도는 자가 교정 대상이 아니다 — 재시도하면 안 된다"
        top.assert_called_once_with("blocked")

        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        s = next(s for s in index["steps"] if s["step"] == 2)
        assert s["status"] == "blocked"
        assert "session limit" in s["blocked_reason"]
        assert "blocked_at" in s
        assert "error_message" not in s


# ---------------------------------------------------------------------------
# 실행기 자신의 출력 인코딩 (파일럿 런 #3 M8)
# ---------------------------------------------------------------------------

class TestForceUtf8Output:
    """리다이렉트된 stdout 에 ✓ 를 찍다 죽으면 안 된다.

    로캘(cp949) 스트림에 진행 표시를 쓰는 순간 UnicodeEncodeError 가 나고
    실행기가 통째로 멈춘다 — 런 #3에서 step 3 완료 출력이 phase 를 끊었다.
    """

    def test_reconfigures_streams_to_utf8(self):
        calls = []

        class FakeStream:
            def reconfigure(self, **kwargs):
                calls.append(kwargs)

        with patch.object(ex.sys, "stdout", FakeStream()), \
             patch.object(ex.sys, "stderr", FakeStream()):
            ex._force_utf8_output()

        assert len(calls) == 2
        for kwargs in calls:
            assert kwargs["encoding"] == "utf-8"
            assert kwargs["errors"] == "replace"

    def test_stream_without_reconfigure_is_tolerated(self):
        import io as _io
        with patch.object(ex.sys, "stdout", _io.StringIO()), \
             patch.object(ex.sys, "stderr", _io.StringIO()):
            ex._force_utf8_output()

    def test_reconfigure_failure_is_tolerated(self):
        class Hostile:
            def reconfigure(self, **kwargs):
                raise ValueError("detached")

        with patch.object(ex.sys, "stdout", Hostile()), \
             patch.object(ex.sys, "stderr", Hostile()):
            ex._force_utf8_output()


# ---------------------------------------------------------------------------
# 재개 — 산출물이 이미 있는 step (파일럿 런 #3)
# ---------------------------------------------------------------------------

class TestResume:
    """중단된 step 을 다시 돌릴 때 세션이 자기 산출물을 덮어쓰면 안 된다.

    런 #3에서 429 는 세션이 코드·테스트를 다 쓰고 index.json 을 갱신하기
    직전에 떨어졌다. 재실행 세션이 "처음부터 다시 쓴다"를 골랐다면 AC 를
    통과하던 산출물이 사라졌을 것이다. 실행기가 그 사실을 알려야 한다.
    """

    def test_detects_prior_attempt(self, executor):
        assert executor._prior_attempt_exists(2) is False
        (executor._phase_dir / "step2-output.json").write_text("{}", encoding="utf-8")
        assert executor._prior_attempt_exists(2) is True

    def test_preamble_warns_when_resuming(self, executor):
        text = executor._build_preamble("G", "", resumed=True)
        assert "재개" in text
        assert "덮어쓰" in text

    def test_preamble_silent_without_prior_attempt(self, executor):
        text = executor._build_preamble("G", "")
        assert "재개" not in text

    def test_resume_notice_reaches_the_session(self, executor):
        """이전 출력 파일이 있으면 첫 시도의 프롬프트에 재개 안내가 붙는다."""
        (executor._phase_dir / "step2-output.json").write_text("{}", encoding="utf-8")
        step = {"step": 2, "name": "ui", "status": "pending"}

        def fake_invoke(step_arg, preamble):
            index = json.loads(executor._index_file.read_text(encoding="utf-8"))
            for s in index["steps"]:
                if s["step"] == 2:
                    s["status"] = "completed"
                    s["summary"] = "done"
            executor._index_file.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
            fake_invoke.preamble = preamble
            return {"exitCode": 0, "stdout": "{}", "stderr": ""}

        with patch.object(executor, "_invoke_claude", side_effect=fake_invoke), \
             patch.object(executor, "_commit_step"):
            assert executor._execute_single_step(step, "guardrails") is True

        assert "재개" in fake_invoke.preamble

    def test_signal_without_artifacts_is_not_a_resume(self, executor):
        """출력 파일이 있어도 남긴 것이 없으면 재개가 아니다 (M13).

        런 #5 에서 25초 만에 한도로 잘려 소스를 한 줄도 못 쓴 step 이 다음
        실행에서 재개로 판정됐다. "돌았다"와 "남겼다"는 다른 사실이다.
        """
        (executor._phase_dir / "step2-output.json").write_text("{}", encoding="utf-8")

        def fake_git(*args):
            if args[0] == "status":
                return MagicMock(returncode=0, stdout="", stderr="")
            if args[0] == "log":
                return MagicMock(returncode=0, stdout="", stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")
        executor._run_git = fake_git

        assert executor._prior_attempt_exists(2) is False

    def test_uncommitted_owned_change_counts_as_artifact(self, executor):
        """한도가 커밋 직전에 떨어진 런 #3 의 형태 — 소스는 디스크에 있다."""
        (executor._phase_dir / "step2-output.json").write_text("{}", encoding="utf-8")

        def fake_git(*args):
            if args[0] == "status":
                return MagicMock(returncode=0, stdout=_porcelain("src/lib/thing.ts"),
                                 stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")
        executor._run_git = fake_git

        assert executor._prior_attempt_exists(2) is True

    def test_step_feat_commit_counts_as_artifact(self, executor):
        """세션이 스스로 커밋했으면 작업 트리는 깨끗하다 — 그래도 산출물이다."""
        (executor._phase_dir / "step2-output.json").write_text("{}", encoding="utf-8")

        def fake_git(*args):
            if args[0] == "status":
                return MagicMock(returncode=0, stdout="", stderr="")
            if args[0] == "log":
                return MagicMock(returncode=0, stdout="abc1234 feat(mvp): step 2 — ui",
                                 stderr="")
            return MagicMock(returncode=0, stdout="", stderr="")
        executor._run_git = fake_git

        assert executor._prior_attempt_exists(2) is True

    def test_unanswerable_git_falls_back_to_resume(self, executor):
        """판정할 수 없으면 재개로 본다 — 두 오류의 값이 다르다."""
        (executor._phase_dir / "step2-output.json").write_text("{}", encoding="utf-8")
        executor._run_git = lambda *a: MagicMock(returncode=128, stdout="", stderr="x")

        assert executor._prior_attempt_exists(2) is True

    def test_retry_does_not_claim_resume(self, executor):
        """같은 런의 재시도는 '중단된 step'이 아니다 — 재시도 안내가 따로 있다."""
        step = {"step": 2, "name": "ui", "status": "pending"}
        seen = []

        def fake_invoke(step_arg, preamble):
            seen.append(preamble)
            (executor._phase_dir / "step2-output.json").write_text("{}", encoding="utf-8")
            index = json.loads(executor._index_file.read_text(encoding="utf-8"))
            for s in index["steps"]:
                if s["step"] == 2:
                    if len(seen) >= 2:
                        s["status"] = "completed"
                        s["summary"] = "done"
                    else:
                        s["status"] = "error"
                        s["error_message"] = "boom"
            executor._index_file.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
            return {"exitCode": 0, "stdout": "{}", "stderr": ""}

        with patch.object(executor, "_invoke_claude", side_effect=fake_invoke), \
             patch.object(executor, "_commit_step"):
            executor._execute_single_step(step, "guardrails")

        assert len(seen) == 2
        assert "재개" not in seen[0], "첫 시도에는 이전 산출물이 없었다"
        assert "이전 시도 실패" in seen[1]
        assert "재개" not in seen[1], "같은 런의 재시도를 재개로 오해하면 안 된다"


# ---------------------------------------------------------------------------
# RUNNING 파일 — 실행 중 상태의 외재화 (M10)
# ---------------------------------------------------------------------------

def _write_running(phase_dir, *, step=None, age_sec=0, pid=4242):
    """heartbeat 를 age_sec 만큼 과거로 찍은 RUNNING 파일을 만든다."""
    tz = ex.StepExecutor.TZ
    beat = (datetime.now(tz) - timedelta(seconds=age_sec)).strftime("%Y-%m-%dT%H:%M:%S%z")
    payload = {"pid": pid, "host": "otherbox", "phase": "mvp",
               "step": step, "started_at": beat, "heartbeat": beat}
    path = phase_dir / ex.RUNNING_FILENAME
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class TestRunningFile:
    """started_at 은 있고 출력 파일은 없는 상태가 '진행 중'과 '죽었음'을
    동시에 뜻해 관찰자가 둘을 구분할 수 없었다 (파일럿 결함 M10).
    런 #4에서 감독 세션이 살아 있는 step 을 끊긴 것으로 오독했다.
    """

    def test_claim_writes_and_release_removes(self, executor):
        path = executor._phase_dir / ex.RUNNING_FILENAME
        assert not path.exists()

        executor._running.claim("mvp", step=2)
        assert path.exists()
        state = json.loads(path.read_text(encoding="utf-8"))
        assert state["pid"] == os.getpid()
        assert state["step"] == 2
        assert state["heartbeat"]

        executor._running.release()
        assert not path.exists()

    def test_release_is_idempotent(self, executor):
        executor._running.claim("mvp")
        executor._running.release()
        executor._running.release()

    def test_fresh_running_refuses_a_second_executor(self, executor, capsys):
        """실행기 둘이 같은 index.json 을 고치면 산출물이 서로를 덮는다."""
        _write_running(executor._phase_dir, step=1, age_sec=5)

        with pytest.raises(SystemExit) as exc:
            executor._claim_running()
        assert exc.value.code == 2

        out = capsys.readouterr().out
        assert "이미 실행 중" in out
        assert "4242" in out, "사람이 어느 프로세스인지 알아야 한다"

    def test_stale_running_is_reclaimed(self, executor, capsys):
        _write_running(executor._phase_dir, step=2, age_sec=ex.STALE_AFTER_SEC + 60)

        executor._claim_running()

        assert executor._stale_step == 2
        assert "회수" in capsys.readouterr().out
        executor._running.release()

    def test_stale_running_is_a_resume_signal(self, executor):
        """M10 의 좁은 형태 — 출력 파일을 쓰기 전에 세션이 죽은 경우.

        step{N}-output.json 은 claude 서브프로세스가 반환한 뒤에야 쓰인다.
        그전에 죽으면 재개 신호가 통째로 비어 있었다.
        """
        assert executor._prior_attempt_exists(2) is False

        _write_running(executor._phase_dir, step=2, age_sec=ex.STALE_AFTER_SEC + 60)
        executor._claim_running()

        assert executor._prior_attempt_exists(2) is True
        assert executor._prior_attempt_exists(1) is False, "다른 step 까지 재개로 보면 안 된다"
        executor._running.release()

    def test_unreadable_heartbeat_counts_as_alive(self, executor):
        """모르는 상태에서 남의 런을 죽었다고 단정하지 않는다 — M10 의 오판이 그것이었다."""
        assert executor._running.is_fresh({"pid": 1}) is True
        assert executor._running.is_fresh({"heartbeat": "쓰레기"}) is True
        assert executor._running.age_sec({"heartbeat": "쓰레기"}) is None

    def test_heartbeat_advances_while_running(self, executor):
        """실행기의 타임스탬프는 초 단위라 벽시계로 재면 흔들린다 — 시계를 주입한다."""
        ticks = iter("t%03d" % i for i in range(1, 10_000))
        running = ex.RunningFile(executor._phase_dir / ex.RUNNING_FILENAME,
                                 lambda: next(ticks), interval=0.01)
        running.claim("mvp", step=0)
        try:
            first = running.read()["heartbeat"]
            deadline = time.monotonic() + 5.0
            latest = first
            while time.monotonic() < deadline and latest == first:
                latest = running.read()["heartbeat"]
                time.sleep(0.01)
        finally:
            running.release()
        assert latest != first, "heartbeat 가 멈추면 살아 있는 런이 죽은 것으로 보인다"

    def test_heartbeat_stops_after_release(self, executor):
        """정지가 곧 '죽었다'는 신호다 — release 후에도 뛰면 유령이 살아 있는 척한다."""
        ticks = iter("t%03d" % i for i in range(1, 10_000))
        path = executor._phase_dir / ex.RUNNING_FILENAME
        running = ex.RunningFile(path, lambda: next(ticks), interval=0.01)
        running.claim("mvp", step=0)
        running.release()

        assert not path.exists()
        time.sleep(0.1)
        assert not path.exists(), "release 뒤에 heartbeat 가 파일을 되살리면 안 된다"

    def test_concurrent_reads_never_see_a_half_written_file(self, executor):
        """제자리 쓰기는 truncate 와 write 사이에 빈 파일을 노출한다.

        하필 그때 다른 실행기가 읽으면 read() 가 None 이 되고 "실행 중인 런이
        없다"로 판정해 그대로 시작한다 — RUNNING 이 막으려는 바로 그 사고다.
        """
        running = ex.RunningFile(executor._phase_dir / ex.RUNNING_FILENAME,
                                 executor._stamp, interval=0.001)
        running.claim("mvp", step=0)
        try:
            deadline = time.monotonic() + 2.0
            reads = 0
            while time.monotonic() < deadline:
                assert running.read() is not None, "반쯤 쓰인 RUNNING 이 읽혔다"
                reads += 1
            assert reads > 50
        finally:
            running.release()

    def test_never_calls_os_kill(self, executor):
        """Windows 에서 os.kill(pid, 0) 은 생존 확인이 아니라 프로세스 종료다.

        CPython 은 Windows 에서 CTRL_C_EVENT·CTRL_BREAK_EVENT 가 아닌 시그널을
        OpenProcess + TerminateProcess 로 처리한다. POSIX 관용구를 그대로 옮기면
        M10 이 막으려는 사고를 M10 수정이 일으킨다.
        """
        _write_running(executor._phase_dir, step=1, age_sec=ex.STALE_AFTER_SEC + 60)
        with patch("os.kill") as killer:
            executor._claim_running()
            executor._running.release()
        killer.assert_not_called()

    def test_run_removes_running_even_when_a_step_blocks(self, executor):
        """blocked 는 sys.exit(2) 로 빠진다 — finally 가 없으면 유령 파일이 남는다."""
        path = executor._phase_dir / ex.RUNNING_FILENAME

        def blow_up():
            assert path.exists(), "step 실행 중에는 RUNNING 이 있어야 한다"
            sys.exit(2)

        with patch.object(executor, "_print_header"), \
             patch.object(executor, "_check_blockers"), \
             patch.object(executor, "_checkout_branch"), \
             patch.object(executor, "_load_guardrails", return_value="G"), \
             patch.object(executor, "_ensure_created_at"), \
             patch.object(executor, "_execute_all_steps", side_effect=blow_up), \
             patch.object(executor, "_finalize"):
            with pytest.raises(SystemExit):
                executor.run()

        assert not path.exists(), "유령 RUNNING 이 남으면 다음 런이 통째로 막힌다"


# ---------------------------------------------------------------------------
# attempts — 재시도 횟수를 기록한다
# ---------------------------------------------------------------------------

class TestAttemptsRecorded:
    """'재시도 0회'가 데이터가 아니라 콘솔을 지켜본 사람의 기억이었다.

    파일럿 20 step 은 attempts 를 어디에도 남기지 않았다. 재지 않은 값에서
    상한을 유도할 수는 없다 (ROADMAP 17 · ADR-H007).
    """

    def _run_step(self, executor, fail_times):
        seen = []

        def fake_invoke(step_arg, preamble):
            seen.append(preamble)
            index = json.loads(executor._index_file.read_text(encoding="utf-8"))
            for s in index["steps"]:
                if s["step"] == 2:
                    if len(seen) > fail_times:
                        s["status"] = "completed"
                        s["summary"] = "done"
                    else:
                        s["status"] = "error"
                        s["error_message"] = "boom"
            executor._index_file.write_text(json.dumps(index, ensure_ascii=False),
                                            encoding="utf-8")
            return {"exitCode": 0, "stdout": "{}", "stderr": ""}

        with patch.object(executor, "_invoke_claude", side_effect=fake_invoke), \
             patch.object(executor, "_commit_step"):
            executor._execute_single_step({"step": 2, "name": "ui", "status": "pending"},
                                          "guardrails")
        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        return next(s for s in index["steps"] if s["step"] == 2)

    def test_records_one_attempt_on_first_pass(self, executor):
        step = self._run_step(executor, fail_times=0)
        assert step["attempts"] == 1, "'없음'과 '0회'를 같은 칸에 쓰지 않는다"

    def test_records_the_retry_count(self, executor):
        step = self._run_step(executor, fail_times=1)
        assert step["attempts"] == 2

    def test_records_attempts_on_final_failure(self, executor):
        with pytest.raises(SystemExit):
            self._run_step(executor, fail_times=99)
        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        step = next(s for s in index["steps"] if s["step"] == 2)
        assert step["status"] == "error"
        assert step["attempts"] == executor._retry_limit


class TestRetryLimitFromCalibration:
    """MAX_RETRIES 는 상한이 아니라 바닥값이다. 상한은 실측이 준다 (ADR-H007)."""

    def _make(self, tmp_project, derived):
        (tmp_project / "harness").mkdir(exist_ok=True)
        (tmp_project / "harness" / "config.json").write_text(
            json.dumps({"calibration_file": "harness/calibration.json"}), encoding="utf-8")
        (tmp_project / "harness" / "calibration.json").write_text(
            json.dumps({"derived": derived}), encoding="utf-8")
        with patch.object(ex, "ROOT", tmp_project):
            return ex.StepExecutor("0-mvp")

    def test_uses_derived_budget(self, tmp_project, phase_dir):
        assert self._make(tmp_project, {"retry_budget": 2})._retry_limit == 2

    def test_falls_back_when_unmeasured(self, tmp_project, phase_dir):
        inst = self._make(tmp_project, {"retry_budget": None})
        assert inst._retry_limit == ex.StepExecutor.MAX_RETRIES

    def test_falls_back_without_calibration_file(self, executor):
        assert executor._retry_limit == ex.StepExecutor.MAX_RETRIES

    def test_preamble_states_the_effective_limit(self, tmp_project, phase_dir):
        inst = self._make(tmp_project, {"retry_budget": 2})
        assert "2회 수정 시도" in inst._build_preamble("G", "")

    def test_preamble_reserves_executor_owned_fields(self, executor):
        text = executor._build_preamble("G", "")
        assert "attempts" in text
        assert "RUNNING" in text


# ---------------------------------------------------------------------------
# 가드레일 문서 선택 (M15)
# ---------------------------------------------------------------------------

USAGE_STDOUT = json.dumps({
    "total_cost_usd": 1.5094965,
    "num_turns": 32,
    "usage": {
        "cache_read_input_tokens": 375915,
        "cache_creation_input_tokens": 121798,
        "output_tokens": 896,
    },
})


class TestGuardrailDocSelection:
    """step 이 쓰지 않는 문서를 turn 마다 다시 읽는 것이 청구 토큰의 대부분이었다.

    다섯 런 실측: cache_read 110.3M(청구의 95.4%) · turn 당 접두부 147k ·
    그 접두부의 86.9%가 CLAUDE.md + docs/*.md 전량 주입이다 (M15).
    """

    def test_selected_docs_only(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project):
            result = executor._load_guardrails(["arch"])
        assert "# Architecture" in result
        assert "# Guide" not in result

    def test_claude_md_is_always_injected(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project):
            result = executor._load_guardrails([])
        assert "# Rules" in result, "CRITICAL 규칙 원본은 뺄 수 없다"
        assert "# Architecture" not in result

    def test_none_injects_everything(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project):
            result = executor._load_guardrails(None)
        assert "# Architecture" in result and "# Guide" in result

    def test_unknown_doc_name_is_refused(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project), pytest.raises(SystemExit) as e:
            executor._load_guardrails(["arch", "nope"])
        assert e.value.code == 2, "없는 문서를 조용히 건너뛰면 규칙이 소리 없이 빠진다"

    # --- 선택 출처의 우선순위 ---

    def _with_config(self, tmp_project, project_block):
        (tmp_project / "harness").mkdir(exist_ok=True)
        (tmp_project / "harness" / "config.json").write_text(
            json.dumps({"project": project_block}, ensure_ascii=False), encoding="utf-8")

    def test_step_field_wins_over_config_default(self, executor, tmp_project):
        self._with_config(tmp_project, {"guardrail_docs": ["guide"]})
        with patch.object(ex, "ROOT", tmp_project):
            assert executor._resolve_step_docs({"step": 2, "docs": ["arch"]}) == ["arch"]

    def test_config_default_applies_when_step_is_silent(self, executor, tmp_project):
        self._with_config(tmp_project, {"guardrail_docs": ["guide"]})
        with patch.object(ex, "ROOT", tmp_project):
            assert executor._resolve_step_docs({"step": 2}) == ["guide"]

    def test_no_source_means_inject_everything(self, executor, tmp_project):
        self._with_config(tmp_project, {"name": "t"})
        with patch.object(ex, "ROOT", tmp_project):
            assert executor._resolve_step_docs({"step": 2}) is None

    def test_empty_list_is_a_choice_not_a_silence(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project):
            assert executor._resolve_step_docs({"step": 2, "docs": []}) == []


class TestGuardrailDocCrossCheck:
    """step 파일의 '읽어야 할 파일'을 주입 목록으로 쓰지 않고 검증에만 쓴다.

    프로즈 파싱이 빗나가도 문서가 조용히 빠지지 않게 하는 것이 요점이다.
    설계자가 프로즈에는 적고 index.json 필드에는 빠뜨리는 경우를 잡는다.
    """

    def _step_file(self, phase_dir, body):
        (phase_dir / "step2.md").write_text(body, encoding="utf-8")

    def test_declared_doc_missing_from_docs_is_refused(self, executor, phase_dir):
        self._step_file(phase_dir, "# Step 2\n\n## 읽어야 할 파일\n\n- `/docs/guide.md`\n")
        with pytest.raises(SystemExit) as e:
            executor._verify_doc_selection(2, ["arch"])
        assert e.value.code == 2

    def test_declared_subset_passes(self, executor, phase_dir):
        self._step_file(phase_dir, "# Step 2\n\n## 읽어야 할 파일\n\n- `/docs/arch.md`\n")
        executor._verify_doc_selection(2, ["arch", "guide"])

    def test_step_file_without_the_section_passes(self, executor, phase_dir):
        self._step_file(phase_dir, "# Step 2\n\n## 작업\n\n- `/docs/guide.md` 를 본문에서 언급")
        executor._verify_doc_selection(2, ["arch"])

    def test_only_that_section_is_scanned(self, executor, phase_dir):
        self._step_file(
            phase_dir,
            "# Step 2\n\n## 읽어야 할 파일\n\n- `/docs/arch.md`\n\n## 작업\n\n- `/docs/guide.md` 갱신\n")
        executor._verify_doc_selection(2, ["arch"])

    def test_none_skips_the_check(self, executor, phase_dir):
        self._step_file(phase_dir, "# Step 2\n\n## 읽어야 할 파일\n\n- `/docs/guide.md`\n")
        executor._verify_doc_selection(2, None)


# ---------------------------------------------------------------------------
# step 별 실측 기록 (M12)
# ---------------------------------------------------------------------------

class TestExtractUsage:
    def test_pulls_cost_turns_and_tokens(self):
        u = ex.StepExecutor._extract_usage({"stdout": USAGE_STDOUT})
        assert u["cost_usd"] == 1.5095
        assert u["turns"] == 32
        assert u["cache_read"] == 375915
        assert u["cache_write"] == 121798
        assert u["output_tokens"] == 896

    def test_unparsable_output_yields_nothing(self):
        assert ex.StepExecutor._extract_usage({"stdout": "not json"}) == {}

    def test_missing_fields_are_not_invented(self):
        u = ex.StepExecutor._extract_usage({"stdout": json.dumps({"usage": {}})})
        assert u == {}, "모르는 값을 0 으로 적으면 실측이 오염된다"


class TestRunsRecorded:
    """실행기는 소요·비용을 알면서 화면에 찍고 버렸다.

    재개된 step 은 started_at 이 첫 시도 것이라 completed_at 과의 차가
    대기 시간을 포함한다 — 런 #5 step 2 는 유도값 3573s, 실제 520s 였다 (M12).
    """

    def _run(self, executor, *, fail_times=0, stdout=USAGE_STDOUT, exit_code=0):
        calls = []

        def fake_invoke(step_arg, preamble):
            calls.append(preamble)
            index = json.loads(executor._index_file.read_text(encoding="utf-8"))
            for s in index["steps"]:
                if s["step"] == 2:
                    if len(calls) > fail_times:
                        s["status"] = "completed"
                        s["summary"] = "done"
                    else:
                        s["status"] = "error"
                        s["error_message"] = "boom"
            executor._index_file.write_text(json.dumps(index, ensure_ascii=False),
                                            encoding="utf-8")
            return {"exitCode": exit_code, "stdout": stdout, "stderr": "",
                    "prompt_chars": 113377}

        with patch.object(executor, "_invoke_claude", side_effect=fake_invoke), \
             patch.object(executor, "_commit_step"):
            executor._execute_single_step({"step": 2, "name": "ui", "status": "pending"},
                                          "guardrails")
        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        return next(s for s in index["steps"] if s["step"] == 2)

    def test_success_records_one_run(self, executor):
        step = self._run(executor)
        assert len(step["runs"]) == 1
        run = step["runs"][0]
        assert run["attempt"] == 1
        assert run["outcome"] == "completed"
        assert run["cost_usd"] == 1.5095
        assert run["turns"] == 32
        assert run["prompt_chars"] == 113377
        assert isinstance(run["elapsed_sec"], int)

    def test_retry_keeps_the_failed_attempt(self, executor):
        step = self._run(executor, fail_times=1)
        assert [r["outcome"] for r in step["runs"]] == ["retry", "completed"]
        assert [r["attempt"] for r in step["runs"]] == [1, 2]

    def test_final_failure_is_recorded(self, executor):
        with pytest.raises(SystemExit):
            self._run(executor, fail_times=99)
        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        step = next(s for s in index["steps"] if s["step"] == 2)
        assert step["runs"][-1]["outcome"] == "error"
        assert len(step["runs"]) == executor._retry_limit

    def test_usage_limit_attempt_keeps_its_cost(self, executor):
        """재개가 step{N}-output.json 을 덮어써 차단분의 비용이 사라졌다 (런 #5)."""
        limit = json.dumps({"is_error": True, "api_error_status": 429,
                            "result": "session limit", "total_cost_usd": 1.51,
                            "num_turns": 3})
        with pytest.raises(SystemExit) as e:
            self._run(executor, fail_times=99, stdout=limit, exit_code=1)
        assert e.value.code == 2
        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        step = next(s for s in index["steps"] if s["step"] == 2)
        assert len(step["runs"]) == 1
        assert step["runs"][0]["outcome"] == "blocked"
        assert step["runs"][0]["cost_usd"] == 1.51

    def test_records_which_docs_were_injected(self, executor):
        step = self._run(executor)
        assert step["runs"][0]["guardrail_chars"] == len("guardrails")


# ---------------------------------------------------------------------------
# step 이 지목한 소스를 실행기가 실어준다 (M16)
# ---------------------------------------------------------------------------

class TestPrefixBudget:
    """접두부를 분해해서 잰다 (ROADMAP 28).

    ADR-H008 은 접두부를 줄이고 ADR-H009 는 늘리는데, 둘이 서로의 상한을
    모른다. 예산값을 정하려면 먼저 접두부가 무엇으로 이뤄져 있는지를
    런마다 남겨야 한다 — 실측 없는 상수를 상속하지 않는다.
    """

    def test_run_records_prefix_breakdown(self, executor):
        step = {"step": 2, "name": "ui", "status": "pending"}

        def fake_invoke(step_arg, preamble):
            index = json.loads(executor._index_file.read_text(encoding="utf-8"))
            for st in index["steps"]:
                if st["step"] == 2:
                    st["status"] = "completed"
                    st["summary"] = "done"
            executor._index_file.write_text(json.dumps(index, ensure_ascii=False),
                                            encoding="utf-8")
            body = (executor._phase_dir / "step2.md").read_text(encoding="utf-8")
            return {"exitCode": 0, "stdout": "{}", "stderr": "",
                    "prompt_chars": len(preamble) + len(body),
                    "preamble_chars": len(preamble)}

        with patch.object(executor, "_invoke_claude", side_effect=fake_invoke),              patch.object(executor, "_commit_step"):
            assert executor._execute_single_step(step, "guardrails") is True

        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        run = next(st for st in index["steps"] if st["step"] == 2)["runs"][0]
        assert run["preamble_chars"] > 0
        assert run["step_body_chars"] > 0
        assert run["prompt_chars"] == run["preamble_chars"] + run["step_body_chars"]
        assert run["context_chars"] > 0, "완료된 step 의 summary 누적도 접두부다"

    def test_prefix_breakdown_is_printed(self, executor, capsys):
        executor._report_prefix(1000, {"guardrail_chars": 600, "source_chars": 200}, 150)
        out = capsys.readouterr().out
        assert "접두부 1,000자" in out
        assert "가드레일 600" in out
        assert "소스 200" in out
        assert "상용구 50" in out, "분해가 합과 맞아야 예산을 어디 걸지 알 수 있다"

    def test_step_body_omitted_when_prompt_chars_missing(self, executor):
        """모르는 값을 0 으로 채우지 않는다 (ADR-H007)."""
        index = {"steps": [{"step": 2, "name": "ui", "status": "pending"}]}
        executor._record_run(index, 2, attempt=1, outcome="completed", elapsed=1,
                             out={"exitCode": 0, "stdout": "{}"}, guard_info={})
        entry = index["steps"][0]["runs"][0]
        assert "step_body_chars" not in entry
        assert "preamble_chars" not in entry


class TestSourceInjection:
    """읽기 turn 336회가 유발한 접두부 재독이 전체의 44.0%였다.

    파일을 turn k 에서 읽으면 s·(T−k) + 그 turn 의 접두부 재독이고,
    미리 실으면 s·T 다. 실측(s≈3,400 · k≈9.5 · 접두부≈133,000)에서
    읽기 하나를 없앨 때마다 약 100,000 문자·turn 이 절약된다 (M16).
    """

    def _src(self, tmp_project, rel, body="export const a = 1;\n"):
        p = tmp_project / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
        return p

    # --- 선택 ---

    def test_absent_field_means_no_injection(self, executor):
        assert executor._resolve_step_sources({"step": 2}) is None

    def test_field_is_used_as_given(self, executor):
        step = {"step": 2, "sources": ["src/lib/a.ts"]}
        assert executor._resolve_step_sources(step) == ["src/lib/a.ts"]

    # --- 적재 ---

    def test_none_produces_nothing(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project):
            assert executor._load_sources(None) == ""
            assert executor._load_sources([]) == ""

    def test_content_and_path_are_included(self, executor, tmp_project):
        self._src(tmp_project, "src/lib/a.ts", "export const MAGIC = 42;\n")
        with patch.object(ex, "ROOT", tmp_project):
            out = executor._load_sources(["src/lib/a.ts"])
        assert "src/lib/a.ts" in out
        assert "MAGIC = 42" in out

    def test_carries_the_stale_warning(self, executor, tmp_project):
        """편집 후에도 최신인 것처럼 읽히면 잘못된 코드를 만든다."""
        self._src(tmp_project, "src/lib/a.ts")
        with patch.object(ex, "ROOT", tmp_project):
            out = executor._load_sources(["src/lib/a.ts"])
        assert "시작 시점" in out

    def test_missing_path_is_refused(self, executor, tmp_project):
        with patch.object(ex, "ROOT", tmp_project), pytest.raises(SystemExit) as e:
            executor._load_sources(["src/lib/nope.ts"])
        assert e.value.code == 2

    def test_over_the_cap_is_refused(self, executor, tmp_project):
        """접두부는 모든 turn 에 곱해진다 — 상한 없는 첨부는 개선이 아니라 악화다."""
        self._src(tmp_project, "src/lib/big.ts", "x" * 200_000)
        with patch.object(ex, "ROOT", tmp_project), pytest.raises(SystemExit) as e:
            executor._load_sources(["src/lib/big.ts"])
        assert e.value.code == 2

    def test_cap_comes_from_config(self, executor, tmp_project):
        self._src(tmp_project, "src/lib/mid.ts", "y" * 5_000)
        (tmp_project / "harness").mkdir(exist_ok=True)
        (tmp_project / "harness" / "config.json").write_text(
            json.dumps({"project": {"source_inject_max_chars": 100}}), encoding="utf-8")
        with patch.object(ex, "ROOT", tmp_project), pytest.raises(SystemExit) as e:
            executor._load_sources(["src/lib/mid.ts"])
        assert e.value.code == 2

    def test_fence_longer_than_any_run_inside(self, executor, tmp_project):
        """본문에 ``` 가 있으면 세 겹 울타리로는 블록이 중간에 닫힌다."""
        self._src(tmp_project, "src/lib/md.ts", "const s = ````` fence `````;\n")
        with patch.object(ex, "ROOT", tmp_project):
            out = executor._load_sources(["src/lib/md.ts"])
        assert "`````" in out

    # --- 교차검증 ---

    def test_declared_source_missing_from_field_is_refused(self, executor, phase_dir, tmp_project):
        self._src(tmp_project, "src/lib/a.ts")
        (phase_dir / "step2.md").write_text(
            "# Step 2\n\n## 읽어야 할 파일\n\n- `src/lib/a.ts`\n", encoding="utf-8")
        with patch.object(ex, "ROOT", tmp_project), pytest.raises(SystemExit) as e:
            executor._verify_source_selection(2, [])
        assert e.value.code == 2

    def test_docs_are_not_treated_as_sources(self, executor, phase_dir, tmp_project):
        """docs/*.md 는 steps[].docs 가 담당한다 — 여기서 또 요구하지 않는다."""
        (phase_dir / "step2.md").write_text(
            "# Step 2\n\n## 읽어야 할 파일\n\n- `/docs/arch.md`\n", encoding="utf-8")
        with patch.object(ex, "ROOT", tmp_project):
            executor._verify_source_selection(2, [])

    def test_paths_that_do_not_exist_are_not_demanded(self, executor, phase_dir, tmp_project):
        """step 이 '만들 파일'을 적어 두는 경우가 있다. 없는 것을 요구하면 시작이 막힌다."""
        (phase_dir / "step2.md").write_text(
            "# Step 2\n\n## 읽어야 할 파일\n\n- `src/lib/tobecreated.ts`\n", encoding="utf-8")
        with patch.object(ex, "ROOT", tmp_project):
            executor._verify_source_selection(2, [])

    def test_none_skips_the_check(self, executor, phase_dir, tmp_project):
        self._src(tmp_project, "src/lib/a.ts")
        (phase_dir / "step2.md").write_text(
            "# Step 2\n\n## 읽어야 할 파일\n\n- `src/lib/a.ts`\n", encoding="utf-8")
        with patch.object(ex, "ROOT", tmp_project):
            executor._verify_source_selection(2, None)

    # --- 프롬프트와 기록 ---

    def test_preamble_carries_the_section(self, executor):
        text = executor._build_preamble("G", "", sources="## 소스\n\nBODY")
        assert "BODY" in text

    def test_run_records_source_chars(self, executor):
        seen = []

        def fake_invoke(step_arg, preamble):
            seen.append(preamble)
            index = json.loads(executor._index_file.read_text(encoding="utf-8"))
            for s in index["steps"]:
                if s["step"] == 2:
                    s["status"] = "completed"; s["summary"] = "done"
            executor._index_file.write_text(json.dumps(index, ensure_ascii=False),
                                            encoding="utf-8")
            return {"exitCode": 0, "stdout": "{}", "stderr": ""}

        with patch.object(executor, "_invoke_claude", side_effect=fake_invoke), \
             patch.object(executor, "_commit_step"):
            executor._execute_single_step({"step": 2, "name": "ui", "status": "pending"},
                                          "guardrails")
        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        step = next(s for s in index["steps"] if s["step"] == 2)
        assert step["runs"][0]["source_chars"] == 0


# ---------------------------------------------------------------------------
# 세션이 끌어온 양 — 트랜스크립트 사후 집계 (ROADMAP 29 · ADR-H011)
# ---------------------------------------------------------------------------

def _jsonl(path: Path, records: list) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records),
                    encoding="utf-8")
    return path


def _tool_use(name: str, tid: str = "t1") -> dict:
    return {"type": "assistant", "isSidechain": False,
            "message": {"content": [{"type": "tool_use", "id": tid, "name": name,
                                     "input": {"command": "cat x"}}]}}


def _tool_result(text: str, tid: str = "t1", *, raw=None, sidechain=False) -> dict:
    rec = {"type": "user", "isSidechain": sidechain,
           "message": {"content": [{"type": "tool_result", "tool_use_id": tid,
                                    "content": text}]}}
    if raw is not None:
        rec["toolUseResult"] = {"stdout": raw, "stderr": ""}
    return rec


@pytest.fixture
def transcripts(tmp_path):
    """~/.claude/projects/<slug>/<session_id>.jsonl 을 흉내내는 루트."""
    root = tmp_path / "transcripts"
    (root / "C--some-slug").mkdir(parents=True)
    return root


class TestSessionMetrics:
    """접두부는 재는데 세션이 **직접 끌어온 양**은 아무도 재지 않았다.

    런 #7·#8 이 두 번 연속 "접두부가 크면 비싸다"를 반증했고, 런 #8 이
    진짜 변수를 지목했다 — 첨부되지 않아 세션이 직접 읽어야 했던 양이다.
    재지 않는 것을 근거로 상수를 정할 수 없다 (ROADMAP 28·29).
    """

    def test_sums_tool_result_chars(self, transcripts):
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("가" * 100, "t1"),
            _tool_use("Bash", "t2"), _tool_result("나" * 250, "t2"),
        ])
        m = ex.StepExecutor._read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_chars"] == 350
        assert m["tool_result_count"] == 2
        assert m["session_id"] == "abc"

    def test_raw_output_is_a_separate_number(self, transcripts):
        """16KB 를 넘는 출력은 파일로 빠지고 블록은 잘린다.

        컨텍스트에 들어간 것은 잘린 쪽이고, 둘의 차가 잘린 양이다.
        한 숫자로 뭉치면 어느 쪽인지 알 수 없다.
        """
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"),
            _tool_result("x" * 200, "t1", raw="x" * 9000),
        ])
        m = ex.StepExecutor._read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_chars"] == 200
        assert m["tool_output_chars"] == 9000

    def test_counts_tool_calls_by_name_without_classifying(self, transcripts):
        """이름으로 '읽기/쓰기'를 가르지 않는다.

        step 세션은 bashFirst 로 돌아 cat·sed·grep 으로 읽고 heredoc 으로
        쓴다 — 런 #8 step 0 은 도구 호출 15건이 전부 Bash 다. 이름으로
        분류하면 틀린 숫자가 나오고, 틀린 숫자는 없는 숫자보다 나쁘다.
        """
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("a", "t1"),
            _tool_use("Bash", "t2"), _tool_result("b", "t2"),
            _tool_use("Edit", "t3"), _tool_result("c", "t3"),
        ])
        m = ex.StepExecutor._read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_calls"] == {"Bash": 2, "Edit": 1}

    def test_sidechain_records_are_excluded(self, transcripts):
        """서브에이전트의 도구 결과는 메인 컨텍스트에 들어가지 않는다.

        여덟 런 모두 spawned:0 이라 지금은 차이가 없지만, 8페이즈
        파이프라인은 리뷰어를 서브에이전트로 부른다.
        """
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("가" * 100, "t1"),
            _tool_result("나" * 5000, "t2", sidechain=True),
        ])
        m = ex.StepExecutor._read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_chars"] == 100
        assert m["tool_result_count"] == 1

    def test_missing_transcript_yields_nothing(self, transcripts):
        """0 으로 채우면 '재지 않았다'와 '0 이었다'가 같은 칸에 들어간다 (ADR-H007)."""
        assert ex.StepExecutor._read_session_metrics("nope", transcript_root=transcripts) == {}

    def test_missing_session_id_yields_nothing(self, transcripts):
        assert ex.StepExecutor._read_session_metrics(None, transcript_root=transcripts) == {}
        assert ex.StepExecutor._read_session_metrics("", transcript_root=transcripts) == {}

    def test_broken_lines_are_skipped_not_fatal(self, transcripts):
        p = transcripts / "C--some-slug" / "abc.jsonl"
        _jsonl(p, [_tool_use("Bash", "t1"), _tool_result("가" * 40, "t1")])
        p.write_text(p.read_text(encoding="utf-8") + "\n{not json\n", encoding="utf-8")
        m = ex.StepExecutor._read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_chars"] == 40

    def test_finds_transcript_under_any_slug(self, transcripts):
        """슬러그를 유도하지 않는다 — 이 리포는 경로 casing 함정에 두 번 물렸다.

        session_id 는 UUID 라 glob 하나로 유일하게 잡힌다.
        """
        (transcripts / "C--Users-hyu13-PROJECT-x").mkdir()
        _jsonl(transcripts / "C--Users-hyu13-PROJECT-x" / "zzz.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("y" * 77, "t1"),
        ])
        m = ex.StepExecutor._read_session_metrics("zzz", transcript_root=transcripts)
        assert m["tool_result_chars"] == 77

    def test_list_shaped_result_content_is_counted(self, transcripts):
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"),
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1",
                 "content": [{"type": "text", "text": "가" * 30}]}]}},
        ])
        m = ex.StepExecutor._read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_chars"] == 30


class TestSessionId:
    def test_pulls_session_id(self):
        out = {"stdout": json.dumps({"session_id": "abc-123", "num_turns": 3})}
        assert ex.StepExecutor._session_id(out) == "abc-123"

    def test_unparsable_or_absent_is_none(self):
        assert ex.StepExecutor._session_id({"stdout": "not json"}) is None
        assert ex.StepExecutor._session_id({"stdout": "{}"}) is None


class TestRunRecordsPull:
    def _complete(self, executor, stdout):
        def fake_invoke(step_arg, preamble):
            index = json.loads(executor._index_file.read_text(encoding="utf-8"))
            for s in index["steps"]:
                if s["step"] == 2:
                    s["status"] = "completed"; s["summary"] = "done"
            executor._index_file.write_text(json.dumps(index, ensure_ascii=False),
                                            encoding="utf-8")
            return {"exitCode": 0, "stdout": stdout, "stderr": ""}

        with patch.object(executor, "_invoke_claude", side_effect=fake_invoke), \
             patch.object(executor, "_commit_step"):
            executor._execute_single_step({"step": 2, "name": "ui", "status": "pending"},
                                          "guardrails")
        index = json.loads(executor._index_file.read_text(encoding="utf-8"))
        return next(s for s in index["steps"] if s["step"] == 2)["runs"][0]

    def test_run_carries_the_pull(self, executor, transcripts):
        _jsonl(transcripts / "C--some-slug" / "sid-1.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("가" * 4321, "t1"),
        ])
        with patch.object(ex, "TRANSCRIPT_ROOT", transcripts):
            run = self._complete(executor, json.dumps({"session_id": "sid-1"}))
        assert run["tool_result_chars"] == 4321
        assert run["session_id"] == "sid-1"
        assert run["reads_source"] == "live"

    def test_unmeasurable_pull_creates_no_keys(self, executor, transcripts):
        with patch.object(ex, "TRANSCRIPT_ROOT", transcripts):
            run = self._complete(executor, json.dumps({"session_id": "gone"}))
        assert "tool_result_chars" not in run
        assert "reads_source" not in run

    def test_pull_is_printed(self, executor, capsys):
        executor._report_pull({"tool_result_chars": 61997, "tool_result_count": 43},
                              preamble_chars=81798)
        out = capsys.readouterr().out
        assert "61,997자" in out
        assert "43건" in out
        assert "81,798" in out

    def test_nothing_printed_when_unmeasured(self, executor, capsys):
        executor._report_pull({}, preamble_chars=81798)
        assert capsys.readouterr().out == ""


# ---------------------------------------------------------------------------
# 백필 — 여덟 런 41 step 을 사후 집계한다 (ROADMAP 29)
# ---------------------------------------------------------------------------

sys.path.insert(0, str(Path(__file__).parent))
import backfill_reads as bf  # noqa: E402


class TestBackfillReads:
    """트랜스크립트에 있는 값이므로 사후 집계가 된다.

    백필하지 않으면 ROADMAP 28 의 예산값은 런 #9 부터 표본을 쌓아야 하고,
    이미 여덟 런이 남긴 41 step 은 버려진다.
    """

    def _phase(self, tmp_path, *, runs=True, session="sid-1"):
        d = tmp_path / "phases" / "0-mvp"
        d.mkdir(parents=True)
        step = {"step": 0, "name": "setup", "status": "completed"}
        if runs:
            step["runs"] = [{"attempt": 1, "outcome": "completed", "turns": 16}]
        (d / "index.json").write_text(
            json.dumps({"phase": "mvp", "steps": [step]}, ensure_ascii=False),
            encoding="utf-8")
        (d / "step0-output.json").write_text(
            json.dumps({"step": 0, "stdout": json.dumps({"session_id": session})}),
            encoding="utf-8")
        (tmp_path / "phases" / "index.json").write_text(
            json.dumps({"phases": [{"dir": "0-mvp", "status": "completed"}]}),
            encoding="utf-8")
        return d

    def _transcript(self, transcripts, session, chars):
        _jsonl(transcripts / "C--some-slug" / f"{session}.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("가" * chars, "t1"),
        ])

    def _index(self, phase_dir):
        return json.loads((phase_dir / "index.json").read_text(encoding="utf-8"))

    def test_fills_the_last_run(self, tmp_path, transcripts):
        d = self._phase(tmp_path, runs=True)
        self._transcript(transcripts, "sid-1", 5000)
        bf.backfill(tmp_path, transcript_root=transcripts)
        run = self._index(d)["steps"][0]["runs"][-1]
        assert run["tool_result_chars"] == 5000
        assert run["reads_source"] == "backfill"
        assert run["turns"] == 16, "기존 실측을 건드리지 않는다"

    def test_does_not_overwrite_existing_measurement(self, tmp_path, transcripts):
        """못 잰 것이 잰 것을 지우면 안 된다 — M12·M14 가 두 번 열렸던 자리다."""
        d = self._phase(tmp_path, runs=True)
        idx = self._index(d)
        idx["steps"][0]["runs"][-1].update(tool_result_chars=111, reads_source="live")
        (d / "index.json").write_text(json.dumps(idx, ensure_ascii=False), encoding="utf-8")
        self._transcript(transcripts, "sid-1", 5000)
        rows = bf.backfill(tmp_path, transcript_root=transcripts)
        run = self._index(d)["steps"][0]["runs"][-1]
        assert run["tool_result_chars"] == 111
        assert run["reads_source"] == "live"
        assert rows[0]["action"] == "kept"

    def test_is_idempotent(self, tmp_path, transcripts):
        d = self._phase(tmp_path, runs=True)
        self._transcript(transcripts, "sid-1", 5000)
        bf.backfill(tmp_path, transcript_root=transcripts)
        first = self._index(d)
        rows = bf.backfill(tmp_path, transcript_root=transcripts)
        assert self._index(d) == first
        assert rows[0]["action"] == "kept"

    def test_dry_run_writes_nothing(self, tmp_path, transcripts):
        d = self._phase(tmp_path, runs=True)
        self._transcript(transcripts, "sid-1", 5000)
        before = (d / "index.json").read_text(encoding="utf-8")
        rows = bf.backfill(tmp_path, dry_run=True, transcript_root=transcripts)
        assert (d / "index.json").read_text(encoding="utf-8") == before
        assert rows[0]["tool_result_chars"] == 5000

    def test_step_without_runs_gets_an_entry_that_admits_it(self, tmp_path, transcripts):
        """런 #1~#5 의 26 step 에는 runs[] 가 없다 — M12 가 그 다음에 생겼다.

        시도 번호를 지어내지 않는다. 출력 파일은 **마지막 세션**만 증명하고
        그것이 몇 번째 시도였는지는 증명하지 않는다.
        """
        d = self._phase(tmp_path, runs=False)
        self._transcript(transcripts, "sid-1", 4242)
        bf.backfill(tmp_path, transcript_root=transcripts)
        runs = self._index(d)["steps"][0]["runs"]
        assert len(runs) == 1
        assert runs[0]["attempt"] is None
        assert runs[0]["tool_result_chars"] == 4242
        assert runs[0]["reads_source"] == "backfill"
        assert "outcome" not in runs[0], "모르는 것을 적지 않는다"

    def test_missing_transcript_is_reported_not_zeroed(self, tmp_path, transcripts):
        d = self._phase(tmp_path, runs=True, session="gone")
        rows = bf.backfill(tmp_path, transcript_root=transcripts)
        assert rows[0]["action"] == "unmeasured"
        assert "tool_result_chars" not in self._index(d)["steps"][0]["runs"][-1]

    def test_missing_output_file_does_not_crash(self, tmp_path, transcripts):
        d = self._phase(tmp_path, runs=True)
        (d / "step0-output.json").unlink()
        rows = bf.backfill(tmp_path, transcript_root=transcripts)
        assert rows[0]["action"] == "unmeasured"
