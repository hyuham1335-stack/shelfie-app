"""
execute.py 리팩터링 안전망 테스트.
리팩터링 전후 동작이 동일한지 검증한다.
"""

import json
import os
import subprocess
import sys
import textwrap
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

class TestCommitStep:
    def test_two_phase_commit(self, executor):
        calls = []
        def fake_git(*args):
            calls.append(args)
            if args[:2] == ("diff", "--cached"):
                return MagicMock(returncode=1)
            return MagicMock(returncode=0, stdout="", stderr="")
        executor._run_git = fake_git

        executor._commit_step(2, "ui")

        commit_calls = [c for c in calls if c[0] == "commit"]
        assert len(commit_calls) == 2
        assert "feat(mvp):" in commit_calls[0][2]
        assert "chore(mvp):" in commit_calls[1][2]

    def test_no_code_changes_skips_feat_commit(self, executor):
        call_count = {"diff": 0}
        calls = []
        def fake_git(*args):
            calls.append(args)
            if args[:2] == ("diff", "--cached"):
                call_count["diff"] += 1
                if call_count["diff"] == 1:
                    return MagicMock(returncode=0)
                return MagicMock(returncode=1)
            return MagicMock(returncode=0, stdout="", stderr="")
        executor._run_git = fake_git

        executor._commit_step(2, "ui")

        commit_msgs = [c[2] for c in calls if c[0] == "commit"]
        assert len(commit_msgs) == 1
        assert "chore" in commit_msgs[0]


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
