"""8페이즈 feature-pipeline (scripts/pipeline/) 의 테스트.

test_execute.py 의 관용구를 따른다 — pytest · tmp_path · 인스턴스 속성 직접 주입.
test_harness.py 가 unittest 인 것은 더 오래된 층이라 그렇고, 새 파일은 pytest 다.

그룹:
    A  봉투              — stdout 은 항상 단일 JSON 하나
    B  lint-phases       — 페이즈 파일이 깨진 채로 /feature 가 시작하지 않는다
    C  state             — 런 디렉터리 · 지문 · 이벤트 · 카운터
    D  페이즈 파서       — requires 4종 · 플레이스홀더
    E  01 판정           — quote · 커버리지 · 드리프트 · 단조성
    F  clean_ownership   — 소유 경계 · orphan
    G  게이트 · 귀속     — replay 픽스처
    H  adapters          — 스테이지 상태 · 타임아웃 · 선택자
    I  3단계 게이트 잠금 — 고유명사 0건 · 스택/언어 교체 무변경
"""

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS / "pipeline"))
sys.path.insert(0, str(_SCRIPTS))

import harness  # noqa: E402
import state as st  # noqa: E402
import cli  # noqa: E402
import adapters  # noqa: E402
import attribution as attr  # noqa: E402
import contract as contract_mod  # noqa: E402

ROOT = _SCRIPTS.parent


# ---------------------------------------------------------------------------
# 공용 픽스처
# ---------------------------------------------------------------------------

# 실물을 복사한다 — 실물이 바뀌면 이 테스트가 먼저 깨진다 (test_harness.py 와 같은 규율).
COPIED = [
    "harness/config.json",
    "harness/config.schema.json",
    "harness/adapters/adapter.schema.json",
    "harness/adapters/nextjs-ts.json",
    "harness/calibration.json",
    "harness/templates/contract.md",
    # 05 는 기동 전에 리뷰어 스킬의 실재를 확인한다. 실물을 복사해 두므로
    # 스킬 하나를 지우거나 이름을 바꾸면 이 테스트가 먼저 깨진다.
    ".claude/skills/data-layer-reviewer/SKILL.md",
    ".claude/skills/security-reviewer/SKILL.md",
    ".claude/skills/architecture-reviewer/SKILL.md",
    ".claude/skills/test-quality-reviewer/SKILL.md",
    ".claude/skills/docs-reviewer/SKILL.md",
]


def _git(root, *args):
    return subprocess.run(["git"] + list(args), cwd=str(root),
                          capture_output=True, text=True, encoding="utf-8")


@pytest.fixture
def repo(tmp_path):
    """실물 설정을 복사한 빈 git 리포. 실물 _workspace/ 를 건드리지 않는다."""
    for rel in COPIED:
        dst = tmp_path / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text((ROOT / rel).read_text(encoding="utf-8"), encoding="utf-8")

    (tmp_path / "src" / "lib").mkdir(parents=True)
    (tmp_path / "src" / "lib" / "match.ts").write_text(
        "export function matchTitle(a: string, b: string): number { return 0 }\n",
        encoding="utf-8")
    (tmp_path / "src" / "lib" / "match.test.ts").write_text(
        "import { matchTitle } from './match'\n", encoding="utf-8")
    (tmp_path / "CLAUDE.md").write_text("# 가드레일\n", encoding="utf-8")

    # 실물과 같게 _workspace/ 를 무시한다 — 계약 파일이 추적되는 orphan 이 되면
    # clean_ownership 이 잡는다.
    (tmp_path / ".gitignore").write_text("_workspace/\n", encoding="utf-8")

    _git(tmp_path, "init", "-q")
    _git(tmp_path, "config", "user.email", "t@example.com")
    _git(tmp_path, "config", "user.name", "t")
    _git(tmp_path, "add", "-A")
    _git(tmp_path, "commit", "-qm", "init")
    return tmp_path


@pytest.fixture
def request_file(repo):
    """실물 /feature 흐름과 같은 자리에 둔다 — _workspace/ 는 추적되지 않는다."""
    p = repo / "_workspace" / "requests" / "req.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("책 제목 유사도를 재는 함수를 만들어 줘 — 한글 포함\n", encoding="utf-8")
    return p


def _run_cli(root, *args):
    """실물 CLI 를 서브프로세스로 부른다 — 종료 코드와 stdout 오염을 함께 본다."""
    return subprocess.run(
        [sys.executable, str(_SCRIPTS / "pipeline" / "cli.py"), *args],
        cwd=str(root), capture_output=True, text=True, encoding="utf-8")


# ---------------------------------------------------------------------------
# A. 봉투 — stdout 은 항상 단일 JSON 하나
# ---------------------------------------------------------------------------

class TestEnvelope:
    """모델이 읽는 것은 render 와 next_command 둘뿐이다.

    그러려면 stdout 이 파싱 가능한 JSON 하나여야 한다. 진단 한 줄이 섞이면
    모델이 그 줄을 지시로 읽거나 파싱에 실패한다.
    """

    def test_envelope_has_every_required_key(self):
        env = st.envelope("next", ok=True, exit_=0, state=None,
                          data={}, render="...", next_command=None)
        for key in ("schema", "ok", "cmd", "exit", "run_id", "phase",
                    "state_summary", "data", "render", "next_command"):
            assert key in env, key

    def test_ok_agrees_with_exit_zero(self):
        assert st.envelope("next", True, 0, None, {}, "", None)["ok"] is True
        assert st.envelope("next", False, 4, None, {}, "", None)["ok"] is False

    def test_emit_returns_the_exit_code(self, capsys):
        code = st.emit(st.envelope("gate", False, 4, None, {}, "r", "c"))
        assert code == 4
        assert json.loads(capsys.readouterr().out)["exit"] == 4

    def test_emit_writes_exactly_one_json_object(self, capsys):
        st.emit(st.envelope("status", True, 0, None, {"a": 1}, "r", None))
        out = capsys.readouterr().out
        assert out.endswith("\n") and out.count("\n") == 1
        json.loads(out)          # 파싱되면 단일 객체다

    def test_non_ascii_survives(self, capsys):
        st.emit(st.envelope("next", True, 0, None, {}, "## 계약을 쓴다", None))
        out = capsys.readouterr().out
        assert "계약" in out, "ensure_ascii=False 여야 한다 — 이스케이프되면 render 가 안 읽힌다"
        assert json.loads(out)["render"] == "## 계약을 쓴다"

    def test_state_summary_carries_counters(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        st.counter_inc(s, "repair", 3)
        env = st.envelope("gate", False, 4, s, {}, "", None)
        assert env["state_summary"]["counters"]["repair"] == {"used": 1, "max": 3}
        assert env["state_summary"]["escalated"] is False
        assert env["run_id"] == s["run_id"]

    def test_cli_doctor_emits_a_parsable_envelope(self, repo):
        out = _run_cli(repo, "doctor")
        env = json.loads(out.stdout)
        assert env["cmd"] == "doctor"
        assert env["exit"] == out.returncode

    def test_cli_keeps_diagnostics_off_stdout(self, repo):
        """stdout 을 통째로 파싱할 수 있어야 한다. 진단은 stderr 로 간다."""
        out = _run_cli(repo, "status")
        json.loads(out.stdout)


# ---------------------------------------------------------------------------
# C. state — 런 디렉터리 · 지문 · 이벤트 · 카운터
# ---------------------------------------------------------------------------

class TestCreateRun:

    def test_request_is_frozen_byte_for_byte(self, repo, request_file):
        paths, s = st.create_run(repo, "demo", request_file)
        copied = (paths.run_dir / "00_original_request.md").read_bytes()
        assert copied == request_file.read_bytes(), "개행·인코딩 변환 없이 그대로"
        assert s["request"]["bytes"] == len(copied)
        assert s["request"]["sha256"] == hashlib.sha256(copied).hexdigest()

    def test_run_id_shape_and_length(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        rid = s["run_id"]
        assert len(rid) == 18, "경로 240자 상한 때문에 짧게 유지한다"
        date, time_, tail = rid.split("-")
        assert len(date) == 8 and len(time_) == 4 and len(tail) == 4

    def test_run_dir_lives_under_workspace(self, repo, request_file):
        paths, _ = st.create_run(repo, "demo", request_file)
        assert paths.run_dir.parent == repo / "_workspace" / "runs"

    def test_vcs_is_untouched(self, repo, request_file):
        before_head = _git(repo, "rev-parse", "HEAD").stdout
        before_branch = _git(repo, "branch", "--show-current").stdout
        st.create_run(repo, "demo", request_file)
        assert _git(repo, "rev-parse", "HEAD").stdout == before_head
        assert _git(repo, "branch", "--show-current").stdout == before_branch

    def test_vcs_baseline_is_recorded(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        assert s["vcs"]["baseline"]["head"]
        assert s["vcs"]["baseline"]["dirty"] is False

    def test_load_finds_runs_by_id_and_latest(self, repo, request_file):
        _, first = st.create_run(repo, "a", request_file, seed_bytes=b"1")
        _, second = st.create_run(repo, "b", request_file, seed_bytes=b"2")
        _, loaded = st.load(repo)
        assert loaded["run_id"] in (first["run_id"], second["run_id"])
        _, by_id = st.load(repo, first["run_id"])
        assert by_id["slug"] == "a"

    def test_save_load_roundtrip_keeps_hangul(self, repo, request_file):
        paths, s = st.create_run(repo, "demo", request_file)
        s["gaps"] = ["스테이지 없음"]
        st.save(paths, s)
        assert "스테이지" in paths.state.read_text(encoding="utf-8")
        _, again = st.load(repo, s["run_id"])
        assert again["gaps"] == ["스테이지 없음"]

    def test_future_phase_keys_are_not_pre_created(self, repo, request_file):
        """05~08 의 키를 null 로 파 두면 '안 돌렸다'와 '0 이었다'가 같은 칸에 든다."""
        _, s = st.create_run(repo, "demo", request_file)
        for key in ("review05", "precheck", "approval", "pr", "review07", "tests"):
            assert key not in s, key


class TestPhaseStatus:

    def test_absent_key_means_never_entered(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        assert st.phase_status(s, "03-implement") is None, \
            "pending 을 만들지 않는다 — 키 부재가 그것이다"

    def test_unknown_status_is_rejected(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        with pytest.raises(ValueError):
            st.set_phase_status(s, "01-plan", "submitted")

    def test_status_transitions_record_a_timestamp(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        st.set_phase_status(s, "01-plan", "running")
        st.set_phase_status(s, "01-plan", "passed", rounds=2)
        assert st.phase_status(s, "01-plan") == "passed"
        assert s["phases"]["01-plan"]["rounds"] == 2
        assert "at" in s["phases"]["01-plan"]


class TestEvents:

    def test_kind_vocabulary_is_closed(self, repo, request_file):
        """budget.model_calls 가 이벤트 수에서 유도되므로 어휘가 열리면 정의가 흔들린다."""
        paths, _ = st.create_run(repo, "demo", request_file)
        with pytest.raises(ValueError):
            st.append_event(paths, "made_up_kind", cmd="next", phase="01-plan")

    def test_seq_increments_and_lines_parse(self, repo, request_file):
        paths, _ = st.create_run(repo, "demo", request_file)
        st.append_event(paths, "phase_enter", cmd="next", phase="01-plan")
        st.append_event(paths, "phase_pass", cmd="record", phase="01-plan")
        lines = [json.loads(x) for x in
                 paths.events.read_text(encoding="utf-8").splitlines() if x.strip()]
        assert [e["seq"] for e in lines] == list(range(1, len(lines) + 1))
        assert lines[-1]["kind"] == "phase_pass"


class TestFingerprint:
    """게이트 통과 후 소스가 바뀌면 영수증이 stale 이어야 한다."""

    def test_same_content_same_value(self, repo):
        config = harness._read_json(repo / "harness/config.json")
        assert st.fingerprint(repo, config)["value"] == \
            st.fingerprint(repo, config)["value"]

    def test_edit_changes_the_value(self, repo):
        config = harness._read_json(repo / "harness/config.json")
        before = st.fingerprint(repo, config)
        (repo / "src" / "lib" / "match.ts").write_text("// 바뀜\n", encoding="utf-8")
        assert st.fingerprint(repo, config)["value"] != before["value"]

    def test_revert_restores_the_value(self, repo):
        """mtime 이 아니라 내용을 해시한다 — 되돌리면 같은 지문이어야 한다."""
        config = harness._read_json(repo / "harness/config.json")
        target = repo / "src" / "lib" / "match.ts"
        original = target.read_text(encoding="utf-8")
        before = st.fingerprint(repo, config)
        target.write_text("// 바뀜\n", encoding="utf-8")
        target.write_text(original, encoding="utf-8")
        assert st.fingerprint(repo, config)["value"] == before["value"]

    def test_change_outside_role_scope_is_ignored(self, repo):
        """소유 범위 밖(문서 등)의 변경은 게이트 영수증을 무효로 만들지 않는다."""
        config = harness._read_json(repo / "harness/config.json")
        before = st.fingerprint(repo, config)
        (repo / "CLAUDE.md").write_text("# 가드레일\n추가 줄\n", encoding="utf-8")
        assert st.fingerprint(repo, config)["value"] == before["value"]

    def test_different_algo_never_matches(self):
        a = {"algo": "tree-sha256", "value": "x"}
        b = {"algo": "walk-sha256", "value": "x"}
        assert st.fingerprint_matches(a, dict(a)) is True
        assert st.fingerprint_matches(a, b) is False, \
            "다른 방법으로 잰 값이 우연히 같아 '안 바뀌었다'가 되면 안 된다"

    # ── M25. 지문은 커밋이 아니라 내용에 매달린다.

    def test_커밋해도_지문이_같다(self, repo):
        """**M25 의 본체다.** 06 은 PR diff 를 위해 커밋을 요구한다. HEAD 를
        해시에 넣으면 그 커밋이 04 영수증을 반드시 낡게 만든다 — 바이트가
        하나도 안 바뀌었는데도."""
        config = harness._read_json(repo / "harness/config.json")
        (repo / "src" / "lib" / "match.ts").write_text("// 고침\n", encoding="utf-8")
        before = st.fingerprint(repo, config)
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", "06 이 요구하는 커밋")
        after = st.fingerprint(repo, config)
        assert after["value"] == before["value"]
        assert st.fingerprint_matches(before, after) is True

    def test_커밋한_뒤_고치면_지문이_달라진다(self, repo):
        """커밋 중립이 permissive 가 되면 안 된다 — 내용이 바뀌면 여전히 stale."""
        config = harness._read_json(repo / "harness/config.json")
        _git(repo, "commit", "-q", "--allow-empty", "-m", "빈 커밋")
        before = st.fingerprint(repo, config)
        (repo / "src" / "lib" / "match.ts").write_text("// 한 글자\n", encoding="utf-8")
        assert st.fingerprint_matches(before, st.fingerprint(repo, config)) is False

    def test_추적되지_않은_소유_파일이_지문에_들어간다(self, repo):
        """03 이 새로 쓴 파일은 아직 git add 전이다. 놓치면 게이트가 보지
        않은 코드가 영수증을 통과한다."""
        config = harness._read_json(repo / "harness/config.json")
        before = st.fingerprint(repo, config)
        (repo / "src" / "lib" / "new.ts").write_text("export const x = 1\n",
                                                     encoding="utf-8")
        assert st.fingerprint(repo, config)["value"] != before["value"]

    def test_무시된_파일은_지문에_들어가지_않는다(self, repo):
        """`_workspace/` 는 커맨드마다 커진다 — 들어가면 지문이 매번 바뀐다."""
        config = harness._read_json(repo / "harness/config.json")
        before = st.fingerprint(repo, config)
        d = repo / "_workspace" / "runs" / "x"
        d.mkdir(parents=True, exist_ok=True)
        (d / "events.jsonl").write_text('{"seq":1}\n', encoding="utf-8")
        assert st.fingerprint(repo, config)["value"] == before["value"]

    def test_삭제도_지문을_바꾸고_커밋_전후가_같다(self, repo):
        """삭제는 변경이다. 그리고 그 삭제를 커밋해도 값은 그대로여야 한다 —
        아니면 M25 가 삭제라는 형태로 되살아난다."""
        config = harness._read_json(repo / "harness/config.json")
        before = st.fingerprint(repo, config)
        (repo / "src" / "lib" / "match.ts").unlink()
        uncommitted = st.fingerprint(repo, config)
        assert uncommitted["value"] != before["value"]
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", "삭제를 커밋")
        assert st.fingerprint(repo, config)["value"] == uncommitted["value"]

    def test_소유_범위_밖의_커밋은_지문을_바꾸지_않는다(self, repo):
        """`test_change_outside_role_scope_is_ignored` 의 커밋 판이다.
        워크트리 편집은 무시하면서 그 편집을 커밋하면 무효가 되던 것이 M25."""
        config = harness._read_json(repo / "harness/config.json")
        before = st.fingerprint(repo, config)
        (repo / "CLAUDE.md").write_text("# 가드레일\n추가 줄\n", encoding="utf-8")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", "문서만 고침")
        assert st.fingerprint(repo, config)["value"] == before["value"]

    def test_옛_지문은_보수적으로_stale_이다(self, repo):
        """`git-sha256` 로 잰 P2 시절 값은 algo 가 달라 영원히 안 맞는다.
        그래서 P2 는 `advance` 가 아니라 `report` 로만 닫힌다."""
        config = harness._read_json(repo / "harness/config.json")
        fresh = st.fingerprint(repo, config)
        old = dict(fresh, algo="git-sha256")
        assert st.fingerprint_matches(old, fresh) is False

    def test_file_count_는_해시한_파일_수다(self, repo):
        """뜻이 바뀌었다 — 예전에는 HEAD 줄을 포함한 입력 줄 수였다."""
        config = harness._read_json(repo / "harness/config.json")
        fp = st.fingerprint(repo, config)
        assert fp["file_count"] == 2, "match.ts 와 match.test.ts 둘"


class TestCounters:

    def test_inc_reports_exceeded_at_the_limit(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        assert st.counter_inc(s, "repair", 2) == (1, 2, False)
        assert st.counter_inc(s, "repair", 2) == (2, 2, True)


class TestModelCallBudget:
    """M22 — 선언만 되고 아무도 세지 않던 예산.

    P1 은 서브에이전트 10회를 태우고도 봉투에 "0/24" 를 찍었다. 재지 않는 예산은
    소진되지 않으므로 exit 5 가 영원히 발화하지 않는다.
    """

    def test_a_new_run_starts_at_zero_with_the_configured_max(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        mc = s["budget"]["model_calls"]
        assert mc["total"] == 0
        assert mc["max"] == 24
        assert mc["approx"] is True

    def test_bump_raises_total_and_the_phase_bucket_together(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        st.bump_model_calls(s, "01-plan")
        st.bump_model_calls(s, "01-plan")
        st.bump_model_calls(s, "03-implement", 2)
        mc = s["budget"]["model_calls"]
        assert mc["total"] == 4
        assert mc["by_phase"] == {"01-plan": 2, "03-implement": 2}

    def test_bump_reports_exhaustion_at_the_max(self, repo, request_file):
        _, s = st.create_run(repo, "demo", request_file)
        s["budget"]["model_calls"]["max"] = 2
        assert st.bump_model_calls(s, "01-plan") == (1, 2, False)
        assert st.bump_model_calls(s, "01-plan") == (2, 2, True)

    def test_no_max_never_exhausts(self, repo, request_file):
        """max 가 null 이면 예산이 없는 것이지 0 인 것이 아니다."""
        _, s = st.create_run(repo, "demo", request_file)
        s["budget"]["model_calls"]["max"] = None
        assert st.bump_model_calls(s, "01-plan") == (1, None, False)

    def test_reviewer_submission_increments_the_count(self, run01):
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        _submit_review(repo, paths, _review("plan"))
        _, after = st.load(repo, paths.run_id)
        assert after["budget"]["model_calls"]["total"] == 1
        assert after["budget"]["model_calls"]["by_phase"] == {"01-plan": 1}

    def test_main_authored_output_does_not_count(self, run01):
        """플랜 본문은 메인이 쓴다. 서브에이전트 호출이 아니다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        _, after = st.load(repo, paths.run_id)
        assert after["budget"]["model_calls"]["total"] == 0

    def test_a_rejected_resubmission_still_counts(self, run01):
        """exit 8 로 튕긴 제출도 모델을 한 번 태운 뒤다 — 과다 계수가 안전 방향이다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        bad = _review("plan", findings=[
            {"id": "F-1", "severity": "major", "title": "x", "quote": "원문에 없다"}])
        j = paths.run_dir / "01_review_r1.json"
        j.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
        (paths.run_dir / "01_review_r1.raw.md").write_text(
            _raw([{"severity": "major", "quote": "다른 말"}]),
            encoding="utf-8")
        assert cli.run_record(repo, phase="01", file=str(j),
                              reviewer="plan", round_=1)["exit"] == 8
        _submit_review(repo, paths, _review("plan"))
        _, after = st.load(repo, paths.run_id)
        assert after["budget"]["model_calls"]["total"] == 2

    def test_exhausted_budget_stops_the_run_with_exit_5(self, run01):
        """예산이 소진되면 다음 모델 호출을 요구하지 않고 멈춘다."""
        repo, paths, s = run01
        s["budget"]["model_calls"]["max"] = 2
        st.save(paths, s)
        _submit_plan(repo, paths, _plan())
        assert _submit_review(repo, paths, _review("plan"))["exit"] == 0
        env = _submit_review(repo, paths, _review("xv"))
        assert env["exit"] == 5, env["render"]
        assert "예산" in env["render"]

    def test_an_exhausted_run_does_not_lose_the_submission(self, run01):
        """exit 5 는 제출을 버리는 것이 아니라 다음 호출을 막는 것이다."""
        repo, paths, s = run01
        s["budget"]["model_calls"]["max"] = 2
        st.save(paths, s)
        _submit_plan(repo, paths, _plan())
        _submit_review(repo, paths, _review("plan"))
        _submit_review(repo, paths, _review("xv"))
        _, after = st.load(repo, paths.run_id)
        assert st.phase_status(after, "01-plan") == "passed"

    def test_the_packet_header_names_what_it_counts(self, run01):
        """'근사' 라고만 적으면 무엇이 근사인지 알 수 없다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        _submit_review(repo, paths, _review("plan"))
        env = cli.run_next(repo, run_id=paths.run_id)
        assert "모델 호출 1/24" in env["render"]
        assert "제출 기준" in env["render"]


# ---------------------------------------------------------------------------
# B. lint-phases — 페이즈 파일이 깨진 채로 /feature 가 시작하지 않는다
# ---------------------------------------------------------------------------

PHASE_IDS = ["01-plan", "02-cross-verify", "03-implement", "04-gate",
             "05-code-review", "06-pr", "07-pr-review", "08-report"]


@pytest.fixture
def phases(repo):
    """실물 페이즈 파일을 복사한다 — 실물이 깨지면 이 테스트가 먼저 깨진다."""
    d = repo / "harness" / "phases"
    d.mkdir(parents=True, exist_ok=True)
    for pid in PHASE_IDS:
        (d / ("%s.md" % pid)).write_text(
            (ROOT / "harness" / "phases" / ("%s.md" % pid)).read_text(encoding="utf-8"),
            encoding="utf-8")
    for role in ("impl-writer", "test-writer"):
        agent = repo / ".claude" / "agents" / ("%s.md" % role)
        agent.parent.mkdir(parents=True, exist_ok=True)
        agent.write_text("# %s\n" % role, encoding="utf-8")
    return d


def _front(path):
    front, _body, _sections = cli.parse_phase_file(path)
    return front


def _rewrite(path, mutate):
    """프론트매터만 고쳐 다시 쓴다. 본문은 그대로 둔다."""
    front, body, _ = cli.parse_phase_file(path)
    mutate(front)
    path.write_text("---\n%s\n---\n%s" % (
        json.dumps(front, ensure_ascii=False, indent=2), body), encoding="utf-8")


def _lint(repo):
    return cli.lint_phases(repo)


def _fails(findings, rule=None):
    out = [f for f in findings if f["status"] == "FAIL"]
    return [f for f in out if f["rule"] == rule] if rule else out


class TestLintPhases:
    """lint-phases 가 CI 없이 검증하는 유일한 장치다 — 못 잡으면 런 중간에 안다."""

    def test_shipped_phase_files_pass(self, repo, phases):
        assert _fails(_lint(repo)) == []

    def test_missing_frontmatter_fence(self, repo, phases):
        (phases / "01-plan.md").write_text("# 본문만 있다\n", encoding="utf-8")
        assert _fails(_lint(repo), "frontmatter")

    def test_broken_json(self, repo, phases):
        (phases / "01-plan.md").write_text("---\n{not json}\n---\n# x\n", encoding="utf-8")
        assert _fails(_lint(repo), "frontmatter")

    def test_unknown_placeholder_namespace(self, repo, phases):
        _rewrite(phases / "01-plan.md",
                 lambda f: f["produces"][0].__setitem__("path", "${secrets.token}/x.md"))
        assert _fails(_lint(repo), "placeholder")

    def test_placeholder_resolves_to_nothing(self, repo, phases):
        _rewrite(phases / "01-plan.md",
                 lambda f: f["produces"][0].__setitem__(
                     "path", "${config.project.no_such_key}/x.md"))
        assert _fails(_lint(repo), "placeholder")

    def test_every_transition_lands_on_a_real_phase(self, repo, phases):
        """**여덟이 다 서면서 이 단언의 성질이 바뀌었다.**

        05 까지는 "FUTURE 한 줄이 다음 진입점을 가리킨다"였고, 그 대상이
        04 → 05 → 06 으로 옮겨 다녔다. 08 이 마지막이라 **옮길 곳이 없다** —
        이제 잠글 것은 "모든 전이가 실재하는 페이즈로 떨어지고, 마지막은
        전이하지 않는다"다. FUTURE 가 0건인 것이 이제 정상이다.

        FUTURE 판정 자체는 지우지 않았다 — 09 를 가리키는 페이즈가 생기면
        그때 다시 한 줄이 뜬다. `test_future_transition_still_warns` 가 그
        기제를 따로 잠근다.
        """
        findings = _lint(repo)
        future = [f for f in findings
                  if f["rule"] == "on_success" and f["status"] == "WARN"]
        assert future == [], "여덟이 다 섰으므로 FUTURE 는 0건이다"
        assert _fails(findings, "on_success") == []

    def test_future_transition_still_warns(self, repo, phases):
        """기제는 살아 있다 — 없는 다음을 가리키면 FAIL 이 아니라 WARN 이다."""
        _rewrite(phases / "08-report.md",
                 lambda f: f.__setitem__("on_success", "09-nope"))
        findings = _lint(repo)
        future = [f for f in findings
                  if f["rule"] == "on_success" and f["status"] == "WARN"]
        assert len(future) == 1
        assert "09-nope" in future[0]["message"]
        assert _fails(findings, "on_success") == []

    def test_backward_orphan_on_success_fails(self, repo, phases):
        _rewrite(phases / "01-plan.md", lambda f: f.__setitem__("on_success", "00-nope"))
        assert _fails(_lint(repo), "on_success")

    # ── M24. `done` 은 깨진 포인터가 아니라 종단이다.

    def test_done_은_전이_대상이_없어도_FAIL_이_아니다(self, repo, phases):
        findings = _lint(repo)
        assert _fails(findings, "on_success") == []
        assert [f for f in findings
                if f["rule"] == "on_success" and f["status"] == "WARN"] == []

    def test_on_success_가_없으면_FAIL(self, repo, phases):
        """**M24 의 lint 층 회귀.** 마지막 페이즈가 아무것도 안 가리키면
        런을 닫는 자리가 코드 어디에도 생기지 않는다."""
        _rewrite(phases / "08-report.md", lambda f: f.pop("on_success", None))
        assert _fails(_lint(repo), "on_success")

    def test_종단이_둘이면_FAIL(self, repo, phases):
        """런이 닫히는 자리는 하나다."""
        _rewrite(phases / "07-pr-review.md",
                 lambda f: f.__setitem__("on_success", st.DONE))
        assert _fails(_lint(repo), "terminal")

    def test_done_은_순환_검사를_멈추지_않는다(self, repo, phases):
        assert _fails(_lint(repo), "cycle") == []

    def test_cycle_is_rejected(self, repo, phases):
        _rewrite(phases / "02-cross-verify.md",
                 lambda f: f.__setitem__("on_success", "01-plan"))
        assert _fails(_lint(repo), "cycle")

    def test_unknown_stage_name(self, repo, phases):
        _rewrite(phases / "04-gate.md",
                 lambda f: f["gate"]["steps"].append({"id": "deploy"}))
        assert _fails(_lint(repo), "stage")

    def test_raw_shell_runner_is_rejected(self, repo, phases):
        """페이즈 파일이 임의 명령 실행 벡터가 되지 않게 한다."""
        _rewrite(phases / "04-gate.md",
                 lambda f: f["gate"].__setitem__("runner", "shell"))
        assert _fails(_lint(repo), "runner")

    def test_runner_bin_outside_whitelist(self, repo, phases):
        a = repo / "harness" / "adapters" / "nextjs-ts.json"
        data = json.loads(a.read_text(encoding="utf-8"))
        data["runner"]["bin"] = "curl"
        a.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        assert _fails(_lint(repo), "runner_bin")

    def test_missing_required_h2_section(self, repo, phases):
        p = phases / "02-cross-verify.md"
        p.write_text(p.read_text(encoding="utf-8").replace("## 금지", "## 하지 말 것"),
                     encoding="utf-8")
        assert _fails(_lint(repo), "sections")

    def test_role_template_required_when_agents_allowed(self, repo, phases):
        p = phases / "03-implement.md"
        p.write_text(p.read_text(encoding="utf-8")
                     .replace("## 역할 프롬프트 템플릿", "## 참고"), encoding="utf-8")
        assert _fails(_lint(repo), "sections")

    def test_path_over_the_limit(self, repo, phases):
        _rewrite(phases / "01-plan.md",
                 lambda f: f["produces"][0].__setitem__(
                     "path", "${run.dir}/" + "x" * 240 + ".md"))
        assert _fails(_lint(repo), "path_length")

    def test_missing_role_agent_definition(self, repo, phases):
        """기동 전에 무료로 잡는다 — 03 이 그 파일 없이 돌 수 없다."""
        (repo / ".claude" / "agents" / "impl-writer.md").unlink()
        assert _fails(_lint(repo), "agent_file")

    def test_unknown_requires_kind(self, repo, phases):
        _rewrite(phases / "02-cross-verify.md",
                 lambda f: f["requires"].append({"kind": "vibes"}))
        assert _fails(_lint(repo), "requires_kind")

    def test_unknown_produces_kind(self, repo, phases):
        _rewrite(phases / "02-cross-verify.md",
                 lambda f: f["produces"][0].__setitem__("kind", "yaml"))
        assert _fails(_lint(repo), "produces_kind")

    def test_id_must_match_filename(self, repo, phases):
        _rewrite(phases / "02-cross-verify.md", lambda f: f.__setitem__("id", "02-other"))
        assert _fails(_lint(repo), "id")

    def test_duplicate_index(self, repo, phases):
        _rewrite(phases / "02-cross-verify.md", lambda f: f.__setitem__("index", 1))
        assert _fails(_lint(repo), "index")

    def test_unknown_loop_counter(self, repo, phases):
        _rewrite(phases / "04-gate.md",
                 lambda f: f["loop"].__setitem__("counter", "made_up"))
        assert _fails(_lint(repo), "counter")

    def test_background_true_is_refused_not_silently_downgraded(self, repo, phases):
        """켜지지 않는 기계를 조용히 동기로 낙하시키지 않는다."""
        cal = repo / "harness" / "calibration.json"
        data = json.loads(cal.read_text(encoding="utf-8"))
        data["derived"]["background_full_regression"] = True
        cal.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        assert _fails(_lint(repo), "background")

    def test_duplicate_produces_key(self, repo, phases):
        _rewrite(phases / "04-gate.md",
                 lambda f: f["produces"][1].__setitem__("key", "gate_report"))
        assert _fails(_lint(repo), "produces_key")

    def test_taxonomy_absent_is_skip_not_pass(self, repo, phases):
        """01~04 에 소비자가 없다. 없는 검사를 통과로 세지 않는다."""
        findings = _lint(repo)
        tax = [f for f in findings if f["rule"] == "taxonomy"]
        assert tax and tax[0]["status"] == "SKIP"

    def test_cli_lint_phases_exits_two_on_failure(self, repo, phases):
        (phases / "01-plan.md").write_text("# 깨짐\n", encoding="utf-8")
        out = _run_cli(repo, "lint-phases")
        assert out.returncode == 2
        assert json.loads(out.stdout)["exit"] == 2


# ---------------------------------------------------------------------------
# D. 페이즈 파서 · requires
# ---------------------------------------------------------------------------

UNITS_DOC = """## 유닛

- `lib/match.ts · matchTitle(a: string, b: string): number`
  - 정상: 0~1 유사도 반환 / 부수효과: 없음
  - 예외: 빈 문자열 → `0`
"""


class TestContractUnits:
    """M23 — 계약 파서가 중첩 불릿을 유닛으로 세고, 템플릿 자신이 그 형태다.

    P1 에서 이것이 유닛 19개·unmatched 15건을 만들었고 화면 층 테스트가 스코프
    선택에서 빠졌다. 프로파일 판정(`small_max_units`)까지 함께 오염된다.
    """

    def _parse(self, repo, text):
        cfg = json.loads((repo / "harness" / "config.json").read_text(encoding="utf-8"))
        return contract_mod.parse(text, cfg)

    def test_top_level_bullet_is_a_unit(self, repo):
        p = self._parse(repo, UNITS_DOC)
        assert [u["symbol"] for u in p["units"]] == ["matchTitle"]
        assert p["units"][0]["container"] == "lib/match.ts"

    def test_nested_bullet_is_not_a_unit(self, repo):
        """들여쓴 줄은 그 유닛의 설명이지 또 하나의 유닛이 아니다."""
        p = self._parse(repo, UNITS_DOC)
        assert len(p["units"]) == 1, p["units"]

    def test_a_description_line_is_neither_a_unit_nor_a_drop(self, repo):
        """들여쓴 서술은 버려진 것이 아니다 — 애초에 유닛 자리가 아니다."""
        p = self._parse(repo, UNITS_DOC)
        assert p["dropped"] == [], p["dropped"]

    def test_a_symbolless_top_level_bullet_is_dropped_not_silently_lost(self, repo):
        """컨테이너도 심볼도 없으면 유닛이 아니다 — 그러나 조용히 버리지 않는다."""
        p = self._parse(repo, "## 유닛\n\n- `0`\n")
        assert p["units"] == []
        assert p["dropped"] and p["dropped"][0]["reason"]

    def test_a_unit_needs_both_a_container_and_a_symbol(self, repo):
        """심볼명만 보면 흔한 이름이 다른 파일에서 거짓 통과한다."""
        p = self._parse(repo, "## 유닛\n\n- `matchTitle`\n")
        assert p["units"] == []
        assert len(p["dropped"]) == 1

    def test_shipped_template_parses_without_drops(self, repo):
        """**템플릿이 시범 보이는 형태가 자기 파서를 속이면 안 된다.**"""
        text = (ROOT / "harness" / "templates" / "contract.md").read_text(
            encoding="utf-8")
        p = self._parse(repo, text)
        assert p["dropped"] == [], p["dropped"]
        assert [u["symbol"] for u in p["units"]] == ["matchTitle"]

    def test_doctor_rejects_a_template_that_fools_its_own_parser(self, repo, phases):
        """지금은 절 제목 일치만 본다 — 본문이 파서를 통과하는지는 아무도 안 봤다."""
        tpl = repo / "harness" / "templates" / "contract.md"
        text = tpl.read_text(encoding="utf-8")
        tpl.write_text(
            text.replace("## 진입점", "- 예외: 빈 문자열 → `0`\n\n## 진입점", 1),
            encoding="utf-8")
        bad = [c for c in cli._pipeline_checks(repo) if c["status"] == "FAIL"]
        assert bad, "템플릿이 자기 파서를 속이는데 doctor 가 통과시켰다"
        assert any("템플릿" in c["name"] for c in bad), [c["name"] for c in bad]


class TestPhaseParser:

    def test_splits_frontmatter_body_and_sections(self, repo, phases):
        front, body, sections = cli.parse_phase_file(phases / "01-plan.md")
        assert front["id"] == "01-plan"
        assert body.lstrip().startswith("## 목적")
        assert "## 절차" in sections and "## 금지" in sections

    def test_resolves_the_three_namespaces(self, repo, phases, request_file):
        paths, s = st.create_run(repo, "demo", request_file)
        ctx = cli.build_context(repo, paths, s)
        assert cli.resolve("${config.project.name}", ctx) == "shelfie"
        assert cli.resolve("${run.dir}/x.md", ctx).endswith("x.md")
        assert cli.resolve("${calibration.derived.tests_ran_floor}", ctx) == 1179

    def test_unresolved_placeholder_raises(self, repo, phases, request_file):
        paths, s = st.create_run(repo, "demo", request_file)
        ctx = cli.build_context(repo, paths, s)
        with pytest.raises(cli.PlaceholderError):
            cli.resolve("${secrets.token}", ctx)


class TestRequires:

    @pytest.fixture
    def ctx(self, repo, phases, request_file):
        paths, s = st.create_run(repo, "demo", request_file)
        return repo, paths, s, cli.build_context(repo, paths, s)

    def test_file_kind_missing(self, ctx):
        repo, paths, s, c = ctx
        checks = cli.check_requires(
            repo, [{"kind": "file", "path": "${run.dir}/nope.md"}], c, s)
        assert not checks[0]["ok"]

    def test_file_kind_min_bytes_and_must_contain(self, ctx):
        repo, paths, s, c = ctx
        target = paths.run_dir / "01_plan.md"
        target.write_text("짧다", encoding="utf-8")
        req = [{"kind": "file", "path": "${run.dir}/01_plan.md", "min_bytes": 200}]
        assert not cli.check_requires(repo, req, c, s)[0]["ok"]
        target.write_text("가" * 300, encoding="utf-8")
        assert cli.check_requires(repo, req, c, s)[0]["ok"]
        req2 = [{"kind": "file", "path": "${run.dir}/01_plan.md",
                 "must_contain": "<!-- INTENT"}]
        assert not cli.check_requires(repo, req2, c, s)[0]["ok"]

    def test_file_kind_sha256_pointer(self, ctx):
        """의도 동결의 앵커를 진입 조건으로 건다."""
        repo, paths, s, c = ctx
        req = [{"kind": "file", "path": "${run.dir}/00_original_request.md",
                "min_bytes": 1, "sha256_pointer": "request.sha256"}]
        assert cli.check_requires(repo, req, c, s)[0]["ok"]
        paths.request.write_bytes(b"tampered")
        assert not cli.check_requires(repo, req, c, s)[0]["ok"]

    def test_state_kind_equals_and_in(self, ctx):
        repo, paths, s, c = ctx
        req = [{"kind": "state", "pointer": "phases.01-plan.status", "equals": "passed"}]
        assert not cli.check_requires(repo, req, c, s)[0]["ok"], "키 부재 = 미진입"
        st.set_phase_status(s, "01-plan", "passed")
        assert cli.check_requires(repo, req, c, s)[0]["ok"]
        req_in = [{"kind": "state", "pointer": "phases.01-plan.status",
                   "in": ["passed", "skipped"]}]
        assert cli.check_requires(repo, req_in, c, s)[0]["ok"]
        st.set_phase_status(s, "01-plan", "skipped")
        assert cli.check_requires(repo, req_in, c, s)[0]["ok"]
        assert not cli.check_requires(repo, req, c, s)[0]["ok"]

    def test_unless_skips_the_requirement(self, ctx):
        repo, paths, s, c = ctx
        s["contract"] = {"mode": "no_contract"}
        req = [{"kind": "file", "path": "${run.dir}/nope.md",
                "unless": "state.contract.mode == \"no_contract\""}]
        check = cli.check_requires(repo, req, c, s)[0]
        assert check["ok"] and check["skipped"]

    def test_adapter_stage_warn_versus_fail(self, ctx):
        repo, paths, s, c = ctx
        req_warn = [{"kind": "adapter_stage", "steps": ["e2e"], "mode": "warn"}]
        req_fail = [{"kind": "adapter_stage", "steps": ["e2e"], "mode": "fail"}]
        assert cli.check_requires(repo, req_warn, c, s)[0]["ok"], "warn 은 막지 않는다"
        assert not cli.check_requires(repo, req_fail, c, s)[0]["ok"], \
            "cmd:null 스테이지는 '없는 것'이다"

    def test_adapter_stage_present_passes(self, ctx):
        repo, paths, s, c = ctx
        req = [{"kind": "adapter_stage", "steps": ["compile", "full"], "mode": "fail"}]
        assert cli.check_requires(repo, req, c, s)[0]["ok"]


# ---------------------------------------------------------------------------
# E. 01 판정 — quote · 커버리지 · 드리프트 · 단조성
# ---------------------------------------------------------------------------

REQUEST_TEXT = (
    "책 제목 유사도를 재는 함수를 만들어 줘. 빈 문자열은 0 을 돌려주고, "
    "외부 서비스를 새로 부르지는 마.\n")


def _plan(intent=None, coverage=None, body=None):
    """정상 플랜 하나. 인자로 한 군데씩 망가뜨린다."""
    intent = intent if intent is not None else {
        "invariants": [
            {"id": "INV-1", "kind": "must", "text": "빈 문자열은 0",
             "source_quote": "빈 문자열은 0 을 돌려주고"},
            {"id": "INV-2", "kind": "must_not", "text": "외부 호출 금지",
             "source_quote": "외부 서비스를 새로 부르지는 마"},
        ],
        "out_of_scope": [],
        "acceptance": [{"id": "AC-1", "text": "0~1 유사도",
                        "source_quote": "책 제목 유사도를 재는 함수"}],
    }
    coverage = coverage if coverage is not None else {
        "covers": [{"id": "INV-1", "status": "covered", "plan_section": "## 경계값"},
                   {"id": "INV-2", "status": "covered", "plan_section": "## 외부 경계"}],
        "added_scope": [],
    }
    body = body if body is not None else (
        "# 플랜\n\n## 경계값\n빈 문자열을 먼저 거른다.\n\n"
        "## 외부 경계\n순수 함수다. 아무것도 부르지 않는다.\n" + "여백 " * 40)
    return ("<!-- INTENT\n%s\n-->\n\n%s\n\n<!-- COVERAGE\n%s\n-->\n"
            % (json.dumps(intent, ensure_ascii=False),
               body,
               json.dumps(coverage, ensure_ascii=False)))


def _review(reviewer="plan", round_=1, findings=None, mode="primary",
            resolved=None):
    return {"reviewer": reviewer, "round": round_, "mode": mode,
            "findings": findings if findings is not None else [],
            "resolved_from_previous": resolved or []}


def _raw(findings):
    """리뷰어 원문. quote 와 심각도 헤딩 개수가 json 과 맞아야 한다."""
    lines = ["# 리뷰"]
    for f in findings:
        lines.append("## %s" % f["severity"])
        lines.append(f.get("quote", ""))
    return "\n".join(lines) + "\n"


@pytest.fixture
def run01(repo, phases):
    """01 지시문까지 진행된 런."""
    req = repo / "_workspace" / "requests" / "sim.md"
    req.parent.mkdir(parents=True, exist_ok=True)
    req.write_text(REQUEST_TEXT, encoding="utf-8")
    paths, s = st.create_run(repo, "sim", req)
    st.set_phase_status(s, "01-plan", "running")
    st.save(paths, s)
    return repo, paths, s


def _submit_plan(repo, paths, text):
    p = paths.run_dir / "01_plan.md"
    p.write_text(text, encoding="utf-8")
    return cli.run_record(repo, phase="01", file=str(p), reviewer=None, round_=None)


def _submit_review(repo, paths, payload, round_=1):
    code = payload["reviewer"]
    j = paths.run_dir / ("01_review_r%d.json" % round_ if code == "plan"
                         else "01_xverify_r%d.json" % round_)
    r = paths.run_dir / (j.name.replace(".json", ".raw.md"))
    j.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    r.write_text(_raw(payload["findings"]), encoding="utf-8")
    return cli.run_record(repo, phase="01", file=str(j), reviewer=code, round_=round_)


class TestPlanSubmission:

    def test_clean_plan_is_accepted(self, run01):
        repo, paths, s = run01
        env = _submit_plan(repo, paths, _plan())
        assert env["exit"] == 0, env["render"]
        assert env["data"]["drift_score"] == 0

    def test_forged_quote_is_rejected(self, run01):
        """없는 요구를 지어내는 것을 막는 유일한 기계적 손잡이다."""
        repo, paths, s = run01
        intent = json.loads(_plan().split("<!-- INTENT\n")[1].split("\n-->")[0])
        intent["invariants"][0]["source_quote"] = "요청에 없는 문장이다"
        env = _submit_plan(repo, paths, _plan(intent=intent))
        assert env["exit"] == 8
        assert "INV-1" in json.dumps(env["data"], ensure_ascii=False)

    def test_whitespace_only_differences_are_tolerated(self, run01):
        repo, paths, s = run01
        intent = json.loads(_plan().split("<!-- INTENT\n")[1].split("\n-->")[0])
        intent["invariants"][0]["source_quote"] = "빈 문자열은   0 을\n돌려주고"
        assert _submit_plan(repo, paths, _plan(intent=intent))["exit"] == 0

    def test_coverage_must_hit_each_invariant_exactly_once(self, run01):
        repo, paths, s = run01
        cov = {"covers": [{"id": "INV-1", "status": "covered",
                           "plan_section": "## 경계값"}], "added_scope": []}
        assert _submit_plan(repo, paths, _plan(coverage=cov))["exit"] == 8

    def test_duplicate_coverage_is_rejected(self, run01):
        repo, paths, s = run01
        cov = {"covers": [{"id": "INV-1", "status": "covered", "plan_section": "## 경계값"},
                          {"id": "INV-1", "status": "covered", "plan_section": "## 경계값"},
                          {"id": "INV-2", "status": "covered", "plan_section": "## 외부 경계"}],
               "added_scope": []}
        assert _submit_plan(repo, paths, _plan(coverage=cov))["exit"] == 8

    def test_plan_section_must_exist_in_the_body(self, run01):
        repo, paths, s = run01
        cov = {"covers": [{"id": "INV-1", "status": "covered", "plan_section": "## 없는 절"},
                          {"id": "INV-2", "status": "covered", "plan_section": "## 외부 경계"}],
               "added_scope": []}
        assert _submit_plan(repo, paths, _plan(coverage=cov))["exit"] == 8

    def test_uncovered_needs_a_reason(self, run01):
        repo, paths, s = run01
        cov = {"covers": [{"id": "INV-1", "status": "covered", "plan_section": "## 경계값"},
                          {"id": "INV-2", "status": "dropped"}], "added_scope": []}
        env = _submit_plan(repo, paths, _plan(coverage=cov))
        assert env["exit"] == 8

    def test_dropped_with_reason_is_drift_not_schema_error(self, run01):
        """드리프트는 exit 4 — 기계 판정 실패이고 예산이 남아 있다."""
        repo, paths, s = run01
        cov = {"covers": [{"id": "INV-1", "status": "covered", "plan_section": "## 경계값"},
                          {"id": "INV-2", "status": "dropped", "reason": "범위 밖으로 뺐다"}],
               "added_scope": []}
        env = _submit_plan(repo, paths, _plan(coverage=cov))
        assert env["exit"] == 4
        assert env["data"]["drift_score"] > 0

    def test_short_request_may_skip_the_intent_block(self, repo, phases):
        req = repo / "_workspace" / "requests" / "tiny.md"
        req.parent.mkdir(parents=True, exist_ok=True)
        req.write_text("오타 하나 고쳐 줘\n", encoding="utf-8")
        paths, s = st.create_run(repo, "tiny", req)
        st.set_phase_status(s, "01-plan", "running")
        st.save(paths, s)
        p = paths.run_dir / "01_plan.md"
        p.write_text("# 플랜\n\n## 수정\n" + "가" * 300, encoding="utf-8")
        env = cli.run_record(repo, phase="01", file=str(p), reviewer=None, round_=None)
        assert env["exit"] == 0, env["render"]


class TestReviewConvergence:

    def test_reviewer_main_is_rejected(self, run01):
        """작성자가 자기 글을 리뷰한 것은 독립 관측이 아니다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        env = _submit_review(repo, paths, _review(reviewer="main"))
        assert env["exit"] == 8

    def test_one_round_converges_when_both_are_primary_and_clean(self, run01):
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        assert _submit_review(repo, paths, _review("plan"))["exit"] == 0
        env = _submit_review(repo, paths, _review("xv"))
        assert env["exit"] == 0
        _, after = st.load(repo, paths.run_id)
        assert st.phase_status(after, "01-plan") == "passed"

    def test_fallback_forbids_one_round_convergence(self, run01):
        """폴백이 섞이면 독립 관측 두 개라는 전제가 약해진다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        _submit_review(repo, paths, _review("plan"))
        env = _submit_review(repo, paths, _review("xv", mode="fallback"))
        _, after = st.load(repo, paths.run_id)
        assert st.phase_status(after, "01-plan") != "passed"
        assert "2라운드" in env["render"] or env["data"].get("round") == 2

    def test_major_forces_a_second_round(self, run01):
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        finding = {"id": "F-1", "severity": "major", "category": "scope",
                   "title": "범위가 넓다", "quote": "범위가 넓다"}
        _submit_review(repo, paths, _review("plan", findings=[finding]))
        _submit_review(repo, paths, _review("xv"))
        _, after = st.load(repo, paths.run_id)
        assert st.phase_status(after, "01-plan") != "passed"

    def test_quote_not_in_raw_is_rejected(self, run01):
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        payload = _review("plan", findings=[
            {"id": "F-1", "severity": "major", "title": "x", "quote": "원문에 없다"}])
        j = paths.run_dir / "01_review_r1.json"
        j.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        (paths.run_dir / "01_review_r1.raw.md").write_text(
            "# 리뷰\n## major\n다른 말\n", encoding="utf-8")
        env = cli.run_record(repo, phase="01", file=str(j),
                             reviewer="plan", round_=1)
        assert env["exit"] == 8

    def test_finding_may_not_vanish_between_rounds(self, run01):
        """지적이 조용히 증발하는 것을 막는다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        finding = {"id": "F-1", "severity": "major", "title": "범위",
                   "quote": "범위가 넓다"}
        _submit_review(repo, paths, _review("plan", findings=[finding]))
        _submit_review(repo, paths, _review("xv"))
        env = _submit_review(repo, paths, _review("plan", round_=2), round_=2)
        assert env["exit"] == 8, "이전 open 지적이 findings 에도 resolved 에도 없다"

    # ── M21: 단조성 검사가 세 방향으로 샜다

    def test_a_reraised_finding_is_neither_new_nor_vanished(self, run01):
        """① 제목이 지적의 신원이라 다듬은 제목이 오탐을 두 번 낸다.

        `finding_key = sha1(category|target_role|title)` 이므로 리뷰어가 같은
        지적을 다른 제목으로 다시 올리면 '신규 지적' 이자 동시에 '증발한 지적'
        이 된다. 재제기를 1급 어휘로 두어 둘 다 아니게 한다.
        """
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        first = {"id": "F-1", "severity": "major", "title": "범위가 넓다",
                 "quote": "범위가 넓다"}
        _submit_review(repo, paths, _review("plan", findings=[first]))
        _submit_review(repo, paths, _review("xv"))

        reraised = {"id": "F-1", "severity": "major",
                    "title": "범위가 여전히 넓다", "quote": "범위가 넓다",
                    "reraised_from_previous": "F-1"}
        env = _submit_review(
            repo, paths, _review("plan", round_=2, findings=[reraised]), round_=2)
        assert env["exit"] == 0, env["render"]
        _, after = st.load(repo, paths.run_id)
        assert st.phase_status(after, "01-plan") != "passed", "재제기는 미해결이다"

    def test_a_reraise_must_point_at_something_open(self, run01):
        """없는 지적을 가리키는 재제기는 단조성을 우회하는 구멍이 된다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        f1 = {"id": "F-1", "severity": "major", "title": "범위", "quote": "범위가 넓다"}
        _submit_review(repo, paths, _review("plan", findings=[f1]))
        _submit_review(repo, paths, _review("xv"))
        ghost = {"id": "F-9", "severity": "major", "title": "x", "quote": "범위가 넓다",
                 "reraised_from_previous": "F-404"}
        env = _submit_review(
            repo, paths, _review("plan", round_=2, findings=[ghost]), round_=2)
        assert env["exit"] == 8, env["render"]
        assert "reraised_from_previous" in " ".join(env["data"]["errors"])

    def test_previous_open_drops_what_an_earlier_round_closed(self, run01):
        """② 해소가 누적되지 않아 3라운드가 1라운드에 닫힌 지적까지 또 적어야 했다.

        그 목록이 리뷰어 프롬프트에 실리므로 접두부가 라운드마다 자란다.
        """
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        f1 = {"id": "F-1", "severity": "major", "title": "범위", "quote": "범위가 넓다"}
        _submit_review(repo, paths, _review("plan", findings=[f1]))
        _submit_review(repo, paths, _review("xv"))

        _submit_review(repo, paths,
                       _review("plan", round_=2,
                               resolved=[{"id": "F-1", "resolved_by": "좁혔다"}]),
                       round_=2)
        f2 = {"id": "F-2", "severity": "major", "title": "다른 것",
              "quote": "범위가 넓다"}
        _submit_review(repo, paths, _review("xv", round_=2, findings=[f2]), round_=2)

        # 3라운드: F-1 은 1라운드에서 닫혔으므로 다시 적지 않아도 통과해야 한다.
        env = _submit_review(
            repo, paths,
            _review("plan", round_=3,
                    resolved=[{"id": "F-2", "resolved_by": "고쳤다"}]),
            round_=3)
        assert env["exit"] == 0, env["render"]

    def test_an_id_from_one_reviewer_does_not_close_anothers_finding(self, run01):
        """③ 두 리뷰어가 모두 F-1·F-2… 를 쓰므로 id 한 줄이 둘을 동시에 닫았다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        mine = {"id": "F-1", "severity": "major", "title": "내 지적",
                "quote": "범위가 넓다"}
        theirs = {"id": "F-1", "severity": "major", "title": "남의 지적",
                  "quote": "범위가 넓다"}
        _submit_review(repo, paths, _review("plan", findings=[mine]))
        _submit_review(repo, paths, _review("xv", findings=[theirs]))

        # plan 이 자기 F-1 을 닫는 것은 정당하다.
        assert _submit_review(
            repo, paths,
            _review("plan", round_=2,
                    resolved=[{"id": "F-1", "resolved_by": "내 것을 고쳤다"}]),
            round_=2)["exit"] == 0

        # 그러나 xv 의 F-1 은 여전히 열려 있다. 아무 말 없이 넘어갈 수 없다.
        env = _submit_review(repo, paths, _review("xv", round_=2), round_=2)
        assert env["exit"] == 8, "남의 F-1 이 다른 리뷰어의 id 한 줄로 닫혔다"

    def test_raw_without_severity_headings_is_rejected(self, run01):
        """M20 — 이 규칙이 코드에만 있고 문서에 없어서 P1 의 제출 6건 전부에
        메인이 사후에 헤딩을 붙였다. 원문 대조라는 검사의 취지와 어긋난다."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        payload = _review("plan", findings=[
            {"id": "F-1", "severity": "major", "title": "범위", "quote": "범위가 넓다"}])
        j = paths.run_dir / "01_review_r1.json"
        j.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        (paths.run_dir / "01_review_r1.raw.md").write_text(
            "# 리뷰\n\n범위가 넓다\n", encoding="utf-8")
        env = cli.run_record(repo, phase="01", file=str(j),
                             reviewer="plan", round_=1)
        assert env["exit"] == 8
        assert "헤딩" in env["render"]

    def test_the_phase_file_documents_the_raw_format(self, repo):
        """검사가 요구하는 것을 페이즈 파일이 적지 않으면 리뷰어가 알 길이 없다."""
        for name in ("01-plan.md", "02-cross-verify.md"):
            body = (ROOT / "harness" / "phases" / name).read_text(encoding="utf-8")
            submit = body.split("## 제출 형식", 1)[1].split("\n## ", 1)[0]
            assert ".raw.md" in submit, name
            for sev in ("critical", "major", "minor"):
                assert sev in submit, "%s 가 %s 를 적지 않는다" % (name, sev)

    def test_resolved_from_previous_closes_it(self, run01):
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        finding = {"id": "F-1", "severity": "major", "title": "범위",
                   "quote": "범위가 넓다"}
        _submit_review(repo, paths, _review("plan", findings=[finding]))
        _submit_review(repo, paths, _review("xv"))
        env = _submit_review(
            repo, paths,
            _review("plan", round_=2,
                    resolved=[{"id": "F-1", "resolved_by": "범위를 좁혔다"}]),
            round_=2)
        assert env["exit"] == 0, env["render"]


class TestCrossVerifySource:
    """폴백이 섞이면 1라운드 수렴이 막힌다 — 이 리포의 모든 런이 그랬다."""

    def _set_primary(self, repo, value):
        p = repo / "harness" / "config.json"
        cfg = json.loads(p.read_text(encoding="utf-8"))
        cfg["cross_verify"]["primary"] = value
        p.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    def test_the_shipped_config_declares_a_primary(self, repo):
        """MCP 가 실제로 붙어 있는데 config 가 null 이면 폴백만 돈다."""
        cfg = json.loads(
            (ROOT / "harness" / "config.json").read_text(encoding="utf-8"))
        assert cfg["cross_verify"]["primary"], "primary 가 비어 있다"

    def test_primary_makes_the_mode_primary(self, repo, request_file):
        self._set_primary(repo, "some-external-reviewer")
        _, s = st.create_run(repo, "demo", request_file)
        assert s["cross_verify"]["mode"] == "primary"

    def test_no_primary_falls_back(self, repo, request_file):
        self._set_primary(repo, None)
        _, s = st.create_run(repo, "demo", request_file)
        assert s["cross_verify"]["mode"] == "fallback"

    def test_the_packet_names_the_cross_verifier(self, repo, phases, request_file):
        """페이즈 파일 본문은 플레이스홀더가 풀리지 않는다 — 봉투가 알려줘야 한다."""
        self._set_primary(repo, "some-external-reviewer")
        paths, s = st.create_run(repo, "demo", request_file)
        env = cli.run_next(repo, run_id=paths.run_id)
        assert "## 교차검증" in env["render"]
        assert "some-external-reviewer" in env["render"]

    def test_the_packet_says_when_it_is_only_a_fallback(self, repo, phases,
                                                        request_file):
        """폴백이라는 사실이 드러나야 1라운드 수렴이 막히는 이유를 안다."""
        self._set_primary(repo, None)
        paths, s = st.create_run(repo, "demo", request_file)
        env = cli.run_next(repo, run_id=paths.run_id)
        assert "폴백" in env["render"]
        assert "plan-reviewer" in env["render"]

    def test_no_stack_proper_noun_reaches_the_core(self):
        """도구 이름은 config 에만 둔다 — 코어는 읽기만 한다."""
        name = json.loads(
            (ROOT / "harness" / "config.json").read_text(encoding="utf-8")
        )["cross_verify"]["primary"]
        for rel in ("scripts/pipeline/cli.py", "harness/phases/01-plan.md",
                    "harness/phases/02-cross-verify.md"):
            assert name not in (ROOT / rel).read_text(encoding="utf-8"), rel

    def test_doctor_flags_a_missing_fallback_agent_file(self, repo, phases):
        """P1 직전에 plan-reviewer.md 부재를 doctor 가 못 잡았다."""
        (repo / ".claude" / "agents" / "plan-reviewer.md").unlink(missing_ok=True)
        bad = [c for c in cli._pipeline_checks(repo) if c["status"] == "FAIL"]
        assert any("plan-reviewer" in (c.get("message") or "") for c in bad), bad


class TestInitAndNext:

    def test_init_creates_a_run_and_next_renders_the_first_packet(self, repo, phases):
        req = repo / "_workspace" / "requests" / "x.md"
        req.parent.mkdir(parents=True, exist_ok=True)
        req.write_text(REQUEST_TEXT, encoding="utf-8")
        out = _run_cli(repo, "init", "--feature", "demo", "--request-file", str(req))
        assert out.returncode == 0, out.stderr
        env = json.loads(out.stdout)
        assert env["run_id"]

        out2 = _run_cli(repo, "next")
        env2 = json.loads(out2.stdout)
        assert env2["exit"] == 0, env2["render"]
        assert env2["phase"] == "01-plan"
        assert "01_plan.md" in env2["render"]
        assert "cli.py record" in (env2["next_command"] or "")

    def test_init_rejects_a_bad_slug(self, repo, phases, request_file):
        out = _run_cli(repo, "init", "--feature", "Bad Slug",
                       "--request-file", str(request_file))
        assert out.returncode == 2

    def test_next_refuses_when_requires_fail(self, repo, phases, request_file):
        paths, s = st.create_run(repo, "demo", request_file)
        paths.request.unlink()
        out = _run_cli(repo, "next")
        assert out.returncode == 3
        assert json.loads(out.stdout)["data"]["requires_report"]

    def test_record_on_a_passed_phase_is_refused(self, run01):
        """record 는 멱등이 아니다. 재작업은 retry 로만."""
        repo, paths, s = run01
        _submit_plan(repo, paths, _plan())
        _submit_review(repo, paths, _review("plan"))
        _submit_review(repo, paths, _review("xv"))
        env = _submit_plan(repo, paths, _plan())
        assert env["exit"] == 3


# ---------------------------------------------------------------------------
# F. clean_ownership — 소유 경계 · orphan
# ---------------------------------------------------------------------------

def _claims(impl=None, test=None):
    return {"schema": 1, "roles": [
        {"role": "impl", "agent": "impl-writer", "status": "ok",
         "claimed_files": impl or [], "contract_symbols_implemented": []},
        {"role": "test", "agent": "test-writer", "status": "ok",
         "claimed_files": test or [], "contract_symbols_covered": []}]}


@pytest.fixture
def config(repo):
    return harness._read_json(repo / "harness/config.json")


class TestCleanOwnership:

    def test_clean_run_passes(self, repo, config):
        (repo / "src" / "lib" / "match.ts").write_text("// 고침\n", encoding="utf-8")
        got = attr.clean_ownership(repo, config, _claims(impl=["src/lib/match.ts"]))
        assert got["ok"], got["message"]

    def test_role_touching_another_roles_file(self, repo, config):
        """구현 역할이 테스트 파일을 고치면 둘이 서로를 덮는다."""
        (repo / "src" / "lib" / "match.test.ts").write_text("// 고침\n", encoding="utf-8")
        got = attr.clean_ownership(repo, config, _claims(impl=["src/lib/match.test.ts"]))
        assert not got["ok"]
        assert any(v["kind"] == "violation" for v in got["findings"])
        assert got["rollback"]

    def test_orphan_change_is_caught(self, repo, config):
        (repo / "src" / "lib" / "match.ts").write_text("// 고침\n", encoding="utf-8")
        got = attr.clean_ownership(repo, config, _claims())
        assert not got["ok"]
        assert any(v["kind"] == "orphan" for v in got["findings"])

    def test_main_owned_change_is_not_a_violation(self, repo, config):
        (repo / "harness" / "config.json").write_text(
            (repo / "harness" / "config.json").read_text(encoding="utf-8"),
            encoding="utf-8")
        (repo / "CLAUDE.md").write_text("# 가드레일\n한 줄 더\n", encoding="utf-8")
        got = attr.clean_ownership(repo, config, _claims())
        assert got["ok"], got["message"]

    def test_excludes_beats_owns(self, repo, config):
        """구현 역할의 owns 가 src/lib/** 이지만 excludes 가 테스트 파일을 뺀다."""
        impl = next(r for r in config["roles"] if r["id"] == "impl")
        assert not harness.owns_file(impl, "src/lib/match.test.ts")
        assert harness.owns_file(impl, "src/lib/match.ts")

    def test_verdict_agrees_with_the_doctor_glob(self, repo, config):
        """소유 판정이 두 곳에서 갈라지면 안 된다 — 같은 함수를 쓴다."""
        samples = ["src/lib/match.ts", "src/lib/match.test.ts", "src/app/page.tsx",
                   "docs/TRD.md", "harness/config.json", "README.md",
                   "src/components/x.tsx", "src/services/y.ts"]
        for path in samples:
            mine = attr.owner_for_path(config, path)
            theirs = next((r["id"] for r in config["roles"]
                           if harness.owns_file(r, path)), None)
            assert mine == theirs, path


# ---------------------------------------------------------------------------
# H. adapters — 스테이지 상태 · 타임아웃 · 선택자
# ---------------------------------------------------------------------------

class TestAdapters:

    def test_null_cmd_is_absent_and_never_runs(self, repo):
        _config, adapter, cal = adapters.load(repo)
        assert adapters.stage_state(adapter, "e2e") == "absent"
        called = []
        got = adapters.run_stage(repo, adapter, "e2e",
                                 runner=lambda *a: called.append(a) or (0, ""))
        assert got == {"id": "e2e", "state": "skipped", "reason": "absent"}
        assert not called, "없는 스테이지를 실행하지 않는다"
        assert "sec" not in got, "못 잰 값에 0 을 넣지 않는다"

    def test_when_touched_miss(self, repo):
        _config, adapter, _cal = adapters.load(repo)
        assert adapters.when_touched_hit(adapter, "build", ["docs/TRD.md"]) is False
        assert adapters.when_touched_hit(adapter, "build", ["src/app/page.tsx"]) is True
        assert adapters.when_touched_hit(adapter, "compile", ["x"]) is None

    def test_full_timeout_comes_from_calibration_not_the_adapter(self, repo):
        """실측이 어댑터 선언을 이긴다 — 상수가 아니라 함수다."""
        _config, adapter, cal = adapters.load(repo)
        assert adapter["stages"]["full"]["timeout_sec"] == 1800
        assert adapters.stage_timeout(adapter, cal, "full") == (300, "calibration")
        assert adapters.stage_timeout(adapter, None, "full") == (1800, "adapter")

    def test_derived_is_none_not_zero_when_absent(self, repo):
        assert adapters.derived(None, "tests_ran_floor") is None
        assert adapters.derived({}, "tests_ran_floor") is None

    def test_multi_selector_becomes_path_arguments(self, repo):
        """이 어댑터는 select 를 두지 않는다 — 선택자가 경로 필터로 붙는다."""
        _config, adapter, _cal = adapters.load(repo)
        argv = adapters.stage_argv(repo, adapter, "scoped",
                                   ["src/lib/a.test.ts", "src/lib/b.test.ts"])
        assert argv[-2:] == ["src/lib/a.test.ts", "src/lib/b.test.ts"]

    def test_parse_report_agrees_with_the_contract_layer(self, repo):
        _config, adapter, _cal = adapters.load(repo)
        _write_report(repo, tests=7, failures=2)
        mine = adapters.parse_report(repo, adapter)
        theirs = harness._parse_junit(repo, adapter)
        assert (mine["ran"], mine["suites"], mine["failures"], mine["matched"]) == theirs

    def test_infra_pattern_ignored_when_exit_is_zero(self, repo):
        _config, adapter, _cal = adapters.load(repo)
        assert adapters.infra_match(adapter, 0, "ECONNREFUSED 가 로그에 스쳤다") is None
        assert adapters.infra_match(adapter, 1, "ECONNREFUSED") == "ECONNREFUSED"


def _write_report(root, tests=1, failures=0, cases=None):
    """어댑터의 glob 과 같은 구조로 리포트를 만든다."""
    d = Path(root) / "reports" / "junit"
    d.mkdir(parents=True, exist_ok=True)
    body = cases or ""
    d.joinpath("report.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8" ?>\n'
        '<testsuites name="t" tests="%d" failures="%d" errors="0" time="1">\n'
        '  <testsuite name="s" tests="%d" failures="%d" errors="0" skipped="0">\n'
        '%s'
        '  </testsuite>\n</testsuites>\n' % (tests, failures, tests, failures, body),
        encoding="utf-8")


# ---------------------------------------------------------------------------
# G(순수 함수). 귀속 — 소유자 · 시그니처 · flip
# ---------------------------------------------------------------------------

class TestAttribution:

    def test_signature_masks_volatile_parts(self):
        a = attr.signature("impl", "u", "assertion",
                           "expected 3 at C:/x/y.ts:12 (deadbeef1234)")
        b = attr.signature("impl", "u", "assertion",
                           "expected 9 at C:/other/z.ts:44 (cafebabe9999)")
        assert a == b, "경로·숫자·해시를 마스킹해야 같은 실패가 같은 시그니처가 된다"
        c = attr.signature("test", "u", "assertion", "expected 3")
        assert c != a

    def test_symbol_not_found_in_contract_forces_the_primary_role(self, repo, config):
        """경로만 보고 테스트 역할에 보내면 매번 오귀속된다."""
        _c, adapter, _cal = adapters.load(repo)
        log = ("src/lib/match.test.ts(3,10): error TS2305: "
               "Module './match' has no exported member 'matchTitle'.")
        got = attr.attribute_compile(adapter, config, {"matchTitle"}, log)
        assert got and got[0]["owner"] == config["primary_role"]
        assert "primary_role" in got[0]["owner_reason"]

    def test_plain_compile_error_uses_the_path(self, repo, config):
        _c, adapter, _cal = adapters.load(repo)
        log = "src/lib/match.ts(9,3): error TS2322: Type 'string' is not assignable."
        got = attr.attribute_compile(adapter, config, set(), log)
        assert got and got[0]["owner"] == "impl"

    def test_assertion_in_contract_is_ambiguous(self, repo, config):
        _c, adapter, _cal = adapters.load(repo)
        units = [{"unit": "matchTitle 는 0 을 돌려준다", "file": "src/lib/match.test.ts",
                  "ftype": "AssertionError", "message": "expected 1 to be 0",
                  "detail": "at src/lib/match.ts:4"}]
        got = attr.attribute_tests(adapter, config, {"matchTitle"}, units,
                                   repo_files=["src/lib/match.ts", "src/lib/match.test.ts"])
        assert got[0]["owner"] == "ambiguous"

    def test_assertion_outside_contract_goes_to_the_test_role(self, repo, config):
        _c, adapter, _cal = adapters.load(repo)
        units = [{"unit": "지어낸 심볼", "file": "src/lib/match.test.ts",
                  "ftype": "AssertionError", "message": "expected", "detail": ""}]
        got = attr.attribute_tests(adapter, config, {"matchTitle"}, units,
                                   repo_files=["src/lib/match.test.ts"])
        assert got[0]["owner"] == "test"
        assert "out_of_contract" in got[0]["owner_reason"]

    def test_frames_only_count_files_that_exist(self, repo, config):
        """스택 문법에 의존하지 않는다 — 리포에 실재하는 파일만 프레임이다."""
        _c, adapter, _cal = adapters.load(repo)
        frames = attr.frames_from(
            "at wonder (src/lib/match.ts:4)\nat nowhere (vendor/ghost.ts:9)",
            ["src/lib/match.ts", "src/lib/match.test.ts"])
        assert frames == ["src/lib/match.ts"]

    def test_ambiguous_goes_to_primary_then_flips(self, repo, config):
        failures = [{"id": "F-1", "owner": "ambiguous", "sig": "abc",
                     "file": "src/lib/match.test.ts"}]
        flip = {}
        first = attr.resolve_ambiguous(failures, config, flip)
        assert first[0]["owner"] == "impl"
        second = attr.resolve_ambiguous(
            [dict(failures[0])], config, flip)
        assert second[0]["owner"] == "test", "동일 시그니처 재발이면 다음 역할로 넘긴다"
        third = attr.resolve_ambiguous([dict(failures[0])], config, flip)
        assert third[0]["owner"] == "contract", "또 재발하면 계약 결함으로 재분류한다"

    def test_dispatch_never_assigns_two_owners_that_share_a_target(self, repo, config):
        """핑퐁 방지 — 같은 대상을 두고 둘에게 동시에 보내지 않는다."""
        failures = [
            {"id": "F-1", "owner": "impl", "sig": "a", "frames": ["src/lib/match.ts"]},
            {"id": "F-2", "owner": "test", "sig": "b", "frames": ["src/lib/match.ts"]},
        ]
        got = attr.dispatch(failures, config, prev_sigs=[], flip_state={})
        assert got["owner"] in ("impl", "test")
        assert got["deferred"], "나머지는 미룬 것으로 드러난다"

    def test_disjoint_failures_may_go_out_together(self, repo, config):
        failures = [
            {"id": "F-1", "owner": "impl", "sig": "a", "frames": ["src/lib/match.ts"]},
            {"id": "F-2", "owner": "test", "sig": "b", "frames": ["src/lib/other.test.ts"]},
        ]
        got = attr.dispatch(failures, config, prev_sigs=[], flip_state={})
        assert got["parallel"] is True and not got["deferred"]

    def test_same_signature_twice_is_stuck(self, repo, config):
        failures = [{"id": "F-1", "owner": "impl", "sig": "a", "frames": []}]
        got = attr.dispatch(failures, config, prev_sigs=["a"], flip_state={})
        assert got["stuck"] is True, "예산이 남아도 즉시 에스컬레이션이다"


# ---------------------------------------------------------------------------
# G. 게이트 · 귀속 — replay 픽스처
# ---------------------------------------------------------------------------

CONTRACT_MD = """# 계약: 제목 유사도

## 스키마·데이터 변경

없음.

## 외부 경계

없음.

## 유닛

- `lib/match.ts · matchTitle(a: string, b: string): number`
  - 정상: 0~1 유사도 / 예외: 빈 문자열 → `0`

## 진입점

없음.

## 오류 어휘

- `MATCH_EMPTY` (400)
"""

FIXTURES = ROOT / "scripts" / "fixtures" / "gate"


def make_fixture(base, case, stages, *, tests=None, failures=0, cases="",
                 with_report=True, with_contract=True, changed=None,
                 stdouts=None):
    """replay 픽스처 하나. 어댑터 glob 과 같은 구조로 리포트를 놓는다."""
    d = Path(base) / case
    (d / "reports" / "junit").mkdir(parents=True, exist_ok=True)
    manifest = {"schema": 1, "case": case, "adapter": "nextjs-ts",
                "stages": stages,
                "changed_paths": changed or ["src/lib/match.ts",
                                             "src/lib/match.test.ts"],
                "repo_files": ["src/lib/match.ts", "src/lib/match.test.ts",
                               "package.json"]}
    for name, text in (stdouts or {}).items():
        (d / ("%s.stdout.txt" % name)).write_text(text, encoding="utf-8")
        manifest["stages"].setdefault(name, {})["stdout"] = "%s.stdout.txt" % name
    (d / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    if with_contract:
        (d / "contract.md").write_text(CONTRACT_MD, encoding="utf-8")
    if with_report:
        _write_report_at(d / "reports" / "junit", tests if tests is not None else 1300,
                         failures, cases)
    return d


def _write_report_at(d, tests, failures, cases=""):
    d.mkdir(parents=True, exist_ok=True)
    d.joinpath("report.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8" ?>\n'
        '<testsuites name="t" tests="%d" failures="%d" errors="0" time="1">\n'
        '  <testsuite name="s" tests="%d" failures="%d" errors="0" skipped="0">\n'
        '%s'
        '  </testsuite>\n</testsuites>\n' % (tests, failures, tests, failures, cases),
        encoding="utf-8")


ALL_PASS = {"compile": {"exit": 0}, "lint": {"exit": 0}, "check": {"exit": 0},
            "scoped": {"exit": 0}, "full": {"exit": 0}, "build": {"exit": 0}}


@pytest.fixture
def fxdir(tmp_path_factory):
    """픽스처는 리포 **밖**에 만든다.

    리포 안에 두면 그 파일들이 변경 집합에 들어가 clean_ownership 이 orphan 으로
    잡는다 — 픽스처가 검사 대상이 되어 버린다.
    """
    return tmp_path_factory.mktemp("gatefx")


@pytest.fixture
def gated(repo, phases, request_file):
    """04-gate 진입 직전까지 세팅된 런."""
    paths, s = st.create_run(repo, "sim", request_file)
    contract_path = repo / "_workspace" / "contract_sim.md"
    contract_path.parent.mkdir(parents=True, exist_ok=True)
    contract_path.write_text(CONTRACT_MD, encoding="utf-8")
    s["contract"] = {"mode": "contract", "present": True,
                     "path": "_workspace/contract_sim.md"}
    st.set_phase_status(s, "01-plan", "passed")
    st.set_phase_status(s, "02-cross-verify", "passed")
    st.set_phase_status(s, "03-implement", "passed")
    s["phase"] = "04-gate"
    st.save(paths, s)
    return repo, paths, s


def _gate(repo, fixture, **kw):
    return cli.run_gate_cmd(repo, phase="04", replay=str(fixture), **kw)


class TestGateReplay:

    def test_replay_never_runs_a_stage_for_real(self, gated, fxdir, monkeypatch):
        """픽스처가 실물 러너를 부르면 replay 의 값이 사라진다.

        git 은 부른다(변경 집합·지문) — 막는 것은 **스테이지 실행**이다.
        """
        repo, paths, s = gated
        fx = make_fixture(fxdir, "all-pass", dict(ALL_PASS))
        monkeypatch.setattr(adapters, "_default_runner",
                            lambda *a, **k: pytest.fail("실물 러너를 불렀다"))
        env = _gate(repo, fx)
        assert env["exit"] in (0, 11), env["render"]

    def test_all_pass_grades_pass_with_gaps_for_absent_stages(self, gated, fxdir):
        """cmd:null 스테이지는 스킵으로 기록되고 등급에 반영된다."""
        repo, paths, s = gated
        fx = make_fixture(fxdir, "all-pass", dict(ALL_PASS))
        env = _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        assert "stage_absent:e2e" in report["gaps"]
        assert "stage_absent:docs" in report["gaps"]
        assert report["grade"] == "PASS_WITH_GAPS"

    def test_greenfield_zero_tests_is_not_a_green_light(self, gated, fxdir):
        """3단계 게이트 4번 — 빈 스위트는 통과하고, 통과는 초록불로 보인다."""
        repo, paths, s = gated
        fx = make_fixture(fxdir, "greenfield-zero-tests", dict(ALL_PASS), tests=0)
        env = _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        assert report["tests"]["ran"] == 0
        assert report["tests"]["status"] == "none"
        assert "tests_ran_zero" in report["gaps"]
        assert report["grade"] == "PASS_WITH_GAPS", "PASS 가 아니다"
        assert env["exit"] in (0, 11), "비차단이다 — 진행은 한다"

    def test_missing_report_is_infra_and_spends_no_counter(self, gated, fxdir):
        """리포트 경로 설정 오류일 수 있다. 구현 역할의 실패로 세지 않는다."""
        repo, paths, s = gated
        fx = make_fixture(fxdir, "no-report", dict(ALL_PASS), with_report=False)
        env = _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        assert report["tests"]["status"] == "none"
        assert "test_report_missing" in report["gaps"]
        _, after = st.load(repo, paths.run_id)
        assert not (after.get("counters") or {}).get("repair")

    def test_shrank_tests_block(self, gated, fxdir):
        """테스트가 삭제·스킵된 것을 잡는다."""
        repo, paths, s = gated
        fx = make_fixture(fxdir, "tests-shrank", dict(ALL_PASS), tests=100)
        env = _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        assert report["tests"]["status"] == "shrank"
        assert env["exit"] in (4, 5, 10)

    def test_infra_pattern_escalates_without_spending_the_counter(self, gated, fxdir):
        repo, paths, s = gated
        stages = dict(ALL_PASS, scoped={"exit": 1})
        fx = make_fixture(fxdir, "infra", stages,
                          stdouts={"scoped": "Error: connect ECONNREFUSED 127.0.0.1:5432\n"})
        env = _gate(repo, fx)
        assert env["exit"] == 10
        _, after = st.load(repo, paths.run_id)
        assert not (after.get("counters") or {}).get("repair"), "카운터를 소모하지 않는다"
        assert after["escalated"] is True

    def test_compile_symbol_error_goes_to_the_primary_role(self, gated, fxdir):
        repo, paths, s = gated
        stages = dict(ALL_PASS, compile={"exit": 2})
        log = ("src/lib/match.test.ts(3,10): error TS2305: "
               "Module './match' has no exported member 'matchTitle'.\n")
        fx = make_fixture(fxdir, "compile-symbol", stages, stdouts={"compile": log})
        env = _gate(repo, fx)
        assert env["exit"] == 4
        assert env["data"]["repair_dispatch"]["owner"] == "impl"

    def test_scoped_selector_is_a_path_not_a_test_name(self, gated, fxdir):
        """M16 — 이름 필터는 파일 수집을 줄이지 못한다."""
        repo, paths, s = gated
        fx = make_fixture(fxdir, "selector", dict(ALL_PASS))
        _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        scoped = next(x for x in report["stages"] if x["id"] == "scoped")
        assert scoped["selector"] == ["src/lib/match.test.ts"]
        assert scoped["selector_kind"] == "path"
        assert "matchTitle" not in json.dumps(scoped["selector"]), \
            "테스트 이름이 아니라 파일 경로다"

    def test_no_selector_skips_scoped_and_does_not_fall_back_to_full(self, gated, fxdir):
        repo, paths, s = gated
        (repo / "_workspace" / "contract_sim.md").write_text(
            CONTRACT_MD.replace("`lib/match.ts · matchTitle(a: string, b: string): number`",
                                "`없는파일.ts · nothing()`"), encoding="utf-8")
        fx = make_fixture(fxdir, "no-selector", dict(ALL_PASS),
                          with_contract=False)
        (fx / "contract.md").write_text(
            CONTRACT_MD.replace("`lib/match.ts · matchTitle(a: string, b: string): number`",
                                "`없는파일.ts · nothing()`"), encoding="utf-8")
        _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        scoped = next(x for x in report["stages"] if x["id"] == "scoped")
        assert scoped == {"id": "scoped", "state": "skipped", "reason": "no_selector"}
        assert "stage_no_selector:scoped" in report["gaps"]

    def test_when_touched_miss_is_recorded_as_skipped(self, gated, fxdir):
        repo, paths, s = gated
        fx = make_fixture(fxdir, "untouched", dict(ALL_PASS),
                          changed=["docs/TRD.md"])
        _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        build = next(x for x in report["stages"] if x["id"] == "build")
        assert build["reason"] == "not_touched"

    def test_same_signature_twice_escalates_even_with_budget_left(self, gated, fxdir):
        repo, paths, s = gated
        stages = dict(ALL_PASS, compile={"exit": 2})
        log = "src/lib/match.ts(9,3): error TS2322: Type mismatch.\n"
        fx = make_fixture(fxdir, "same-sig", stages, stdouts={"compile": log})
        first = _gate(repo, fx)
        assert first["exit"] == 4
        second = _gate(repo, fx)
        assert second["exit"] == 10, "동일 시그니처 2회면 예산이 남아도 멈춘다"

    def test_single_stage_run_spends_no_counter_and_keeps_the_report(self, gated, fxdir):
        repo, paths, s = gated
        fx = make_fixture(fxdir, "single", dict(ALL_PASS))
        env = cli.run_gate_cmd(repo, phase="04", only_stage="compile",
                               replay=str(fx))
        assert env["exit"] == 0
        assert not (paths.run_dir / "04_gate_report.json").exists()
        _, after = st.load(repo, paths.run_id)
        assert not (after.get("counters") or {}).get("repair")

    def test_uncalibrated_and_unverified_show_up_in_gaps(self, gated, fxdir):
        """미캘리브레이션·verified:false 가 조용히 통과하지 않는다."""
        repo, paths, s = gated
        (repo / "harness" / "calibration.json").unlink()
        fx = make_fixture(fxdir, "uncal", dict(ALL_PASS))
        _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        assert "uncalibrated_run" in report["gaps"]
        assert "adapter_unverified" in report["gaps"]

    def test_inactive_rules_are_named(self, gated, fxdir):
        """없는 것과 조용히 안 도는 것을 구분한다."""
        repo, paths, s = gated
        fx = make_fixture(fxdir, "inactive", dict(ALL_PASS))
        _gate(repo, fx)
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        assert any("migration" in r for r in report["rules_inactive"])


class TestCommittedFixtures:
    """디스크에 커밋된 픽스처 — 3단계 게이트가 이것으로 재현된다."""

    def test_greenfield_fixture_exists_and_is_tracked(self):
        fx = FIXTURES / "greenfield-zero-tests"
        assert (fx / "manifest.json").exists()
        assert (fx / "reports" / "junit" / "report.xml").exists(), \
            ".gitignore 의 reports/ 앵커가 이 파일을 삼키면 안 된다"

    def test_greenfield_fixture_reproduces_pass_with_gaps(self, gated):
        repo, paths, s = gated
        env = _gate(repo, FIXTURES / "greenfield-zero-tests")
        report = json.loads((paths.run_dir / "04_gate_report.json")
                            .read_text(encoding="utf-8"))
        assert report["grade"] == "PASS_WITH_GAPS"
        assert "tests_ran_zero" in report["gaps"]


class TestFlowCommands:
    """advance · retry · escalate · resume"""

    def test_advance_refuses_when_the_receipt_is_stale(self, gated, fxdir):
        """게이트 통과 뒤 소스가 바뀌면 막힌다 — 막히는 것이 정상 동작이다."""
        repo, paths, s = gated
        _gate(repo, make_fixture(fxdir, "adv", dict(ALL_PASS)))
        _, after = st.load(repo, paths.run_id)
        assert after.get("fingerprint"), "게이트가 영수증을 남겼어야 한다"

        (repo / "src" / "lib" / "match.ts").write_text("// 한 글자\n", encoding="utf-8")
        env = cli.run_advance(repo, "04", run_id=paths.run_id)
        assert env["exit"] == 6
        assert "낡았다" in env["render"]

    def test_advance_refuses_when_a_product_is_missing(self, gated):
        repo, paths, s = gated
        env = cli.run_advance(repo, "04", run_id=paths.run_id)
        assert env["exit"] == 6

    def test_retry_reopens_a_failed_phase(self, gated):
        repo, paths, s = gated
        st.set_phase_status(s, "04-gate", "failed")
        st.save(paths, s)
        env = cli.run_retry(repo, "04", "repair", "수리한다", run_id=paths.run_id)
        assert env["exit"] == 0
        _, after = st.load(repo, paths.run_id)
        assert st.phase_status(after, "04-gate") == "running"

    def test_retry_escalates_at_the_limit(self, gated):
        repo, paths, s = gated
        for _ in range(3):
            env = cli.run_retry(repo, "04", "repair", "또", run_id=paths.run_id)
        assert env["exit"] == 7
        _, after = st.load(repo, paths.run_id)
        assert after["escalated"] is True
        assert paths.escalation.exists()

    def test_escalated_state_locks_every_command(self, gated):
        repo, paths, s = gated
        cli.run_escalate(repo, "사람 판단", run_id=paths.run_id)
        for env in (cli.run_next(repo, paths.run_id),
                    cli.run_gate_cmd(repo, run_id=paths.run_id)):
            assert env["exit"] == 10, env["cmd"]

    def test_resume_needs_an_explicit_ack(self, gated):
        repo, paths, s = gated
        cli.run_escalate(repo, "사람 판단", run_id=paths.run_id)
        assert cli.run_resume(repo, ack=False, run_id=paths.run_id)["exit"] == 2
        env = cli.run_resume(repo, ack=True, run_id=paths.run_id)
        assert env["exit"] == 0
        _, after = st.load(repo, paths.run_id)
        assert after["escalated"] is False

    def test_resume_is_not_the_session_recovery_path(self, gated):
        """잠기지 않은 런에는 아무것도 하지 않고 next 를 가리킨다."""
        repo, paths, s = gated
        env = cli.run_resume(repo, ack=True, run_id=paths.run_id)
        assert env["exit"] == 0
        assert "next --run-id" in (env["next_command"] or "")


# ---------------------------------------------------------------------------
# I. 3단계 게이트 잠금 (ADR-H013)
# ---------------------------------------------------------------------------

CORE_GLOBS = [
    "scripts/pipeline/*.py",
    "harness/phases/*.md",
    "harness/templates/*.md",
    ".claude/commands/*.md",
    ".claude/agents/*.md",
]


def _banned_words():
    """금지어 목록을 **team-spec 에서 읽어 온다.**

    테스트에 복사하면 정본이 늘어날 때 이 검사가 조용히 뒤처진다.
    """
    text = (ROOT / "docs" / "harness" / "pipeline" / "team-spec.md").read_text(
        encoding="utf-8")
    m = re.search(r"검수 기준.*?```\n(.*?)```", text, re.S)
    assert m, "team-spec 0.2 의 금지어 블록을 찾지 못했다"
    return sorted(set(m.group(1).split()))


class TestPromotionGate:
    """ADR-H013 이 다섯 줄로 재정의한 3단계 게이트."""

    def test_gate_1_no_stack_proper_nouns_in_the_core(self):
        banned = _banned_words()
        hits = []
        for pattern in CORE_GLOBS:
            for path in sorted(ROOT.glob(pattern)):
                text = path.read_text(encoding="utf-8").lower()
                for word in banned:
                    if word in text:
                        hits.append("%s: %s" % (path.relative_to(ROOT), word))
        assert hits == [], "코어에 스택 고유명사가 박혔다: %s" % hits

    def test_gate_1_covers_every_core_file(self):
        """glob 이 실제로 파일을 잡는지 — 0건 통과가 '검사 안 함'이면 안 된다."""
        for pattern in CORE_GLOBS:
            assert list(ROOT.glob(pattern)), "이 glob 이 아무 파일도 안 잡는다: %s" % pattern

    def test_gate_2_swapping_the_adapter_leaves_the_core_untouched(self, repo, phases,
                                                                   fxdir, request_file):
        """어댑터만 바꿔 lint-phases 와 gate --replay 가 통과하는가."""
        second = repo / "harness" / "adapters" / "other.json"
        base = harness._read_json(repo / "harness" / "adapters" / "nextjs-ts.json")
        base["id"] = "other"
        base["runner"] = {"bin": "make", "common_args": [], "cwd": "."}
        base["stages"] = {k: ({"cmd": ["run", k]} if v.get("cmd") else {"cmd": None})
                          for k, v in base["stages"].items()}
        base["stages"]["scoped"]["loop_stage"] = True
        base["stages"]["full"]["once_after_loop"] = True
        second.write_text(json.dumps(base, ensure_ascii=False, indent=2),
                          encoding="utf-8")
        cfg_path = repo / "harness" / "config.json"
        cfg = harness._read_json(cfg_path)
        cfg["adapter"] = "other"
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                            encoding="utf-8")

        findings = cli.lint_phases(repo)
        assert [f for f in findings if f["status"] == "FAIL"] == []

    def test_gate_3_swapping_the_language_leaves_the_core_untouched(self, repo, phases):
        """절 제목과 언어를 바꿔도 코어·페이즈 파일을 손대지 않는다."""
        cfg_path = repo / "harness" / "config.json"
        cfg = harness._read_json(cfg_path)
        cfg["project"]["language"] = "en"
        cfg["contract"]["sections"] = {
            "units": "## Units", "entrypoints": "## Entrypoints",
            "errors": "## Errors", "schema": "## Schema",
            "boundaries": "## Boundaries"}
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        tpl = repo / "harness" / "templates" / "contract.md"
        text = tpl.read_text(encoding="utf-8")
        for ko, en in [("## 유닛", "## Units"), ("## 진입점", "## Entrypoints"),
                       ("## 오류 어휘", "## Errors"),
                       ("## 스키마·데이터 변경", "## Schema"),
                       ("## 외부 경계", "## Boundaries")]:
            text = text.replace(ko, en)
        tpl.write_text(text, encoding="utf-8")

        findings = cli.lint_phases(repo)
        assert [f for f in findings if f["status"] == "FAIL"] == []
        parsed = contract_mod.parse(text, harness._read_json(cfg_path))
        assert parsed["units"], "절 제목이 바뀌어도 파서가 찾는다"

    def test_the_adapter_stays_unverified_until_a_real_run(self):
        """픽스처는 내가 만든 출력이지 진짜 러너 출력이 아니다."""
        adapter = harness._read_json(ROOT / "harness/adapters/nextjs-ts.json")
        assert adapter["verified"] is False
        assert "_unconsumed" in adapter["attribution"]


# ---------------------------------------------------------------------------
# J  세션 원장 — SessionEnd 훅이 사실만 쌓는다
# ---------------------------------------------------------------------------

import io  # noqa: E402
import time  # noqa: E402

import session_log as sl  # noqa: E402

HOOK_IN = {"session_id": "sid-1", "transcript_path": "", "cwd": ".",
           "hook_event_name": "SessionEnd", "reason": "clear"}


def _ledger_lines(root):
    p = Path(root) / sl.LEDGER_REL
    if not p.exists():
        return []
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()]


class TestSessionLedger:
    """훅은 셸이라 해석을 못 쓴다. **그래서 사실만 쌓는다.**

    거짓말할 수 없는 부분(커밋·변경량·런 등급)과 해석을 갈라 두지 않으면
    검증하는 사람 없이 문서에 추측이 쌓인다.
    """

    def test_broken_stdin_still_exits_zero_and_records_error(self, repo):
        """세션 종료를 막으면 안 되고, 실패가 조용히 사라져도 안 된다."""
        code = sl.main(["--from-hook"], stdin=io.StringIO("이건 JSON 이 아니다"),
                       root=repo)
        assert code == 0
        rows = _ledger_lines(repo)
        assert len(rows) == 1
        assert "error" in rows[0]
        # 실패와 "기록할 게 없음"이 같은 모양이면 안 된다.
        assert "commits" not in rows[0]

    def test_missing_transcript_omits_session_key(self, repo):
        """0 으로 채우면 '안 쟀다'가 사라진다 (ADR-H007)."""
        rec = sl.collect(repo, HOOK_IN, transcript_root=repo / "없는곳")
        assert "session" not in rec

    def test_transcript_metrics_are_carried_when_present(self, repo, tmp_path):
        troot = tmp_path / "projects"
        (troot / "slug").mkdir(parents=True)
        (troot / "slug" / "sid-1.jsonl").write_text(
            json.dumps({"message": {"content": [
                {"type": "tool_result", "content": "가나다"}]}},
                ensure_ascii=False) + "\n", encoding="utf-8")
        rec = sl.collect(repo, HOOK_IN, transcript_root=troot)
        assert rec["session"]["tool_result_chars"] == 3

    def test_hangul_commit_subject_survives(self, repo):
        (repo / "src" / "lib" / "새파일.ts").write_text("export const a = 1\n",
                                                     encoding="utf-8")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-qm", "feat(파이프라인): 한글 제목 — em dash 포함")
        sl.main(["--from-hook"], stdin=io.StringIO(json.dumps(HOOK_IN)), root=repo)
        row = _ledger_lines(repo)[0]
        subjects = [c["subject"] for c in row["commits"]]
        assert any("한글 제목 — em dash" in s for s in subjects)

    def test_no_workspace_runs_omits_run_key(self, repo):
        """파이프라인을 안 돌린 세션이 정상 경로다."""
        rec = sl.collect(repo, HOOK_IN)
        assert "run" not in rec

    def test_latest_run_is_carried(self, repo):
        d = repo / "_workspace" / "runs" / "20260903-1220-d9c0"
        d.mkdir(parents=True)
        (d / "state.json").write_text(json.dumps({
            "run_id": "20260903-1220-d9c0", "grade": "PASS_WITH_GAPS",
            "gaps": ["stage_absent:e2e"], "counters": {"round": {"used": 3}},
            "budget": {"model_calls": {"total": 10}},
            "tests": {"ran": 1333}}, ensure_ascii=False), encoding="utf-8")
        rec = sl.collect(repo, HOOK_IN)
        assert rec["run"]["grade"] == "PASS_WITH_GAPS"
        assert rec["run"]["rounds"] == 3
        assert rec["run"]["model_calls"] == 10
        assert rec["tests"]["app"] == 1333

    def test_append_only_keeps_existing_lines(self, repo):
        sl.append(repo, {"ts": "t1", "marker": "먼저"})
        sl.main(["--from-hook"], stdin=io.StringIO(json.dumps(HOOK_IN)), root=repo)
        rows = _ledger_lines(repo)
        assert len(rows) == 2
        assert rows[0]["marker"] == "먼저"      # 기존 줄은 손대지 않는다

    def test_finds_root_from_subdirectory(self, repo, monkeypatch):
        """훅은 하위 디렉터리에서 돌 수 있다."""
        sub = repo / "src" / "lib"
        monkeypatch.delenv("CLAUDE_PROJECT_DIR", raising=False)
        assert sl.find_root({"cwd": str(sub)}, env={}) == repo

    def test_env_project_dir_wins_over_cwd(self, repo, tmp_path):
        other = tmp_path / "다른곳"
        other.mkdir()
        found = sl.find_root({"cwd": str(other)},
                             env={"CLAUDE_PROJECT_DIR": str(repo)})
        assert found == repo

    def test_uncommitted_change_is_counted(self, repo):
        (repo / "src" / "lib" / "match.ts").write_text("export const b = 2\n",
                                                       encoding="utf-8")
        rec = sl.collect(repo, HOOK_IN)
        assert rec["uncommitted"]["files"] >= 1
        assert rec["dirty"] is True

    def test_untracked_file_is_not_lost(self, repo):
        """`git diff` 는 새 파일을 안 센다 — 세면 안 되는 게 아니라 못 보는 것이다.

        새 파일이 안 세지면 "파일 3개 바뀜"이 사실보다 작게 적히고, 그 숫자를
        나중에 근거로 쓴다.
        """
        (repo / "src" / "lib" / "새것.ts").write_text("export const c = 3\n",
                                                    encoding="utf-8")
        rec = sl.collect(repo, HOOK_IN)
        assert rec["uncommitted"]["untracked"] == 1

    def test_gitignored_file_is_not_counted_as_untracked(self, repo):
        (repo / "_workspace").mkdir()
        (repo / "_workspace" / "임시.txt").write_text("x", encoding="utf-8")
        rec = sl.collect(repo, HOOK_IN)
        assert "uncommitted" not in rec

    def test_collect_fits_the_sessionend_budget(self, repo):
        """SessionEnd 예산을 넘기면 기록이 통째로 버려진다."""
        started = time.time()
        sl.collect(repo, HOOK_IN)
        assert time.time() - started < 2.0


# ---------------------------------------------------------------------------
# J. 규칙 원장 — findings.jsonl · taxonomy.json · staged 승격
# ---------------------------------------------------------------------------

import ledger as ldg  # noqa: E402


def _finding(category="NAMING", severity="major", role="impl", title="제목",
             resolution="deferred", source="reviewer", reported_by=None):
    return {"category": category, "severity": severity, "target_role": role,
            "title": title, "resolution": resolution, "source": source,
            "reported_by": reported_by or ["arch"]}


class TestLedgerTaxonomy:
    """이 파일 하나가 원장 어휘 · 승격 목적지 · 리뷰 범위 셋의 단일 출처다.

    그래서 손상되면 셋이 동시에 조용히 틀어진다 — lint-phases 가 잡아야 한다.
    """

    def test_seed_creates_the_three_ledger_files(self, repo):
        ldg.seed(repo)
        assert (repo / ldg.TAXONOMY_REL).exists()
        assert (repo / ldg.FINDINGS_REL).exists()
        assert (repo / ldg.CHANGELOG_REL).exists()

    def test_seed_is_idempotent_and_never_overwrites(self, repo):
        ldg.seed(repo)
        ldg.append(repo, "r1", "05", [_finding()])
        ldg.seed(repo)
        assert len(ldg.read_all(repo)) == 1     # 시드가 원장을 지우지 않는다

    def test_seed_passes_its_own_validator(self, repo):
        """템플릿이 자기 파서를 통과해야 하는 것과 같은 규율이다."""
        ldg.seed(repo)
        assert ldg.validate_taxonomy(ldg.load_taxonomy(repo)) == []

    def test_excluded_categories_are_active_and_machine_enforced(self, repo):
        """active + enforceable != prose 인 것만 05 의 검토 제외 목록이다."""
        ldg.seed(repo)
        excluded = ldg.excluded_categories(repo)
        cats = ldg.categories(repo)
        assert excluded, "시드에 기계 강제 가능한 active 항목이 하나는 있어야 한다"
        for code in excluded:
            assert cats[code]["status"] == "active"
            assert cats[code]["enforceable"] in ("lint", "check")
        # prose 는 기계가 못 막으므로 리뷰 범위에서 빼면 안 된다.
        assert not any(cats[c]["enforceable"] == "prose" for c in excluded)

    def test_duplicate_code_is_rejected(self, repo):
        data = {"version": 1, "categories": [
            {"code": "NAMING", "enforceable": "lint", "rule": "r", "status": "active"},
            {"code": "NAMING", "enforceable": "prose", "status": "active"}]}
        errs = ldg.validate_taxonomy(data)
        assert any("유니크" in e for e in errs)

    def test_unknown_enforceable_vocabulary_is_rejected(self, repo):
        data = {"version": 1, "categories": [
            {"code": "X", "enforceable": "archunit", "status": "active"}]}
        assert any("enforceable" in e for e in ldg.validate_taxonomy(data))

    def test_unknown_status_vocabulary_is_rejected(self, repo):
        data = {"version": 1, "categories": [
            {"code": "X", "enforceable": "prose", "status": "켜짐"}]}
        assert any("status" in e for e in ldg.validate_taxonomy(data))

    def test_lint_or_check_category_without_rule_is_rejected(self, repo):
        """규칙 참조가 없으면 '어디에 승격할지'를 아무도 모른다."""
        data = {"version": 1, "categories": [
            {"code": "X", "enforceable": "lint", "status": "active"}]}
        assert any("rule" in e for e in ldg.validate_taxonomy(data))


class TestLedgerFindings:
    """append-only. 집계 파일을 두지 않고 매번 재계산한다."""

    def test_finding_key_ignores_path(self, repo):
        """'동일 유형'은 파일을 가로질러야 의미가 있다."""
        a = dict(_finding(), path="src/a.ts")
        b = dict(_finding(), path="src/b.ts")
        assert ldg.finding_key(a) == ldg.finding_key(b)

    def test_finding_key_separates_role(self, repo):
        assert ldg.finding_key(_finding(role="impl")) != ldg.finding_key(_finding(role="test"))

    def test_append_writes_one_line_per_finding(self, repo):
        ldg.seed(repo)
        ldg.append(repo, "r1", "05", [_finding(title="가"), _finding(title="나")])
        rows = ldg.read_all(repo)
        assert len(rows) == 2
        assert {r["run_id"] for r in rows} == {"r1"}
        assert all(r["phase"] == "05" for r in rows)

    def test_append_preserves_hangul_without_escaping(self, repo):
        ldg.seed(repo)
        ldg.append(repo, "r1", "05", [_finding(title="한글 제목 — em dash")])
        raw = (repo / ldg.FINDINGS_REL).read_text(encoding="utf-8")
        assert "한글 제목 — em dash" in raw     # ensure_ascii=False 여야 한다

    def test_append_is_append_only(self, repo):
        ldg.seed(repo)
        ldg.append(repo, "r1", "05", [_finding(title="먼저")])
        ldg.append(repo, "r2", "05", [_finding(title="나중")])
        rows = ldg.read_all(repo)
        assert [r["title_norm"] for r in rows] == ["먼저", "나중"]

    def test_unknown_category_is_rejected_not_silently_written(self, repo):
        ldg.seed(repo)
        with pytest.raises(ValueError):
            ldg.append(repo, "r1", "05", [_finding(category="아무거나")])

    def test_unknown_resolution_is_rejected(self, repo):
        ldg.seed(repo)
        with pytest.raises(ValueError):
            ldg.append(repo, "r1", "05", [_finding(resolution="고쳤음")])


class TestLedgerIdentity:
    """원장 행의 신원은 `(run_id, phase, finding_key)` 이고 갱신은 **승계**다.

    파일은 append-only 그대로다 — 그 성질이 tracked 파일의 머지를 자명한
    union 으로 만든다. 가변성은 쓰기가 아니라 **읽기**로 옮긴다.
    """

    def _row(self, **kw):
        d = {"category": "NAMING", "severity": "major", "target_role": "impl",
             "title": "이름이 규약을 벗어난다", "resolution": "deferred",
             "source": "reviewer"}
        d.update(kw)
        return d

    def test_같은_런_같은_페이즈의_같은_키는_한_번만_세어진다(self, repo):
        """M30 — 라운드마다 한 줄씩 쌓이면 `count` 축이 무력해진다."""
        ldg.seed(repo)
        for _ in range(3):
            ldg.append(repo, "R1", "05", [self._row()])
        obs = ldg.observations(repo)
        assert len(obs) == 1
        assert obs[0]["run_id"] == "R1"

    def test_05_와_07_은_같은_런에서도_따로_센다(self, repo):
        """신원에 phase 를 넣지 않으면 `count` 가 `distinct_runs` 를 흡수한다."""
        ldg.seed(repo)
        ldg.append(repo, "R1", "05", [self._row()])
        ldg.append(repo, "R1", "07", [self._row()])
        assert len(ldg.observations(repo)) == 2

    def test_마지막_행이_이긴다(self, repo):
        """M29 — 승계. 뒤에 온 `repaired` 가 앞의 `deferred` 를 대신한다."""
        ldg.seed(repo)
        ldg.append(repo, "R1", "05", [self._row()])
        ldg.append(repo, "R1", "05", [self._row(resolution="repaired",
                                                repaired_by="main")])
        obs = ldg.observations(repo)
        assert len(obs) == 1
        assert obs[0]["resolution"] == "repaired"
        assert obs[0]["repaired_by"] == "main"

    def test_severity_는_최대로_접힌다(self, repo):
        ldg.seed(repo)
        ldg.append(repo, "R1", "05", [self._row(severity="critical")])
        ldg.append(repo, "R1", "05", [self._row(severity="minor")])
        assert ldg.observations(repo)[0]["severity"] == "critical"

    def test_원장_파일은_다시_쓰이지_않는다(self, repo):
        """append-only 잠금 — 이전 바이트가 접두사로 남아야 한다."""
        ldg.seed(repo)
        p = repo / ldg.FINDINGS_REL
        ldg.append(repo, "R1", "05", [self._row()])
        before = p.read_bytes()
        ldg.append(repo, "R1", "05", [self._row(resolution="repaired")])
        assert p.read_bytes().startswith(before)

    def test_read_all_은_승계_행을_전부_보존한다(self, repo):
        """감사 이력이 사라지지 않는다 — 접기는 읽기에서만 일어난다."""
        ldg.seed(repo)
        ldg.append(repo, "R1", "05", [self._row()])
        ldg.append(repo, "R1", "05", [self._row(resolution="repaired")])
        assert len(ldg.read_all(repo)) == 2

    def test_승격_집계가_라운드_반복에_속지_않는다(self, repo):
        """major 임계는 3회/2런이다. 한 런의 3라운드로 채워지면 안 된다."""
        ldg.seed(repo)
        for _ in range(3):
            ldg.append(repo, "R1", "05", [self._row()])
        got = ldg.stage_promotions(repo)
        assert got["candidates"] == []
        keys = [b["count"] for b in got["held"]] or [0]
        assert max(keys) <= 1, "한 런은 한 번이다"


class TestLedgerBaseline:
    """untested_contract_item 의 baseline 기간 판정 (§E6)."""

    def test_empty_ledger_is_in_baseline(self, repo):
        ldg.seed(repo)
        assert ldg.distinct_runs(repo) == 0
        assert ldg.in_baseline(repo, 3) is True

    def test_baseline_closes_after_three_distinct_runs(self, repo):
        ldg.seed(repo)
        for rid in ("r1", "r2"):
            ldg.append(repo, rid, "05", [_finding()])
        assert ldg.in_baseline(repo, 3) is True
        ldg.append(repo, "r3", "05", [_finding()])
        assert ldg.distinct_runs(repo) == 3
        assert ldg.in_baseline(repo, 3) is False

    def test_same_run_many_findings_is_still_one_run(self, repo):
        ldg.seed(repo)
        ldg.append(repo, "r1", "05", [_finding(title=str(i)) for i in range(9)])
        assert ldg.distinct_runs(repo) == 1


class TestLedgerPromotion:
    """임계값 여섯과 distinct_runs >= 2. 전부 미검증 상속값이다."""

    def _seed_key(self, repo, runs, severity="major", **kw):
        ldg.seed(repo)
        for rid in runs:
            ldg.append(repo, rid, "05", [_finding(severity=severity, **kw)])

    def test_major_needs_three_occurrences(self, repo):
        self._seed_key(repo, ["r1", "r2"])
        assert ldg.stage_promotions(repo)["candidates"] == []
        ldg.append(repo, "r3", "05", [_finding(severity="major")])
        assert len(ldg.stage_promotions(repo)["candidates"]) == 1

    def test_critical_needs_two(self, repo):
        self._seed_key(repo, ["r1"], severity="critical")
        assert ldg.stage_promotions(repo)["candidates"] == []
        ldg.append(repo, "r2", "05", [_finding(severity="critical")])
        assert len(ldg.stage_promotions(repo)["candidates"]) == 1

    def test_one_run_never_promotes_however_many_times(self, repo):
        """한 런에서 같은 지적이 다섯 번 와도 관측은 하나다.

        **신원이 `(run_id, phase, finding_key)` 이므로 라운드 반복이 임계를
        혼자 채우지 못한다** (M30). 예전에는 다섯 줄이 `count=5` 가 되어
        `distinct_runs` 하나에만 기대고 있었다.
        """
        ldg.seed(repo)
        ldg.append(repo, "r1", "05",
                   [_finding(severity="critical") for _ in range(5)])
        got = ldg.stage_promotions(repo)
        assert got["candidates"] == []
        assert got["held"] == [], "누적 자체가 임계에 못 닿는다"

    def test_held_is_still_reachable(self, repo):
        """`held` 가 도달 불가능해지면 두 침묵이 다시 하나가 된다.

        누적은 넘었는데 `distinct_runs` 에서 막힌 상태가 여전히 표현돼야
        "임계가 높다" 와 "런이 모자라다" 가 갈린다. minor 는 (5회, 3런) 이므로
        두 런 × 세 페이즈면 누적 6 · 런 2 로 그 자리에 선다.
        """
        ldg.seed(repo)
        for rid in ("r1", "r2"):
            for phase in ("05", "07", "05-trace"):
                ldg.append(repo, rid, phase, [_finding(severity="minor")])
        got = ldg.stage_promotions(repo)
        assert got["candidates"] == []
        assert len(got["held"]) == 1
        assert got["held"][0]["count"] >= 5
        assert got["held"][0]["distinct_runs"] == 2

    def test_minor_needs_five_over_three_runs(self, repo):
        """페이즈 축이 살아 있어 누적과 런 수가 여전히 다른 것을 센다."""
        ldg.seed(repo)
        for rid in ("r1", "r2"):
            for phase in ("05", "07"):
                ldg.append(repo, rid, phase, [_finding(severity="minor")])
        assert ldg.stage_promotions(repo)["candidates"] == [], "누적 4 · 런 2"
        ldg.append(repo, "r3", "05", [_finding(severity="minor")])
        assert len(ldg.stage_promotions(repo)["candidates"]) == 1

    def test_warn_only_is_excluded_from_the_count(self, repo):
        """baseline 기간의 관측은 승격 근거가 아니다."""
        ldg.seed(repo)
        for rid in ("r1", "r2", "r3"):
            ldg.append(repo, rid, "05",
                       [_finding(severity="critical", resolution="warn_only")])
        assert ldg.stage_promotions(repo)["candidates"] == []

    def test_escalate_only_category_never_promotes(self, repo):
        ldg.seed(repo)
        for rid in ("r1", "r2", "r3"):
            ldg.append(repo, rid, "05",
                       [_finding(category="CONTRACT_DEFECT", severity="critical")])
        assert ldg.stage_promotions(repo)["candidates"] == []

    def test_candidate_carries_destination_from_taxonomy(self, repo):
        """enforceable 이 어디로 승격할지를 정한다 — 후보가 그것을 들고 나온다."""
        self._seed_key(repo, ["r1", "r2", "r3"], category="NAMING")
        cand = ldg.stage_promotions(repo)["candidates"][0]
        assert cand["enforceable"] == "lint"
        assert cand["distinct_runs"] >= 2
        assert cand["count"] == 3

    def test_prose_promotion_of_machine_enforceable_is_refused(self, repo):
        """기계로 막을 수 있는 규칙의 산문 승격은 exit 8 이다."""
        ldg.seed(repo)
        with pytest.raises(ValueError):
            ldg.check_destination(repo, "NAMING", "prose")
        assert ldg.check_destination(repo, "AUTHZ_MISSING_RULE", "prose") is None


# ---------------------------------------------------------------------------
# K. contract-trace — 계약 ↔ 코드 대조 5종
# ---------------------------------------------------------------------------

import trace_contract as tr  # noqa: E402

CONTRACT = """# 계약: 유사도

## 유닛
- `lib/match.ts · matchTitle(a: string, b: string): number`
  - 정상: 0~1 을 돌려준다

## 진입점
- `POST /api/analyze` → 200

## 오류 어휘
- `MATCH_FAILED` (500)
"""


def _write_contract(repo, text=CONTRACT):
    p = repo / "_workspace" / "contract_x.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def _load(repo):
    return adapters.load(repo)


def _trace(repo, contract_path, **kw):
    config, adapter, _cal = _load(repo)
    return tr.run(repo, config, adapter, contract_path, **kw)


class TestContractTraceMissingImpl:
    """컨테이너명 + 심볼명 **쌍**으로 본다. 심볼명만 보면 거짓 통과한다."""

    def test_present_symbol_produces_no_finding(self, repo):
        got = _trace(repo, _write_contract(repo))
        assert [f for f in got["findings"] if f["code"] == "missing_impl"] == []

    def test_absent_symbol_is_critical(self, repo):
        (repo / "src" / "lib" / "match.ts").write_text(
            "export function 다른것(): number { return 0 }\n", encoding="utf-8")
        got = _trace(repo, _write_contract(repo))
        miss = [f for f in got["findings"] if f["code"] == "missing_impl"]
        assert len(miss) == 1
        assert miss[0]["severity"] == "critical"
        assert miss[0]["target_role"] == "impl"      # primary_role

    def test_same_name_in_another_file_does_not_pass(self, repo):
        """이것이 컨테이너 쌍 검색의 존재 이유다."""
        (repo / "src" / "lib" / "match.ts").write_text("export const x = 1\n",
                                                       encoding="utf-8")
        (repo / "src" / "lib" / "다른.ts").write_text(
            "export function matchTitle(): number { return 0 }\n", encoding="utf-8")
        got = _trace(repo, _write_contract(repo))
        assert [f["code"] for f in got["findings"]].count("missing_impl") == 1

    def test_unresolvable_container_falls_to_unknown_not_pass(self, repo):
        """컨테이너를 못 찾으면 통과가 아니라 unknown 으로 낙하한다."""
        text = CONTRACT.replace("lib/match.ts", "lib/없는파일.ts")
        got = _trace(repo, _write_contract(repo, text))
        miss = [f for f in got["findings"] if f["code"] == "missing_impl"]
        assert len(miss) == 1
        assert miss[0]["container_resolved"] is False


class TestContractTraceErrorsAndEntrypoints:

    def test_missing_error_symbol_is_critical(self, repo):
        got = _trace(repo, _write_contract(repo))
        errs = [f for f in got["findings"] if f["code"] == "missing_error_symbol"]
        assert len(errs) == 1 and errs[0]["severity"] == "critical"

    def test_present_error_symbol_is_clean(self, repo):
        (repo / "src" / "lib" / "errors.ts").write_text(
            "export const MATCH_FAILED = 'MATCH_FAILED'\n", encoding="utf-8")
        got = _trace(repo, _write_contract(repo))
        assert [f for f in got["findings"] if f["code"] == "missing_error_symbol"] == []

    def test_missing_entrypoint_is_critical(self, repo):
        got = _trace(repo, _write_contract(repo))
        eps = [f for f in got["findings"] if f["code"] == "missing_entrypoint"]
        assert len(eps) == 1 and eps[0]["severity"] == "critical"

    def test_present_entrypoint_is_clean(self, repo):
        d = repo / "src" / "app" / "api" / "analyze"
        d.mkdir(parents=True)
        (d / "route.ts").write_text("export async function POST() {}\n",
                                    encoding="utf-8")
        got = _trace(repo, _write_contract(repo))
        assert [f for f in got["findings"] if f["code"] == "missing_entrypoint"] == []

    def test_no_resolver_skips_only_that_check(self, repo):
        """스킵을 통과로 적지 않는다. 나머지 4종은 수행한다."""
        config, adapter, _cal = _load(repo)
        adapter = dict(adapter)
        adapter.pop("entrypoint_resolver", None)
        got = tr.run(repo, config, adapter, _write_contract(repo))
        assert got["entrypoint_resolver"] == "none"
        assert "missing_entrypoint" in got["skipped"]
        assert [f for f in got["findings"] if f["code"] == "missing_entrypoint"] == []
        # 오류 어휘 검사는 그대로 돌아야 한다.
        assert any(f["code"] == "missing_error_symbol" for f in got["findings"])
        assert len(got["checks_run"]) == 4


class TestUntestedEntrypointLink:
    """진입점 폴백은 **그 유닛과 연결된** 진입점만 본다 (G-2).

    `_entrypoint_referenced(unit, ...)` 가 `unit` 을 안 써서, 아무 진입점
    경로 하나가 테스트 blob 에 있으면 **모든 유닛**의 지적이 억제됐다.
    사실상 이 검사가 꺼져 있었고, §E6 의 baseline 3런은 그동안 발화할 수
    없는 검사를 재고 있었다.
    """

    CONTRACT = """# 계약: x

## 유닛
- `lib/alpha.ts · doAlpha(x: string): void`
- `lib/beta.ts · doBeta(x: string): void`

## 진입점
- `POST /api/alpha` → 201
"""

    def _repo(self, repo):
        (repo / "src" / "lib").mkdir(parents=True, exist_ok=True)
        (repo / "src" / "lib" / "alpha.ts").write_text(
            "export function doAlpha(x: string) {}\n", encoding="utf-8")
        (repo / "src" / "lib" / "beta.ts").write_text(
            "export function doBeta(x: string) {}\n", encoding="utf-8")
        d = repo / "src" / "app" / "api" / "alpha"
        d.mkdir(parents=True, exist_ok=True)
        (d / "route.ts").write_text(
            "import { doAlpha } from '../../../lib/alpha';\n"
            "export async function POST() { doAlpha('x'); }\n", encoding="utf-8")
        t = repo / "src" / "lib" / "alpha.test.ts"
        # 진입점 경로만 언급하고 어느 심볼도 부르지 않는다.
        t.write_text("it('routes', () => { fetch('/api/alpha'); });\n",
                     encoding="utf-8")

    def test_한_진입점이_다른_유닛의_지적을_덮지_않는다(self, repo):
        self._repo(repo)
        got = _trace(repo, _write_contract(repo, self.CONTRACT), changed=[])
        untested = [f for f in got["findings"]
                    if f["code"] == "untested_contract_item"]
        symbols = {f.get("symbol") for f in untested}
        assert "doBeta" in symbols, \
            "진입점 하나가 blob 에 있다고 모든 유닛이 커버로 처리되면 안 된다"

    def test_연결을_못_풀면_evidence_에_적는다(self, repo):
        self._repo(repo)
        got = _trace(repo, _write_contract(repo, self.CONTRACT), changed=[])
        untested = [f for f in got["findings"]
                    if f["code"] == "untested_contract_item"]
        assert untested, "억제가 침묵으로 일어나면 안 된다"
        assert all(f.get("evidence") for f in untested)


class TestScopeSelectorWidth:
    """`scoped` 가 통합 테스트를 고르는가 (M28).

    `_tests_for_source` 가 소스의 stem 과 **같은 stem** 인 테스트만 골라,
    이름이 다른 통합 테스트는 수리 루프에서 한 번도 안 돌고 `full` 이
    뒤에서 잡았다.
    """

    CONTRACT = """# 계약: x

## 유닛
- `lib/match.ts · matchBooks(x: string): void`
"""

    LONE = """# 계약: x

## 유닛
- `lib/lone.ts · doLone(x: string): void`
"""

    def _select(self, repo, text):
        # `list_files` 는 추적 파일만 본다 — 새로 쓴 것을 인덱스에 올린다.
        _git(repo, "add", "-A")
        config, adapter, _c = _load(repo)
        return contract_mod.test_selectors(
            repo, config, adapter, contract_mod.parse(text, config))

    def _repo(self, repo):
        (repo / "src" / "lib").mkdir(parents=True, exist_ok=True)
        (repo / "src" / "lib" / "match.ts").write_text(
            "export function matchBooks(x: string) {}\n", encoding="utf-8")
        (repo / "src" / "lib" / "match.test.ts").write_text(
            "import { matchBooks } from './match';\n", encoding="utf-8")
        (repo / "src" / "lib" / "edge-cases.test.ts").write_text(
            "import { matchBooks } from './match';\n"
            "it('edge', () => matchBooks('x'));\n", encoding="utf-8")
        (repo / "src" / "lib" / "unrelated.test.ts").write_text(
            "it('nope', () => {});\n", encoding="utf-8")

    def test_통합_테스트가_스코프에_들어온다(self, repo):
        self._repo(repo)
        got = self._select(repo, self.CONTRACT)
        assert any("edge-cases" in p for p in got["paths"]), got["paths"]

    def test_무관한_테스트는_들어오지_않는다(self, repo):
        self._repo(repo)
        got = self._select(repo, self.CONTRACT)
        assert not any("unrelated" in p for p in got["paths"]), got["paths"]

    def test_대응_테스트가_없는_소스는_unmatched_에_남는다(self, repo):
        """지금까지 이 경우는 **조용히 0경로를 기여했다.**"""
        (repo / "src" / "lib").mkdir(parents=True, exist_ok=True)
        (repo / "src" / "lib" / "lone.ts").write_text(
            "export function doLone(x: string) {}\n", encoding="utf-8")
        got = self._select(repo, self.LONE)
        assert not any("lone" in p for p in got["paths"]), got["paths"]
        kinds = {u["kind"] for u in got["unmatched"]}
        assert "source" in kinds, got["unmatched"]

    def test_스코프가_전체에_가까우면_퇴화로_드러난다(self, repo):
        """'scoped 라고 부르면서 full 을 도는 것'이 새 자리의 조용한 통과다."""
        (repo / "src" / "lib").mkdir(parents=True, exist_ok=True)
        (repo / "src" / "lib" / "match.ts").write_text(
            "export function matchBooks(x: string) {}\n", encoding="utf-8")
        for t in list((repo / "src").rglob("*.test.*")):
            t.unlink()
        for i in range(3):
            (repo / "src" / "lib" / ("t%d.test.ts" % i)).write_text(
                "import { matchBooks } from './match';\n", encoding="utf-8")
        got = self._select(repo, self.CONTRACT)
        assert got["degenerate"] is True, got
        assert got["selected_ratio"] >= 0.9


class TestContractTraceBaseline:
    """오탐이 잦은 둘은 첫 3런 동안 warn_only 다 (§E6)."""

    def _contract_untested(self, repo):
        (repo / "src" / "lib" / "match.test.ts").write_text("// 아무것도 안 부른다\n",
                                                            encoding="utf-8")
        return _write_contract(repo)

    def test_untested_is_warn_only_inside_baseline(self, repo):
        ldg.seed(repo)
        got = _trace(repo, self._contract_untested(repo))
        f = next(f for f in got["findings"] if f["code"] == "untested_contract_item")
        assert f["resolution"] == "warn_only"

    def test_untested_becomes_a_real_finding_after_baseline(self, repo):
        ldg.seed(repo)
        for rid in ("r1", "r2", "r3"):
            ldg.append(repo, rid, "05", [_finding()])
        got = _trace(repo, self._contract_untested(repo))
        f = next(f for f in got["findings"] if f["code"] == "untested_contract_item")
        assert f["resolution"] != "warn_only"
        assert f["severity"] == "major"
        assert f["target_role"] == "test"

    def test_symbol_referenced_by_test_is_clean(self, repo):
        """심볼 문자열 **또는** 진입점 경로 — 둘 다 실패할 때만 지적한다."""
        ldg.seed(repo)
        got = _trace(repo, _write_contract(repo))   # match.test.ts 가 matchTitle 을 import 한다
        assert [f for f in got["findings"] if f["code"] == "untested_contract_item"] == []

    def test_out_of_contract_is_warn_only_inside_baseline(self, repo):
        ldg.seed(repo)
        (repo / "src" / "lib" / "match.ts").write_text(
            "export function matchTitle(): number { return 0 }\n"
            "export function 계약에없는함수(): void {}\n", encoding="utf-8")
        got = _trace(repo, _write_contract(repo), changed=["src/lib/match.ts"])
        f = next(f for f in got["findings"] if f["code"] == "out_of_contract")
        assert f["resolution"] == "warn_only"

    def test_out_of_contract_only_looks_at_changed_files(self, repo):
        """안 건드린 파일의 기존 심볼을 신규로 세면 온 리포가 지적이 된다."""
        (repo / "src" / "lib" / "기존.ts").write_text(
            "export function 아주오래된함수(): void {}\n", encoding="utf-8")
        got = _trace(repo, _write_contract(repo), changed=[])
        assert [f for f in got["findings"] if f["code"] == "out_of_contract"] == []


class TestContractTraceNoContract:

    def test_no_contract_mode_is_recorded_not_passed(self, repo):
        config, adapter, _cal = _load(repo)
        got = tr.run(repo, config, adapter, None, no_contract=True)
        assert got["status"] == "skipped_no_contract"
        assert got["findings"] == []
        assert got["checks_run"] == []


class TestContractTraceCli:

    def test_cli_emits_a_single_envelope_and_writes_the_file(self, repo, request_file):
        ldg.seed(repo)
        _write_contract(repo)
        init = cli.run_init(repo, "x", request_file)
        run_id = init["run_id"]
        env = cli.run_contract_trace(repo, contract="_workspace/contract_x.md",
                                     run_id=run_id)
        assert env["cmd"] == "contract-trace"
        assert env["exit"] in (0, 8)
        out = repo / "_workspace" / "runs" / run_id / "05_trace.json"
        assert out.exists()
        assert json.loads(out.read_text(encoding="utf-8"))["checks_run"]

    def test_cli_reports_utf8_without_escaping(self, repo, request_file):
        ldg.seed(repo)
        _write_contract(repo, CONTRACT.replace("matchTitle", "제목맞추기"))
        init = cli.run_init(repo, "x", request_file)
        run_id = init["run_id"]
        cli.run_contract_trace(repo, contract="_workspace/contract_x.md",
                               run_id=run_id)
        raw = (repo / "_workspace" / "runs" / run_id / "05_trace.json").read_text(
            encoding="utf-8")
        assert "제목맞추기" in raw


# ---------------------------------------------------------------------------
# L. precheck — 05 의 첫 검사. 무료이고, 뒤에서 되돌릴 일을 먼저 잡는다
# ---------------------------------------------------------------------------

import precheck as pc  # noqa: E402


def _branch(repo, name):
    _git(repo, "checkout", "-q", "-b", name)


def _bulk_change(repo, files, lines=1):
    for i in range(files):
        p = repo / "src" / "lib" / ("f%d.ts" % i)
        p.write_text("\n".join("export const v%d_%d = %d" % (i, j, j)
                               for j in range(lines)) + "\n", encoding="utf-8")


class TestPrecheckBudget:
    """예산 초과는 exit 9 다 — **자동 분할하지 않는다.** 범위 판단은 사람의 것이다."""

    def test_clean_small_change_passes(self, repo):
        _branch(repo, "feat-x")
        _bulk_change(repo, 1)
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 0, got["checks"]

    def test_too_many_files_is_exit_9(self, repo):
        _branch(repo, "feat-x")
        _bulk_change(repo, 12)          # budget.files_max 는 10 이다
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 9
        assert any(c["name"] == "예산" and not c["ok"] for c in got["checks"])

    def test_too_many_lines_is_exit_9(self, repo):
        _branch(repo, "feat-x")
        _bulk_change(repo, 1, lines=500)   # budget.lines_max 는 400 이다
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 9

    def test_untracked_file_counts_toward_the_budget(self, repo):
        """git diff 는 새 파일을 못 본다. 안 세면 예산이 사실보다 작게 잡힌다."""
        _branch(repo, "feat-x")
        _bulk_change(repo, 12)
        got = pc.run(repo, scope="pr")
        assert got["budget"]["files"] >= 12


class TestPrecheckBranch:

    def test_protected_branch_is_refused(self, repo):
        _bulk_change(repo, 1)           # main 위다
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 9
        assert any("보호" in c["message"] for c in got["checks"] if not c["ok"])

    def test_branch_pattern_mismatch_is_refused(self, repo):
        _branch(repo, "wip/아무거나")
        _bulk_change(repo, 1)
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 9
        assert any(c["name"] == "브랜치" and not c["ok"] for c in got["checks"])


class TestPrecheckInfra:
    """인프라 실패는 정책 실패와 다르다 — **카운터를 소모하지 않는다** (§E9)."""

    def test_env_probe_fires_only_when_the_path_is_touched(self, repo, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        _branch(repo, "feat-x")
        _bulk_change(repo, 1)           # services/ 를 안 건드렸다
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 0

    def test_env_probe_failure_is_exit_10(self, repo, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        _branch(repo, "feat-x")
        p = repo / "src" / "services"
        p.mkdir(parents=True)
        (p / "anthropic.ts").write_text("export const a = 1\n", encoding="utf-8")
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 10
        assert got["classification"] == "infra"
        assert got["counter_consumed"] is False

    def test_present_env_probe_passes(self, repo, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-테스트")
        _branch(repo, "feat-x")
        p = repo / "src" / "services"
        p.mkdir(parents=True)
        (p / "anthropic.ts").write_text("export const a = 1\n", encoding="utf-8")
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 0

    def test_secret_value_never_appears_in_the_report(self, repo, monkeypatch):
        """precheck 결과는 원장·보고서로 간다. 값이 실리면 리포로 샌다."""
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-비밀값-12345")
        _branch(repo, "feat-x")
        p = repo / "src" / "services"
        p.mkdir(parents=True)
        (p / "anthropic.ts").write_text("export const a = 1\n", encoding="utf-8")
        got = pc.run(repo, scope="pr")
        assert "sk-비밀값-12345" not in json.dumps(got, ensure_ascii=False)


class TestPrecheckCli:

    def test_cli_emits_one_envelope(self, repo, request_file):
        _branch(repo, "feat-x")
        _bulk_change(repo, 1)
        cli.run_init(repo, "x", request_file)
        env = cli.run_precheck(repo, scope="pr")
        assert env["cmd"] == "precheck"
        assert env["exit"] in (0, 9, 10)

    def test_cli_runs_without_a_run(self, repo):
        """05 진입 전에도 부를 수 있어야 한다 — 무료 검사의 요점이다."""
        _branch(repo, "feat-x")
        _bulk_change(repo, 1)
        env = cli.run_precheck(repo, scope="pr")
        assert env["exit"] == 0


# ---------------------------------------------------------------------------
# M. 리뷰어 라우팅 — 결정론. when glob 이 정하고 우선순위는 배열 순서다
# ---------------------------------------------------------------------------

import review as rv  # noqa: E402


def _config(repo):
    return harness._read_json(repo / harness.CONFIG_REL)


class TestReviewerRouting:

    def test_api_change_wakes_the_security_reviewer(self, repo):
        got = rv.route(_config(repo), ["src/app/api/analyze/route.ts"], "normal")
        assert "sec" in [r["code"] for r in got["reviewers"]]

    def test_priority_order_is_array_order(self, repo):
        got = rv.route(_config(repo),
                       ["src/lib/schemas.ts", "src/app/api/x/route.ts",
                        "src/lib/a.ts"], "normal")
        codes = [r["code"] for r in got["reviewers"]]
        assert codes == sorted(codes, key=lambda c: _priority(repo, c))

    def test_small_profile_takes_only_the_top_one(self, repo):
        got = rv.route(_config(repo),
                       ["src/lib/schemas.ts", "src/app/api/x/route.ts"], "small")
        assert len(got["reviewers"]) == 1
        assert got["capped"] is True

    def test_normal_profile_respects_the_cap(self, repo):
        changed = ["src/lib/schemas.ts", "src/app/api/x/route.ts",
                   "src/lib/a.ts", "src/lib/a.test.ts"]
        got = rv.route(_config(repo), changed, "normal")
        assert len(got["reviewers"]) <= 3

    def test_dropped_reviewers_are_named_not_silently_lost(self, repo):
        """상한에 걸려 빠진 리뷰어가 누구인지 드러나야 한다."""
        changed = ["src/lib/schemas.ts", "src/app/api/x/route.ts",
                   "src/lib/a.ts", "src/lib/a.test.ts"]
        got = rv.route(_config(repo), changed, "normal")
        assert got["dropped"], "상한으로 빠진 리뷰어가 이름으로 남아야 한다"

    def test_docs_reviewer_only_when_no_source_change(self, repo):
        with_src = rv.route(_config(repo), ["docs/x.md", "src/lib/a.ts"], "normal")
        assert "docs" not in [r["code"] for r in with_src["reviewers"]]
        docs_only = rv.route(_config(repo), ["docs/x.md"], "normal")
        assert "docs" in [r["code"] for r in docs_only["reviewers"]]

    def test_no_match_yields_zero_reviewers_and_that_is_a_failed_review(self, repo):
        """계획된 리뷰어가 0개면 review05.status 는 failed 다 (§E1)."""
        got = rv.route(_config(repo), ["아무데도/안걸리는.txt"], "normal")
        assert got["reviewers"] == []
        assert rv.status(planned=0, ok=0) == "failed"


class TestReviewMode:
    """작은 diff 는 통합 모드다 — 같은 diff 를 여러 번 보내지 않는다."""

    def test_small_diff_is_merged_mode(self, repo):
        assert rv.mode(_config(repo), diff_lines=20) == "merged"

    def test_large_diff_is_fanout(self, repo):
        assert rv.mode(_config(repo), diff_lines=900) == "fanout"


class TestReviewerIsolation:
    """작성자는 리뷰어가 될 수 없다. 자기 글을 리뷰한 것은 독립 관측이 아니다."""

    def test_author_agent_as_reviewer_is_rejected(self, repo):
        cfg = _config(repo)
        cfg["reviewers"] = [{"code": "x", "skill": "impl-writer",
                             "priority": 1, "when": ["src/**"]}]
        errs = rv.validate(repo, cfg)
        assert any("격리" in e or "작성자" in e for e in errs)

    def test_missing_skill_file_is_caught_before_launch(self, repo):
        cfg = _config(repo)
        cfg["reviewers"] = [{"code": "x", "skill": "없는-리뷰어",
                             "priority": 1, "when": ["src/**"]}]
        errs = rv.validate(repo, cfg)
        assert any("없는-리뷰어" in e for e in errs)

    def test_duplicate_code_is_rejected(self, repo):
        cfg = _config(repo)
        cfg["reviewers"] = [
            {"code": "a", "skill": "architecture-reviewer", "priority": 1,
             "when": ["src/**"]},
            {"code": "a", "skill": "security-reviewer", "priority": 2,
             "when": ["src/**"]}]
        assert any("code" in e for e in rv.validate(repo, cfg))

    def test_real_config_passes_validation(self, repo):
        """실물이 자기 검사를 통과해야 한다."""
        assert rv.validate(repo, _config(repo)) == []


def _priority(repo, code):
    for r in _config(repo).get("reviewers") or []:
        if r["code"] == code:
            return r["priority"]
    raise AssertionError(code)


# ---------------------------------------------------------------------------
# N. 05 제출 판정 — 01 의 검사 + 리뷰어가 여럿이라 생기는 넷
# ---------------------------------------------------------------------------

RAW_ONE = """## major

`route.ts` 가 인가를 건너뛴다.
"""

RAW_TWO = """## critical

첫째.

## minor

둘째.
"""


def _sub(reviewer="arch", by_checklist=None, **kw):
    payload = {"reviewer": reviewer, "round": 1, "status": "ok",
               "by_checklist": by_checklist if by_checklist is not None else {
                   "의존 방향": [{"id": "F-1", "category": "AUTHZ_MISSING_RULE",
                              "severity": "major", "target_role": "impl",
                              "title": "인가 규칙이 빠졌다", "path": "x.ts",
                              "quote": "인가를 건너뛴다"}],
                   "네이밍": []},
               "resolved_from_previous": [], "need_more_context": []}
    payload.update(kw)
    return payload


class TestReview05Structure:

    def test_missing_by_checklist_is_rejected(self, repo):
        """0건인 체크리스트도 명시해야 한다 — 누락과 '보고 아무것도 없었다'는 다르다."""
        got = rv.check(repo, _config(repo), _sub(by_checklist={}), RAW_ONE, [])
        assert got["exit"] == 8
        assert any("by_checklist" in e for e in got["errors"])

    def test_zero_item_checklist_is_accepted(self, repo):
        got = rv.check(repo, _config(repo), _sub(), RAW_ONE, [])
        assert got["ok"], got["errors"]

    def test_flatten_reads_every_checklist(self, repo):
        payload = _sub(by_checklist={
            "가": [{"id": "F-1", "severity": "major", "title": "하나"}],
            "나": [{"id": "F-2", "severity": "minor", "title": "둘"}]})
        assert len(rv.flatten(payload)) == 2

    def test_heading_count_must_match_findings(self, repo):
        """M20 이 이 검사를 문서화하지 않아 생긴 결함이다. 05 는 리뷰어 수만큼 곱해진다."""
        got = rv.check(repo, _config(repo), _sub(), RAW_TWO, [])
        assert got["exit"] == 8
        assert any("헤딩" in e for e in got["errors"])

    def test_forged_quote_is_rejected(self, repo):
        payload = _sub()
        payload["by_checklist"]["의존 방향"][0]["quote"] = "원문에 없는 인용"
        got = rv.check(repo, _config(repo), payload, RAW_ONE, [])
        assert got["exit"] == 8


class TestReview05Isolation:

    def test_author_agent_submission_is_rejected(self, repo):
        got = rv.check(repo, _config(repo), _sub(reviewer="impl-writer"),
                       RAW_ONE, [])
        assert got["exit"] == 8
        assert any("독립 관측" in e for e in got["errors"])

    def test_unrouted_reviewer_is_rejected(self, repo):
        """라우팅이 부르지 않은 리뷰어의 제출은 받지 않는다."""
        got = rv.check(repo, _config(repo), _sub(reviewer="아무개"), RAW_ONE, [])
        assert got["exit"] == 8


class TestReview05Enforcement:
    """검토 제외 목록의 category 는 드롭하되 **센다.**"""

    def test_excluded_category_is_dropped_and_counted(self, repo):
        payload = _sub(by_checklist={
            "경계": [{"id": "F-1", "category": "BOUNDARY_VIOLATION",
                    "severity": "major", "target_role": "impl",
                    "title": "경계 위반", "quote": "인가를 건너뛴다"}]})
        # 원문에는 리뷰어가 **쓴 만큼** 헤딩이 있다. 드롭은 그 뒤의 일이다.
        got = rv.check(repo, _config(repo), payload, RAW_ONE, [],
                       excluded=["BOUNDARY_VIOLATION"])
        assert got["ok"], got["errors"]
        assert got["dropped_by_enforcement"] == 1
        assert got["findings"] == []
        assert got["dropped_categories"] == ["BOUNDARY_VIOLATION"]

    def test_dropped_findings_do_not_break_the_heading_count(self, repo):
        """드롭은 리뷰어의 잘못이 아니다 — 원문 헤딩은 낸 만큼 있다."""
        payload = _sub(by_checklist={
            "경계": [{"id": "F-1", "category": "BOUNDARY_VIOLATION",
                    "severity": "major", "target_role": "impl",
                    "title": "경계 위반", "quote": "인가를 건너뛴다"}],
            "인가": [{"id": "F-2", "category": "AUTHZ_MISSING_RULE",
                    "severity": "major", "target_role": "impl",
                    "title": "인가 누락", "quote": "인가를 건너뛴다"}]})
        raw = RAW_ONE + "\n" + RAW_ONE      # 헤딩 2개 = findings 2개
        got = rv.check(repo, _config(repo), payload, raw, [],
                       excluded=["BOUNDARY_VIOLATION"])
        assert got["ok"], got["errors"]
        assert len(got["findings"]) == 1
        assert got["dropped_by_enforcement"] == 1
        assert got["dropped_by_enforcement"] == 1


class TestReview05Truncation:

    def test_over_findings_max_keeps_only_blocking(self, repo):
        cfg = _config(repo)
        cfg["review"]["findings_max"] = 2
        items = [{"id": "F-%d" % i, "category": "NAMING",
                  "severity": "minor" if i % 2 else "critical",
                  "target_role": "impl", "title": "제목%d" % i}
                 for i in range(6)]
        raw = "\n".join("## %s\n\n본문\n" % it["severity"] for it in items)
        got = rv.check(repo, cfg, _sub(by_checklist={"전부": items}), raw, [])
        assert got["truncated"] is True
        assert all(f["severity"] in ("critical", "major") for f in got["findings"])


class TestReview05Merge:
    """2인 이상이 지적한 항목은 severity 가 한 단계 오른다."""

    def _f(self, title="같은 지적", severity="major"):
        return {"category": "NAMING", "target_role": "impl",
                "title": title, "severity": severity}

    def test_two_reviewers_raise_severity(self, repo):
        merged = rv.merge([
            {"reviewer": "arch", "findings": [self._f()]},
            {"reviewer": "sec", "findings": [self._f()]}])
        assert len(merged) == 1
        assert merged[0]["severity"] == "critical"
        assert merged[0]["severity_raised_from"] == "major"
        assert sorted(merged[0]["reported_by"]) == ["arch", "sec"]

    def test_one_reviewer_keeps_severity(self, repo):
        merged = rv.merge([{"reviewer": "arch", "findings": [self._f()]}])
        assert merged[0]["severity"] == "major"
        assert "severity_raised_from" not in merged[0]

    def test_critical_does_not_overflow(self, repo):
        merged = rv.merge([
            {"reviewer": "arch", "findings": [self._f(severity="critical")]},
            {"reviewer": "sec", "findings": [self._f(severity="critical")]}])
        assert merged[0]["severity"] == "critical"

    def test_same_reviewer_twice_does_not_raise(self, repo):
        """한 리뷰어가 두 번 낸 것은 독립 관측 둘이 아니다."""
        merged = rv.merge([
            {"reviewer": "arch", "findings": [self._f()]},
            {"reviewer": "arch", "findings": [self._f()]}])
        assert merged[0]["severity"] == "major"


class TestReview05Status:
    """findings 개수와 **분리한다** — §E1 이 가장 위험한 구멍이라 부른 것."""

    def test_all_ok(self, repo):
        assert rv.status(planned=3, ok=3) == "ok"

    def test_partial_is_degraded(self, repo):
        assert rv.status(planned=3, ok=1) == "degraded"

    def test_all_failed(self, repo):
        assert rv.status(planned=3, ok=0) == "failed"

    def test_zero_planned_is_failed_not_ok(self, repo):
        """아무도 안 부른 것은 통과가 아니라 미수행이다."""
        assert rv.status(planned=0, ok=0) == "failed"


class TestReview05InlineBudget:

    def test_small_diff_goes_inline(self, repo):
        assert rv.inline_budget(_config(repo), "a\nb\n")["inline"] is True

    def test_huge_diff_falls_back_to_paths(self, repo):
        got = rv.inline_budget(_config(repo), "x" * 40000)
        assert got["inline"] is False
        assert got["fallback"] == "경로 전달"
        assert got["over"], "무엇이 상한을 넘었는지 드러나야 한다"

    def test_hangul_counts_as_bytes_not_characters(self, repo):
        """문자로 세면 UTF-8 페이로드가 상한의 3배까지 통과한다."""
        got = rv.inline_budget(_config(repo), "가" * 9000)
        assert got["bytes"] == 27000
        assert got["inline"] is False


# ---------------------------------------------------------------------------
# O. 05 페이즈 파일과 전이 — FUTURE 는 다음 진입점을 계속 가리켜야 한다
# ---------------------------------------------------------------------------

class TestPhase05File:

    def test_phase_file_loads(self, repo):
        loaded, broken = cli.load_phases(ROOT)
        assert broken == []
        assert "05-code-review" in loaded

    def test_transition_chain_reaches_05(self, repo):
        loaded, _ = cli.load_phases(ROOT)
        assert loaded["04-gate"]["front"]["on_success"] == "05-code-review"

    def test_실물_페이즈에_FUTURE_가_남지_않았다(self, repo):
        """**여덟이 다 섰다.** 다섯 번의 증분 동안 다음 진입점을 가리키던
        그 한 줄이 처음으로 사라진다."""
        findings = cli.lint_phases(ROOT)
        future = [f for f in findings
                  if f["rule"] == "on_success" and f["status"] == "WARN"]
        assert future == [], future

    def test_실물_페이즈가_여덟이고_08_은_done_을_가리킨다(self, repo):
        """**M24.** 08 이 아무것도 안 가리키면 런이 닫히는 자리가 없다."""
        loaded, broken = cli.load_phases(ROOT)
        assert broken == []
        assert sorted(loaded) == ["01-plan", "02-cross-verify", "03-implement",
                                  "04-gate", "05-code-review", "06-pr",
                                  "07-pr-review", "08-report"]
        assert loaded["08-report"]["front"].get("on_success") == st.DONE

    def test_전이_사슬이_01_에서_done_까지_이어진다(self, repo):
        """단언 하나로 그래프 전체를 못박는다."""
        loaded, _ = cli.load_phases(ROOT)
        chain, cur = [], "01-plan"
        while cur in loaded:
            chain.append(cur)
            cur = loaded[cur]["front"].get("on_success")
        assert chain == ["01-plan", "02-cross-verify", "03-implement", "04-gate",
                         "05-code-review", "06-pr", "07-pr-review", "08-report"]
        assert cur == st.DONE

    def test_lint_passes_on_the_real_phases(self, repo):
        bad = [f for f in cli.lint_phases(ROOT) if f["status"] == "FAIL"]
        assert bad == [], bad

    def test_taxonomy_is_no_longer_skipped(self, repo):
        """원장이 생겼으므로 SKIP 이 실제 검사로 바뀌어야 한다."""
        findings = cli.lint_phases(ROOT)
        tax = [f for f in findings if f["rule"] == "taxonomy"]
        assert not any(f["status"] == "SKIP" for f in tax)

    def test_submission_format_documents_the_raw_md_rule(self, repo):
        """M20 의 회귀 — 페이즈 파일이 그 규칙을 실제로 적고 있는가."""
        loaded, _ = cli.load_phases(ROOT)
        body = loaded["05-code-review"]["body"]
        section = cli._section(body, "## 제출 형식")
        assert ".raw.md" in section
        assert "헤딩" in section

    def test_review_repair_counter_is_known(self, repo):
        assert "review_repair" in st.COUNTERS


# ---------------------------------------------------------------------------
# P. 05 흐름 — next 가 라우팅을 확정하고 record 가 원장에 쌓는다
# ---------------------------------------------------------------------------

def _enter_05(repo, request_file, phases):
    """04 까지를 상태로 위조하고 05 에 진입시킨다.

    01~04 를 실제로 돌리려면 서브에이전트가 필요하다. 여기서 보려는 것은 05 의
    배선이므로 그 앞은 상태로 세운다 — **다만 계약 파일과 지문은 실물이다.**
    """
    init = cli.run_init(repo, "x", request_file)
    run_id = init["run_id"]
    paths, s = st.load(repo, run_id)
    for pid in ("01-plan", "02-cross-verify", "03-implement", "04-gate"):
        st.set_phase_status(s, pid, "passed")
    s["phase"] = "05-code-review"
    s["contract"] = {"mode": "contract", "present": True}
    st.save(paths, s)

    c = repo / "_workspace" / ("contract_%s.md" % "x")
    c.parent.mkdir(parents=True, exist_ok=True)
    c.write_text(CONTRACT, encoding="utf-8")
    return run_id, paths


def _reviewer_files(paths, code, findings, raw=None):
    j = paths.run_dir / ("05_review_%s.json" % code)
    j.write_text(json.dumps({
        "reviewer": code, "round": 1, "status": "ok",
        "by_checklist": {"전부": findings},
        "resolved_from_previous": [], "need_more_context": []},
        ensure_ascii=False), encoding="utf-8")
    body = raw if raw is not None else "\n".join(
        "## %s\n\n%s\n" % (f["severity"], f.get("quote") or f["title"])
        for f in findings)
    j.with_name(j.name.replace(".json", ".raw.md")).write_text(
        "# 리뷰\n\n" + body, encoding="utf-8")
    return j


class TestPhase05Wiring:

    def test_next_freezes_the_routing(self, repo, request_file, phases):
        run_id, paths = _enter_05(repo, request_file, phases)
        (repo / "src" / "app" / "api" / "x").mkdir(parents=True)
        (repo / "src" / "app" / "api" / "x" / "route.ts").write_text(
            "export async function POST() {}\n", encoding="utf-8")
        env = cli.run_next(repo, run_id)
        _paths, s = st.load(repo, run_id)
        node = s["phases"]["05-code-review"]
        assert node["planned"], "라우팅이 상태에 확정돼야 한다"
        assert "리뷰어 라우팅" in env["render"]

    def test_envelope_names_the_excluded_categories(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, _paths = _enter_05(repo, request_file, phases)
        env = cli.run_next(repo, run_id)
        assert "검토 제외" in env["render"]
        assert "BOUNDARY_VIOLATION" in env["render"]

    def test_zero_reviewers_is_named_as_a_failure_not_silence(self, repo,
                                                              request_file, phases):
        run_id, _paths = _enter_05(repo, request_file, phases)
        env = cli.run_next(repo, run_id)
        _p, s = st.load(repo, run_id)
        if not s["phases"]["05-code-review"]["planned"]:
            assert "failed" in env["render"] or "0개" in env["render"]

    def test_record_before_trace_is_refused(self, repo, request_file, phases):
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        f = _reviewer_files(paths, "arch", [])
        env = cli.run_record(repo, "05", str(f), reviewer="arch", round_=1,
                             run_id=run_id)
        assert env["exit"] == 3
        assert "계약 대조" in env["render"]

    def test_record_without_reviewer_is_refused(self, repo, request_file, phases):
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        env = cli.run_record(repo, "05", str(paths.run_dir / "x.json"),
                             run_id=run_id)
        assert env["exit"] == 2

    def test_missing_raw_md_is_exit_8(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        cli.run_contract_trace(repo, run_id=run_id)
        f = paths.run_dir / "05_review_arch.json"
        f.write_text(json.dumps({"reviewer": "arch", "by_checklist": {"a": []}}),
                     encoding="utf-8")
        env = cli.run_record(repo, "05", str(f), reviewer="arch", run_id=run_id)
        assert env["exit"] == 8
        assert "원문" in env["render"]


class TestReview05Denominator:
    """`review05.status` 의 분모는 **라우팅**이지 제출자가 아니다 (G-4).

    지금까지 `planned or [reviewer]` / `or sorted(slot)` 가 분모를 분자에서
    유도해 비율이 구조적으로 항상 1 이었다. `degraded` 도 `failed` 도 도달
    불가능한 값이었고, 페이즈 파일 232·233행과 `_review_render` 는 그 값이
    난다고 **선언만** 하고 있었다.
    """

    def _planned(self, repo, run_id, codes):
        """라우팅 결과를 강제한다 — glob 우연에 기대지 않는다."""
        paths, s = st.load(repo, run_id)
        node = s.setdefault("phases", {}).setdefault("05-code-review", {})
        node["planned"] = list(codes)
        node.setdefault("routing", {"reviewers": [{"code": c} for c in codes],
                                    "dropped": [], "capped": False})
        node.setdefault("mode", "fanout")
        st.save(paths, s)
        return paths

    def test_zero_routing_is_written_to_state_not_only_rendered(
            self, repo, request_file, phases):
        """산문이 기계 사실을 참칭하지 않는다."""
        run_id, _paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        _p, s = st.load(repo, run_id)
        if s["phases"]["05-code-review"]["planned"]:
            pytest.skip("이 리포 상태에서는 라우팅이 비지 않았다")
        assert s["review05"]["status"] == "failed"
        assert s["review05"]["reviewers_planned"] == 0
        assert "review05:failed" in (s.get("gaps") or [])
        assert s["grade"] != "PASS"

    def test_empty_planned_is_not_replaced_by_the_submitter(
            self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        cli.run_contract_trace(repo, run_id=run_id)
        self._planned(repo, run_id, [])
        f = _reviewer_files(paths, "arch", [])
        env = cli.run_record(repo, "05", str(f), reviewer="arch", round_=1,
                             run_id=run_id)
        _p, s = st.load(repo, run_id)
        assert (s.get("review05") or {}).get("status") != "ok", env["render"]

    def test_unplanned_reviewer_submission_is_refused(self, repo, request_file,
                                                      phases):
        """라우팅이 부르지 않은 리뷰어의 제출은 받지 않는다 (페이즈 파일 164행)."""
        ldg.seed(repo)
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        cli.run_contract_trace(repo, run_id=run_id)
        self._planned(repo, run_id, ["arch"])
        f = _reviewer_files(paths, "sec", [])
        env = cli.run_record(repo, "05", str(f), reviewer="sec", round_=1,
                             run_id=run_id)
        assert env["exit"] == 8
        assert "라우팅" in env["render"] or "계획" in env["render"]

    def test_record_before_next_is_refused(self, repo, request_file, phases):
        """`planned` 의 부재(05 진입 안 함)와 빈 리스트(0명 라우팅)는 다르다."""
        ldg.seed(repo)
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_contract_trace(repo, run_id=run_id)
        f = _reviewer_files(paths, "arch", [])
        env = cli.run_record(repo, "05", str(f), reviewer="arch", round_=1,
                             run_id=run_id)
        assert env["exit"] == 3
        assert "next" in env["render"]


class TestReview05Failure:
    """리뷰어 실패는 오류가 아니라 **데이터**다 — 등급으로 드러나야 한다."""

    def _ready(self, repo, request_file, phases, codes):
        ldg.seed(repo)
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        cli.run_contract_trace(repo, run_id=run_id)
        paths, s = st.load(repo, run_id)
        node = s["phases"]["05-code-review"]
        node["planned"] = list(codes)
        node["routing"] = {"reviewers": [{"code": c} for c in codes],
                           "dropped": [], "capped": False}
        node["mode"] = "fanout"
        st.save(paths, s)
        return run_id, paths

    def test_second_rejection_records_the_reviewer_as_failed(
            self, repo, request_file, phases):
        """재제출 1회 → 2회 실패 시 스킵 + degrade (페이즈 파일 234행)."""
        run_id, paths = self._ready(repo, request_file, phases, ["arch", "test"])
        bad = paths.run_dir / "05_review_arch.json"
        bad.write_text(json.dumps({"reviewer": "arch", "by_checklist": {"a": [
            {"id": "F-1", "severity": "major", "title": "x",
             "category": "NAMING", "target_role": "impl",
             "quote": "원문에없는문장이다"}]}},
            ensure_ascii=False), encoding="utf-8")
        bad.with_name("05_review_arch.raw.md").write_text(
            "# 리뷰\n\n아무 말\n", encoding="utf-8")
        first = cli.run_record(repo, "05", str(bad), reviewer="arch", round_=1,
                               run_id=run_id)
        assert first["exit"] == 8, "1회차는 재제출을 요구한다"
        second = cli.run_record(repo, "05", str(bad), reviewer="arch", round_=1,
                                run_id=run_id)
        assert second["exit"] != 8, "2회차는 실패로 확정하고 흐름을 잇는다"
        _p, s = st.load(repo, run_id)
        slot = s["phases"]["05-code-review"]["rounds"]["1"]
        assert slot["arch"]["keys"] is None
        assert slot["arch"].get("reason")

    def test_one_failed_reviewer_is_degraded(self, repo, request_file, phases):
        run_id, paths = self._ready(repo, request_file, phases, ["arch", "test"])
        env = cli.run_record(repo, "05", None, reviewer="arch", round_=1,
                             run_id=run_id, failed=True, reason="호출이 타임아웃")
        assert env["exit"] == 0, env["render"]
        ok = _reviewer_files(paths, "test", [])
        cli.run_record(repo, "05", str(ok), reviewer="test", round_=1,
                       run_id=run_id)
        _p, s = st.load(repo, run_id)
        assert s["review05"]["status"] == "degraded"
        assert s["review05"]["reviewers_planned"] == 2
        assert s["review05"]["reviewers_ok"] == 1
        assert s["grade"] != "PASS"

    def test_all_failed_is_failed(self, repo, request_file, phases):
        run_id, _paths = self._ready(repo, request_file, phases, ["arch"])
        cli.run_record(repo, "05", None, reviewer="arch", round_=1,
                       run_id=run_id, failed=True, reason="호출 실패")
        _p, s = st.load(repo, run_id)
        assert s["review05"]["status"] == "failed"
        assert "review05:failed" in (s.get("gaps") or [])

    def test_failure_report_is_refused_when_a_valid_submission_exists(
            self, repo, request_file, phases):
        """이 verb 자체가 자진 신고다 — 확인 가능한 만큼만 받는다 (불변식 8)."""
        run_id, paths = self._ready(repo, request_file, phases, ["arch"])
        _reviewer_files(paths, "arch", [])
        env = cli.run_record(repo, "05", None, reviewer="arch", round_=1,
                             run_id=run_id, failed=True, reason="안 돌았다")
        assert env["exit"] == 8
        assert "제출" in env["render"]


class TestReview05DeltaRound:
    """델타 재리뷰는 1명이고(M27), 그 1명이 G-4 를 되돌리지 않는다."""

    def _ready(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        cli.run_contract_trace(repo, run_id=run_id)
        paths, s = st.load(repo, run_id)
        node = s["phases"]["05-code-review"]
        node["planned"] = ["arch", "test"]
        node["routing"] = {"reviewers": [{"code": "arch"}, {"code": "test"}],
                           "dropped": [], "capped": False}
        node["mode"] = "fanout"
        return run_id, paths, s, node

    def test_worst_status_is_a_pure_function(self, repo):
        assert rv.worst_status(["ok", "degraded"]) == "degraded"
        assert rv.worst_status(["degraded", "ok"]) == "degraded"
        assert rv.worst_status(["failed", "ok", "degraded"]) == "failed"
        assert rv.worst_status(["ok", "ok"]) == "ok"
        assert rv.worst_status([]) == "failed", "라운드가 없는 것은 미수행이다"

    def test_delta_round_waits_for_one_reviewer(self, repo, request_file, phases):
        run_id, paths, s, node = self._ready(repo, request_file, phases)
        node["rounds_planned"] = {"2": ["arch"]}
        st.save(paths, s)
        f = _reviewer_files(paths, "arch", [])
        env = cli.run_record(repo, "05", str(f), reviewer="arch", round_=2,
                             run_id=run_id)
        waiting = (env.get("data") or {}).get("waiting_for") or []
        assert "test" not in waiting, "델타 라운드는 전원을 기다리지 않는다"

    def test_a_clean_delta_round_does_not_heal_the_status(
            self, repo, request_file, phases):
        """G-4 재개봉 방지 — status 는 런 안에서 단조 비개선이다."""
        run_id, paths, s, node = self._ready(repo, request_file, phases)
        node["round_status"] = {"1": "degraded"}
        node["rounds_planned"] = {"2": ["arch"]}
        s["review05"] = {"status": "degraded", "reviewers_planned": 2,
                         "reviewers_ok": 1, "mode": "fanout", "major": 0,
                         "need_more_context": [], "dropped_by_enforcement": 0,
                         "truncated": False}
        st.save(paths, s)
        f = _reviewer_files(paths, "arch", [])
        cli.run_record(repo, "05", str(f), reviewer="arch", round_=2,
                       run_id=run_id)
        _p, s = st.load(repo, run_id)
        assert s["review05"]["status"] == "degraded", \
            "깨끗한 델타 라운드가 앞선 결손을 지우면 E1 가드가 옆문으로 다시 열린다"


class TestPhase05Ledgering:

    def _prepare(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_05(repo, request_file, phases)
        (repo / "src" / "app").mkdir(parents=True, exist_ok=True)
        (repo / "src" / "app" / "page.tsx").write_text(
            "export default function P() { return null }\n", encoding="utf-8")
        cli.run_next(repo, run_id)
        cli.run_contract_trace(repo, run_id=run_id)
        _p, s = st.load(repo, run_id)
        s["phases"]["05-code-review"]["planned"] = ["arch"]
        st.save(_p, s)
        return run_id, paths

    def test_clean_review_advances_and_writes_the_three_files(self, repo,
                                                              request_file, phases):
        run_id, paths = self._prepare(repo, request_file, phases)
        f = _reviewer_files(paths, "arch", [])
        env = cli.run_record(repo, "05", str(f), reviewer="arch", round_=1,
                             run_id=run_id)
        assert env["exit"] in (0, 11), env["render"]
        for name in ("05_trace.json", "05_review.json", "05_promo_staged.json"):
            assert (paths.run_dir / name).exists(), name

    def test_review05_status_is_recorded_separately_from_findings(
            self, repo, request_file, phases):
        run_id, paths = self._prepare(repo, request_file, phases)
        f = _reviewer_files(paths, "arch", [])
        cli.run_record(repo, "05", str(f), reviewer="arch", round_=1, run_id=run_id)
        _p, s = st.load(repo, run_id)
        assert s["review05"]["status"] == "ok"
        assert s["review05"]["reviewers_planned"] == 1

    def test_major_finding_blocks_with_exit_4(self, repo, request_file, phases):
        run_id, paths = self._prepare(repo, request_file, phases)
        f = _reviewer_files(paths, "arch", [
            {"id": "F-1", "category": "AUTHZ_MISSING_RULE", "severity": "major",
             "target_role": "impl", "title": "인가 누락", "quote": "인가 누락"}])
        env = cli.run_record(repo, "05", str(f), reviewer="arch", round_=1,
                             run_id=run_id)
        assert env["exit"] == 4
        assert "수리가 필요하다" in env["render"]
        assert "Minor 는 고치지 않는다" in env["render"]

    def test_minor_finding_does_not_block(self, repo, request_file, phases):
        run_id, paths = self._prepare(repo, request_file, phases)
        f = _reviewer_files(paths, "arch", [
            {"id": "F-1", "category": "TX_BOUNDARY", "severity": "minor",
             "target_role": "impl", "title": "이름", "quote": "이름"}])
        env = cli.run_record(repo, "05", str(f), reviewer="arch", round_=1,
                             run_id=run_id)
        assert env["exit"] in (0, 11), env["render"]

    def test_findings_reach_the_ledger(self, repo, request_file, phases):
        run_id, paths = self._prepare(repo, request_file, phases)
        f = _reviewer_files(paths, "arch", [
            {"id": "F-1", "category": "TX_BOUNDARY", "severity": "minor",
             "target_role": "impl", "title": "이름", "quote": "이름"}])
        cli.run_record(repo, "05", str(f), reviewer="arch", round_=1, run_id=run_id)
        rows = ldg.read_all(repo)
        assert any(r["title_norm"] == "이름" for r in rows)
        assert all(r["run_id"] == run_id for r in rows)

    def test_trace_findings_reach_the_ledger_too(self, repo, request_file, phases):
        """기계가 찾은 것과 리뷰어가 찾은 것이 같은 눈금 위에 있어야 한다."""
        run_id, paths = self._prepare(repo, request_file, phases)
        f = _reviewer_files(paths, "arch", [])
        cli.run_record(repo, "05", str(f), reviewer="arch", round_=1, run_id=run_id)
        rows = ldg.read_all(repo)
        assert any(r["source"] == "contract-trace" for r in rows), rows

    def test_unknown_category_from_a_reviewer_is_refused(self, repo,
                                                         request_file, phases):
        run_id, paths = self._prepare(repo, request_file, phases)
        f = _reviewer_files(paths, "arch", [
            {"id": "F-1", "category": "내가지어낸코드", "severity": "minor",
             "target_role": "impl", "title": "x", "quote": "x"}])
        env = cli.run_record(repo, "05", str(f), reviewer="arch", round_=1,
                             run_id=run_id)
        assert env["exit"] == 8


# ---------------------------------------------------------------------------
# J. 등급의 단일 출처 — 06~08 이 얹히기 전에 먼저 세운다
# ---------------------------------------------------------------------------


class TestPhase05Repaired:
    """수리된 지적은 원장에서 `repaired` 다 (M29).

    "닫혔다" 를 모델이 신고하지 않는다 — `review.check` 의 단조성 검사가 이미
    검증한 `closed` 에서만 유도한다 (불변식 8).
    """

    def _ready(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_05(repo, request_file, phases)
        cli.run_next(repo, run_id)
        cli.run_contract_trace(repo, run_id=run_id)
        paths, s = st.load(repo, run_id)
        node = s["phases"]["05-code-review"]
        node["planned"] = ["arch"]
        node["routing"] = {"reviewers": [{"code": "arch"}], "dropped": [],
                           "capped": False}
        node["mode"] = "fanout"
        st.save(paths, s)
        return run_id, paths

    def _finding(self, **kw):
        d = {"id": "F-1", "category": "TX_BOUNDARY", "severity": "major",
             "target_role": "impl", "title": "트랜잭션 경계가 없다",
             "quote": "규약을 벗어난 이름"}
        d.update(kw)
        return d

    def test_다음_라운드에_닫히면_repaired_로_승계된다(self, repo, request_file,
                                                      phases):
        run_id, paths = self._ready(repo, request_file, phases)
        f = self._finding()
        j = _reviewer_files(paths, "arch", [f], raw="## major\n\n규약을 벗어난 이름\n")
        cli.run_record(repo, "05", str(j), reviewer="arch", round_=1,
                       run_id=run_id)
        rows = [r for r in ldg.read_all(repo) if r.get("category") == "TX_BOUNDARY"]
        assert rows, "1라운드가 원장에 쌓았어야 한다"
        key = rows[0]["finding_key"]

        # 2라운드: 그 지적을 해소로 신고한다. 단조성 검사가 이것을 검증한다.
        j2 = paths.run_dir / "05_review_arch_r2.json"
        j2.write_text(json.dumps({
            "reviewer": "arch", "round": 2, "status": "ok",
            "by_checklist": {"전부": []},
            "resolved_from_previous": [{"id": "F-1", "resolved_by": "이름을 고쳤다"}],
            "need_more_context": []}, ensure_ascii=False), encoding="utf-8")
        j2.with_name("05_review_arch_r2.raw.md").write_text(
            "# 리뷰\n\n해소했다\n", encoding="utf-8")
        cli.run_record(repo, "05", str(j2), reviewer="arch", round_=2,
                       run_id=run_id)

        obs = [o for o in ldg.observations(repo) if o["finding_key"] == key]
        assert len(obs) == 1, "라운드마다 한 줄씩 쌓이면 안 된다 (M30)"
        assert obs[0]["resolution"] == "repaired", "닫힌 지적이 deferred 로 남는다 (M29)"

    def test_안_닫힌_것은_deferred_로_남는다(self, repo, request_file, phases):
        run_id, paths = self._ready(repo, request_file, phases)
        f = self._finding(severity="minor")
        j = _reviewer_files(paths, "arch", [f], raw="## minor\n\n규약을 벗어난 이름\n")
        cli.run_record(repo, "05", str(j), reviewer="arch", round_=1,
                       run_id=run_id)
        obs = [o for o in ldg.observations(repo) if o["category"] == "TX_BOUNDARY"]
        assert obs and obs[0]["resolution"] == "deferred"

    def test_repaired_by_를_못_가르면_null_이다(self, repo):
        """지어내지 않는다 — `state.repair` 가 아직 실행기에 없다."""
        ldg.seed(repo)
        ldg.append(repo, "R1", "05", [
            {"category": "TX_BOUNDARY", "severity": "major", "target_role": "impl",
             "title": "x", "resolution": "repaired", "source": "reviewer"}])
        assert ldg.observations(repo)[0]["repaired_by"] is None


class TestGradeSingleSource:
    """등급은 강등만 한다. 그 전에는 나중에 쓰는 쪽이 이겼다."""

    def test_처음_등급은_그대로_설정된다(self):
        s = {}
        assert st.demote(s, "PASS") == "PASS"

    def test_더_나쁜_등급으로만_움직인다(self):
        s = {"grade": "PASS"}
        assert st.demote(s, "PASS_WITH_GAPS") == "PASS_WITH_GAPS"
        assert st.demote(s, "INCOMPLETE") == "INCOMPLETE"

    def test_승격은_거부된다(self):
        """게이트가 05 뒤에 다시 돌아도 PASS_WITH_GAPS 가 PASS 로 되돌아가지 않는다."""
        s = {"grade": "PASS_WITH_GAPS"}
        assert st.demote(s, "PASS") == "PASS_WITH_GAPS"
        s = {"grade": "INCOMPLETE"}
        assert st.demote(s, "PASS_WITH_GAPS") == "INCOMPLETE"

    def test_gap_은_중복없이_쌓인다(self):
        s = {}
        st.demote(s, "PASS_WITH_GAPS", "review05:failed")
        st.demote(s, "PASS_WITH_GAPS", "review05:failed")
        st.demote(s, "PASS_WITH_GAPS", "stage_absent:e2e")
        assert s["gaps"] == ["review05:failed", "stage_absent:e2e"]

    def test_등급이_None_이면_gap_만_쌓고_등급은_안_건드린다(self):
        s = {"grade": "PASS"}
        assert st.demote(s, None, "some_gap") == "PASS"
        assert s["gaps"] == ["some_gap"]

    def test_어휘_밖_등급은_예외다(self):
        with pytest.raises(ValueError):
            st.demote({}, "GREEN")

    def test_gate_가_state_의_등급_어휘를_본다(self):
        """gate.py 가 상수를 다시 적으면 두 곳이 갈라진다."""
        sys.path.insert(0, str(_SCRIPTS / "pipeline"))
        import gate as gate_mod
        assert (gate_mod.GRADE_PASS, gate_mod.GRADE_GAPS,
                gate_mod.GRADE_INCOMPLETE) == st.GRADES

    def test_06_08_의_이벤트_어휘가_있다(self):
        """어휘 밖 kind 는 append_event 가 ValueError 를 던진다."""
        for kind in ("approved", "approval_revoked", "pr_pushed",
                     "pr_opened", "promoted", "run_closed"):
            assert kind in st.EVENT_KINDS

    def test_run_status_어휘가_닫혀_있다(self):
        """리터럴로 흩어져 있던 것을 한 자리로 모은다 (M24).

        `abandoned` 는 넷째다 — "완주했다"(`done`)와 "이어질 일이 없다"를
        원장·보고서가 같은 것으로 읽으면 안 된다.
        """
        assert st.RUN_STATUS == ("active", "escalated", "done", "abandoned")
        assert st.DONE in st.RUN_STATUS

    def test_종단은_둘이고_escalated_는_빠진다(self):
        """`escalated` 는 재개 가능한 런이다 — 안 집으면 화면에서 사라진다."""
        assert st.TERMINAL_STATUS == ("done", "abandoned")
        assert "escalated" not in st.TERMINAL_STATUS

    def test_종단이_아닌_상태로는_close_run_이_거부한다(self):
        """`run_status` 를 옮기는 자리가 하나라는 규율을 함수가 지킨다."""
        import pytest as _pytest
        with _pytest.raises(ValueError):
            st.close_run({}, status="active")

    def test_run_closed_는_horizon_과_다른_사실이다(self):
        """`horizon` 은 "다음 페이즈가 아직 없다", `run_closed` 는 "런이
        끝났다" 다. 같은 kind 로 뭉치면 둘을 구분할 수 없다."""
        assert "horizon" in st.EVENT_KINDS and "run_closed" in st.EVENT_KINDS

    def test_07_수리_카운터가_있다(self):
        assert "pr_repair" in st.COUNTERS

    def test_봉투가_승인과_PR_을_노출한다(self):
        env = st.envelope("x", True, 0, {"approval": {"06": {"granted": True}},
                                         "pr": {"number": 7}}, {}, "", None)
        assert env["state_summary"]["approval"]["06"]["granted"] is True
        assert env["state_summary"]["pr"]["number"] == 7


# ---------------------------------------------------------------------------
# K. precheck 의 선언과 실제를 맞춘다 — 06 이 이 모듈을 그대로 재사용한다
# ---------------------------------------------------------------------------


class TestPrecheckSpecAlignment:
    """§2.5 는 정책이 카운터를 소모하지 않는다고 하고, §2.3 은 exit 10 이
    상태를 잠근다고 한다. 둘 다 코드와 어긋나 있었다."""

    def test_정책_실패는_카운터를_소모하지_않는다(self, repo):
        _branch(repo, "feat-x")
        _bulk_change(repo, 40)          # files_max: 10 초과
        got = pc.run(repo, scope="pr")
        assert got["exit"] == 9
        assert got["classification"] == "policy"
        assert got["counter_consumed"] is False

    def test_인프라_실패가_상태를_실제로_잠근다(self, repo, request_file,
                                              monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        _branch(repo, "feat-x")
        p = repo / "src" / "services"
        p.mkdir(parents=True)
        (p / "anthropic.ts").write_text("export const a = 1\n", encoding="utf-8")
        cli.run_init(repo, "x", request_file)
        env = cli.run_precheck(repo, scope="pr")
        assert env["exit"] == 10
        _paths, s = st.load(repo)
        assert s["escalated"] is True
        assert (repo / "_workspace" / "runs" / s["run_id"]
                / "ESCALATION.md").exists()

    def test_정책_실패는_상태를_잠그지_않는다(self, repo, request_file):
        _branch(repo, "feat-x")
        cli.run_init(repo, "x", request_file)
        _bulk_change(repo, 40)
        env = cli.run_precheck(repo, scope="pr")
        assert env["exit"] == 9
        _paths, s = st.load(repo)
        assert s["escalated"] is False

    def test_at_05_와_at_06_이_갈린다(self, repo, request_file):
        _branch(repo, "feat-x")
        _bulk_change(repo, 1)
        cli.run_init(repo, "x", request_file)
        cli.run_precheck(repo, scope="pr", phase="05")
        cli.run_precheck(repo, scope="pr", phase="06")
        _paths, s = st.load(repo)
        assert s["precheck"]["at_05"]["files"] >= 0
        assert s["precheck"]["at_06"]["files"] >= 0
        assert "base_behind" in s["precheck"]["at_06"]

    def test_런_없이도_돈다(self, repo):
        """06 이 쓰기 전에 05 가 쓰던 성질이다 — 잃지 않는다."""
        _branch(repo, "feat-x")
        _bulk_change(repo, 1)
        env = cli.run_precheck(repo, scope="pr", phase="06")
        assert env["exit"] == 0


# ---------------------------------------------------------------------------
# L. mask — 외부로 나가는 페이로드에만. 원장·내부 보고서는 원문 보존
# ---------------------------------------------------------------------------

import mask as mask_mod  # noqa: E402


def _secrets(repo, **kv):
    p = repo / ".env.local"
    p.write_text("\n".join("%s=%s" % (k, v) for k, v in kv.items()) + "\n",
                 encoding="utf-8")
    return p


class TestMask:

    def test_비밀_파일의_값만_가리고_키_이름은_남긴다(self, repo):
        _secrets(repo, ANTHROPIC_API_KEY="sk-ant-실제값-99")
        got = mask_mod.mask_text(repo, "설정: ANTHROPIC_API_KEY=sk-ant-실제값-99 끝")
        assert "sk-ant-실제값-99" not in got["text"]
        assert "ANTHROPIC_API_KEY" in got["text"]
        assert "[MASKED]" in got["text"]

    def test_값이_다른_문맥에_나와도_가린다(self, repo):
        """PR 본문에는 KEY=VALUE 형태가 아니라 로그 조각으로 실릴 수 있다."""
        _secrets(repo, ALADIN_TTB_KEY="ttbkey12345")
        got = mask_mod.mask_text(repo, "요청 실패: ...&ttbkey=ttbkey12345&q=1")
        assert "ttbkey12345" not in got["text"]

    def test_베어러_토큰_패턴(self, repo):
        got = mask_mod.mask_text(repo, "Authorization: Bearer abc.DEF-123_xyz")
        assert "abc.DEF-123_xyz" not in got["text"]
        assert "Bearer" in got["text"]

    def test_커넥션_문자열의_비밀번호만_가린다(self, repo):
        got = mask_mod.mask_text(repo, "postgres://admin:hunter2@db.example.com:5432/x")
        assert "hunter2" not in got["text"]
        assert "db.example.com" in got["text"]      # 호스트는 남는다
        assert "admin" in got["text"]               # 사용자 이름도 남는다

    def test_클라우드_액세스_키_패턴(self, repo):
        got = mask_mod.mask_text(repo, "key=AKIAIOSFODNN7EXAMPLE rest")
        assert "AKIAIOSFODNN7EXAMPLE" not in got["text"]

    def test_32자_난수처럼_보이는_것을_통째로_가리지_않는다(self, repo):
        """식별자·해시가 지워지면 스택트레이스가 무의미해진다."""
        sha = "c1c558f9ce1b9e16ee4b4acb0be95976fcdb2257"
        got = mask_mod.mask_text(repo, "계약 sha256=%s 이다" % sha)
        assert sha in got["text"]

    def test_비밀_파일_부재는_경고이지_실패가_아니다(self, repo):
        got = mask_mod.mask_text(repo, "평범한 본문")
        assert got["secret_files_missing"] == [".env.local", ".env"]
        assert got["ok"] is True
        assert got["text"] == "평범한 본문"

    def test_짧은_값은_비밀로_보지_않는다(self, repo):
        """빈 값이나 true/1 같은 것을 가리면 본문이 걸레가 된다."""
        _secrets(repo, DEBUG="1", NODE_ENV="test", REAL="비밀값입니다0123")
        got = mask_mod.mask_text(repo, "NODE_ENV=test 이고 DEBUG=1 이다")
        assert got["text"] == "NODE_ENV=test 이고 DEBUG=1 이다"

    def test_cli_가_파일을_읽어_파일로_쓴다(self, repo):
        _secrets(repo, K="비밀값입니다0123")
        src = repo / "in.md"
        src.write_text("본문 비밀값입니다0123\n", encoding="utf-8")
        env = cli.run_mask(repo, str(src), str(repo / "out.md"))
        assert env["exit"] == 0
        out = (repo / "out.md").read_text(encoding="utf-8")
        assert "비밀값입니다0123" not in out
        assert "[MASKED]" in out

    def test_없는_파일은_exit_1(self, repo):
        env = cli.run_mask(repo, str(repo / "없다.md"), str(repo / "out.md"))
        assert env["exit"] == 1


# ---------------------------------------------------------------------------
# N. approve — 승인은 이벤트다. 지문과 등급을 함께 못박는다
# ---------------------------------------------------------------------------


def _enter_06(repo, request_file, phases, grade="PASS"):
    """05 까지를 상태로 위조하고 06 에 세운다. **지문은 실물이다.**"""
    run_id, paths = _enter_05(repo, request_file, phases)
    _p, s = st.load(repo, run_id)
    st.set_phase_status(s, "05-code-review", "passed")
    s["phase"] = "06-pr"
    s["grade"] = grade
    s["review05"] = {"status": "ok", "reviewers_planned": 1, "reviewers_ok": 1,
                     "mode": "merged", "major": 0, "need_more_context": [],
                     "dropped_by_enforcement": 0, "truncated": False}
    config = harness._read_json(repo / harness.CONFIG_REL)
    s["fingerprint"] = st.fingerprint(repo, config)
    st.save(_p, s)
    return run_id, paths


class TestApprove:

    def test_승인이_지문과_등급을_함께_남긴다(self, repo, request_file, phases):
        run_id, _paths = _enter_06(repo, request_file, phases)
        env = cli.run_approve(repo, "06", run_id=run_id)
        assert env["exit"] == 0
        _p, s = st.load(repo, run_id)
        a = s["approval"]["06"]
        assert a["granted"] is True
        assert a["mode"] == "user"
        assert a["scope"] == "push+pr"
        assert a["grade_at_grant"] == "PASS"
        assert a["fingerprint"]["value"] == s["fingerprint"]["value"]

    def test_auto_도_push_pr_까지만_승인한다(self, repo, request_file, phases):
        """06 시점의 등급은 외부 리뷰를 못 본 '예상' 이다 (§3.6)."""
        run_id, _paths = _enter_06(repo, request_file, phases)
        env = cli.run_approve(repo, "06", auto=True, run_id=run_id)
        assert env["exit"] == 0
        _p, s = st.load(repo, run_id)
        assert s["approval"]["06"]["mode"] == "auto"
        assert s["approval"]["06"]["scope"] == "push+pr"

    def test_revoke_가_승인을_되돌리고_사유를_남긴다(self, repo, request_file,
                                                    phases):
        run_id, _paths = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        env = cli.run_approve(repo, "06", revoke=True, run_id=run_id)
        assert env["exit"] == 0
        _p, s = st.load(repo, run_id)
        assert s["approval"]["06"]["granted"] is False
        assert s["approval"]["06"]["revoked_at"]

    def test_05_가_안_끝났으면_exit_3(self, repo, request_file, phases):
        run_id, paths = _enter_05(repo, request_file, phases)
        env = cli.run_approve(repo, "06", run_id=run_id)
        assert env["exit"] == 3

    def test_런이_없으면_exit_3(self, repo):
        env = cli.run_approve(repo, "06")
        assert env["exit"] == 3

    def test_승인_뒤_코드가_바뀌면_지문이_어긋난다(self, repo, request_file,
                                                  phases):
        """이 어긋남을 06 이 exit 6 으로 읽는다 — 승인 자동 무효."""
        run_id, _paths = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        (repo / "src" / "lib" / "match.ts").write_text(
            "export function matchTitle(): number { return 1 }\n",
            encoding="utf-8")
        config = harness._read_json(repo / harness.CONFIG_REL)
        _p, s = st.load(repo, run_id)
        saved = s["approval"]["06"]["fingerprint"]
        assert not st.fingerprint_matches(saved, st.fingerprint(repo, config))

    def test_승인이_이벤트로_남는다(self, repo, request_file, phases):
        run_id, paths = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        kinds = [json.loads(l)["kind"]
                 for l in paths.events.read_text(encoding="utf-8").splitlines() if l]
        assert "approved" in kinds


# ---------------------------------------------------------------------------
# O. 06-pr — 승인 · push · PR 요청서. 실행기는 forge 를 부르지 않는다
# ---------------------------------------------------------------------------

import pr as pr_mod  # noqa: E402


def _remote(repo, tmp_path):
    """로컬 bare 리포를 origin 으로 붙인다 — 네트워크를 타지 않는다."""
    bare = tmp_path / "origin.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)],
                   capture_output=True)
    _git(repo, "remote", "add", "origin", str(bare))
    _git(repo, "push", "-q", "origin", "main")
    return bare


class TestPr06Preflight:
    """비용 오름차순이고 첫 실패에서 멈춘다. **브랜치를 자동 생성하지 않는다.**"""

    def test_보호_브랜치_위면_exit_3(self, repo, request_file, phases):
        run_id, _p = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 3
        assert "main" in env["render"]

    def test_브랜치_패턴_불일치면_exit_3(self, repo, request_file, phases):
        _branch(repo, "wip")
        run_id, _p = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 3

    def test_승인이_없으면_exit_9_이고_상태를_잠그지_않는다(self, repo,
                                                            request_file, phases,
                                                            tmp_path):
        _branch(repo, "feat-x")
        run_id, _p = _enter_06(repo, request_file, phases)
        _remote(repo, tmp_path)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 9
        assert "승인" in env["render"]
        assert "머지는 포함하지 않습니다" in env["render"]
        _pp, s = st.load(repo, run_id)
        assert s["escalated"] is False

    def test_승인_뒤_코드가_바뀌면_exit_6(self, repo, request_file, phases,
                                          tmp_path):
        _branch(repo, "feat-x")
        run_id, _p = _enter_06(repo, request_file, phases)
        _remote(repo, tmp_path)
        cli.run_approve(repo, "06", run_id=run_id)
        (repo / "src" / "lib" / "match.ts").write_text(
            "export function matchTitle(): number { return 2 }\n",
            encoding="utf-8")
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 6
        assert "재승인" in env["render"]

    def test_철회된_승인은_승인이_아니다(self, repo, request_file, phases,
                                          tmp_path):
        _branch(repo, "feat-x")
        run_id, _p = _enter_06(repo, request_file, phases)
        _remote(repo, tmp_path)
        cli.run_approve(repo, "06", run_id=run_id)
        cli.run_approve(repo, "06", revoke=True, run_id=run_id)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 9


class TestPr06Body:

    def test_본문_최상단이_완료_등급_한_줄이다(self, repo, request_file, phases):
        _branch(repo, "feat-x")
        run_id, paths = _enter_06(repo, request_file, phases,
                                  grade="PASS_WITH_GAPS")
        _pp, s = st.load(repo, run_id)
        s["gaps"] = ["stage_absent:e2e"]
        st.save(_pp, s)
        body = pr_mod.build_body(repo, paths, s,
                                 harness._read_json(repo / harness.CONFIG_REL))
        first = body.strip().splitlines()[0]
        assert "PASS_WITH_GAPS" in first
        assert "stage_absent:e2e" in body

    def test_본문에_필수_절이_전부_있다(self, repo, request_file, phases):
        _branch(repo, "feat-x")
        run_id, paths = _enter_06(repo, request_file, phases)
        _pp, s = st.load(repo, run_id)
        body = pr_mod.build_body(repo, paths, s,
                                 harness._read_json(repo / harness.CONFIG_REL))
        for sec in ("## 개요", "## 작업 내용", "## 기술적 고려사항",
                    "## 참고사항", "## 체크리스트"):
            assert sec in body, sec

    def test_본문이_마스킹을_거친다(self, repo, request_file, phases, tmp_path):
        _branch(repo, "feat-x")
        _secrets(repo, K="아주비밀한값0123")
        run_id, paths = _enter_06(repo, request_file, phases)
        req = repo / "_workspace" / "requests" / "req.md"
        req.write_text("아주비밀한값0123 을 쓰는 기능\n", encoding="utf-8")
        cli.run_approve(repo, "06", run_id=run_id)
        _remote(repo, tmp_path)
        cli.run_pr(repo, run_id=run_id)
        out = (paths.run_dir / "06_pr_body.md").read_text(encoding="utf-8")
        assert "아주비밀한값0123" not in out


class TestPr06Push:

    def test_성공하면_계약을_지우고_push_하고_요청서를_낸다(self, repo,
                                                          request_file, phases,
                                                          tmp_path):
        _branch(repo, "feat-x")
        run_id, paths = _enter_06(repo, request_file, phases)
        contract = repo / "_workspace" / "contract_x.md"
        assert contract.exists()
        cli.run_approve(repo, "06", run_id=run_id)
        _remote(repo, tmp_path)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 0, env["render"]
        assert not contract.exists(), "계약 파일은 push 성공 뒤에 지운다"
        assert (paths.run_dir / "06_pr_body.md").exists()
        req = json.loads((paths.run_dir / "06_pr_req.json")
                         .read_text(encoding="utf-8"))
        assert req["head"] == "feat-x"
        assert req["base"] == "main"
        assert req["forge"] == "github"
        assert req["body_file"].endswith("06_pr_body.md")
        _pp, s = st.load(repo, run_id)
        assert s["pr"]["pushed"] is True

    def test_원격이_없으면_exit_9_삼지선다(self, repo, request_file, phases):
        _branch(repo, "feat-x")
        run_id, _p = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 9
        assert "원격" in env["render"]
        for opt in ("①", "②", "③"):
            assert opt in env["render"]

    def test_non_fast_forward_는_에스컬레이션이다(self, repo, request_file,
                                                 phases, tmp_path):
        """force-push 금지이므로 자동 해결이 없다 (§E8)."""
        _branch(repo, "feat-x")
        run_id, _p = _enter_06(repo, request_file, phases)
        bare = _remote(repo, tmp_path)
        _git(repo, "push", "-q", "-u", "origin", "feat-x")
        # 원격만 앞서게 만든다 — 다른 클론이 커밋을 얹은 상황
        other = tmp_path / "other"
        subprocess.run(["git", "clone", "-q", str(bare), str(other)],
                       capture_output=True)
        _git(other, "checkout", "-q", "feat-x")
        (other / "z.txt").write_text("z\n", encoding="utf-8")
        _git(other, "add", "-A")
        _git(other, "-c", "user.email=t@e.com", "-c", "user.name=t",
             "commit", "-qm", "other")
        _git(other, "push", "-q", "origin", "feat-x")
        cli.run_approve(repo, "06", run_id=run_id)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 10
        _pp, s = st.load(repo, run_id)
        assert s["escalated"] is True

    def test_force_push_를_쓰지_않는다(self):
        src = (ROOT / "scripts" / "pipeline" / "pr.py").read_text(encoding="utf-8")
        assert "--force" not in src and "-f\"" not in src


class TestPr06ContractLifetime:
    """계약 삭제는 push **이후**다 (G-7).

    실패할 수 있는 `push` 보다 먼저 지우면, push 가 실패했을 때 05 의
    `requires`(계약 파일 실재 + `must_contain`)가 안 채워져 **재개가
    불가능해진다.** 계약은 `_workspace/` 아래 untracked 파일이라 삭제 시점이
    커밋 diff 에 영향을 주지 않는다 — 늦출 이유만 있고 당길 이유가 없다.
    """

    def test_push_가_실패하면_계약이_남아_있다(self, repo, request_file, phases,
                                              tmp_path):
        _branch(repo, "feat-x")
        run_id, paths = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        _remote(repo, tmp_path)
        # 원격 디렉터리를 없애 push 를 실패시킨다.
        import shutil
        shutil.rmtree(str(tmp_path / "origin.git"), ignore_errors=True)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] != 0, env["render"]
        c = repo / "_workspace" / "contract_x.md"
        assert c.exists(), "push 실패 뒤에 05 로 재개할 길이 남아야 한다"

    def test_삭제_전에_스냅샷을_남긴다(self, repo, request_file, phases, tmp_path):
        _branch(repo, "feat-x")
        run_id, paths = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        _remote(repo, tmp_path)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 0, env["render"]
        assert (paths.run_dir / "06_contract_snapshot.md").exists()


class TestRunAbandon:
    """이어질 일이 없는 런이 `active` 로 남아 있는 것 자체가 거짓이다."""

    def test_abandon_이_런을_닫는다(self, repo, request_file, phases):
        init = cli.run_init(repo, "x", str(request_file))
        run_id = init["run_id"]
        env = cli.run_abandon(repo, run_id=run_id, reason="설계가 바뀌었다")
        assert env["exit"] == 0
        _p, s = st.load(repo, run_id)
        assert s["run_status"] == "abandoned"
        assert s["closed_reason"] == "설계가 바뀌었다"

    def test_사유_없이는_닫지_않는다(self, repo, request_file, phases):
        init = cli.run_init(repo, "x", str(request_file))
        env = cli.run_abandon(repo, run_id=init["run_id"], reason="")
        assert env["exit"] == 2

    def test_버려진_런은_기본값으로_집히지_않는다(self, repo, request_file, phases):
        """살아 있는 런이 따로 있으면 버려진 쪽을 집지 않는다."""
        # run_id 는 요청 바이트에서 유도되므로 두 런의 요청이 달라야 한다.
        other = request_file.with_name("req2.md")
        other.write_text("# 다른 요청\n\n다른 내용이다.\n", encoding="utf-8")
        a = cli.run_init(repo, "a", str(request_file))["run_id"]
        b = cli.run_init(repo, "b", str(other))["run_id"]
        assert a != b
        # 지금 집히는 쪽을 버린다 — 그래야 정렬 운에 기대지 않는다.
        dead = st.latest_run_id(repo)
        alive = b if dead == a else a
        cli.run_abandon(repo, run_id=dead, reason="버린다")
        assert st.latest_run_id(repo) == alive

    def test_에스컬레이션된_런은_계속_집힌다(self, repo, request_file, phases):
        """재개 가능한 런이다 — 안 집으면 화면에서 사라진다."""
        rid = cli.run_init(repo, "a", str(request_file))["run_id"]
        paths, s = st.load(repo, rid)
        st.escalate(paths, s, "사람이 정한다", ["가", "나"], phase="01-plan")
        st.save(paths, s)
        assert st.latest_run_id(repo) == rid

    def test_닫힌_런은_다시_버려지지_않는다(self, repo, request_file, phases):
        rid = cli.run_init(repo, "a", str(request_file))["run_id"]
        cli.run_abandon(repo, run_id=rid, reason="한 번")
        env = cli.run_abandon(repo, run_id=rid, reason="두 번")
        assert env["exit"] == 3


class TestRecord06:
    """PR 결과를 되돌려 받는다. **번호가 갈라지는 것을 여기서 막는다.**"""

    def _pushed(self, repo, request_file, phases, tmp_path):
        _branch(repo, "feat-x")
        run_id, paths = _enter_06(repo, request_file, phases)
        cli.run_approve(repo, "06", run_id=run_id)
        _remote(repo, tmp_path)
        env = cli.run_pr(repo, run_id=run_id)
        assert env["exit"] == 0, env["render"]
        return run_id, paths

    def _result(self, paths, **kw):
        d = {"number": 231, "url": "https://example.com/pull/231",
             "state": "open", "action": "created"}
        d.update(kw)
        p = paths.run_dir / "06_pr_result.json"
        p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        return p

    def test_결과가_state_pr_에_들어가고_07_로_간다(self, repo, request_file,
                                                    phases, tmp_path):
        run_id, paths = self._pushed(repo, request_file, phases, tmp_path)
        f = self._result(paths)
        env = cli.run_record(repo, "06", str(f), run_id=run_id)
        assert env["exit"] in (0, 11), env["render"]
        _p, s = st.load(repo, run_id)
        assert s["pr"]["number"] == 231
        assert s["pr"]["state"] == "open"
        assert s["phase"] == "07-pr-review"

    def test_번호가_정수가_아니면_exit_8(self, repo, request_file, phases,
                                        tmp_path):
        run_id, paths = self._pushed(repo, request_file, phases, tmp_path)
        f = self._result(paths, number="231")
        env = cli.run_record(repo, "06", str(f), run_id=run_id)
        assert env["exit"] == 8

    def test_상태_어휘_밖은_exit_8(self, repo, request_file, phases, tmp_path):
        run_id, paths = self._pushed(repo, request_file, phases, tmp_path)
        f = self._result(paths, state="draft")
        env = cli.run_record(repo, "06", str(f), run_id=run_id)
        assert env["exit"] == 8

    def test_번호가_갈라지면_exit_8(self, repo, request_file, phases, tmp_path):
        """갱신이어야 할 것을 새로 만들면 07 이 어느 PR 을 볼지 모르게 된다."""
        run_id, paths = self._pushed(repo, request_file, phases, tmp_path)
        _p, s = st.load(repo, run_id)
        s["pr"]["number"] = 7
        st.save(_p, s)
        f = self._result(paths, number=231)
        env = cli.run_record(repo, "06", str(f), run_id=run_id)
        assert env["exit"] == 8
        assert "갈라" in env["render"] or "번호" in env["render"]

    def test_push_전에는_exit_3(self, repo, request_file, phases):
        _branch(repo, "feat-x")
        run_id, paths = _enter_06(repo, request_file, phases)
        f = self._result(paths)
        env = cli.run_record(repo, "06", str(f), run_id=run_id)
        assert env["exit"] == 3

    def test_PR_이_이벤트로_남는다(self, repo, request_file, phases, tmp_path):
        run_id, paths = self._pushed(repo, request_file, phases, tmp_path)
        cli.run_record(repo, "06", str(self._result(paths)), run_id=run_id)
        kinds = [json.loads(l)["kind"]
                 for l in paths.events.read_text(encoding="utf-8").splitlines() if l]
        assert "pr_opened" in kinds


# ---------------------------------------------------------------------------
# P. promote — 승격은 07 에서 런당 한 번. 05 는 staged 까지였다
# ---------------------------------------------------------------------------

import promote as promo_mod  # noqa: E402


def _fill_ledger(repo, key_title, category, severity, runs):
    """임계를 넘기도록 같은 유형을 여러 런에 걸쳐 원장에 쌓는다."""
    ldg.seed(repo)
    for rid in runs:
        ldg.append(repo, rid, "05", [
            {"category": category, "severity": severity, "target_role": "impl",
             "title": key_title, "resolution": "repaired",
             "reported_by": ["arch"], "source": "reviewer"}])


def _verdict_file(paths, verdicts):
    p = paths.run_dir / "07_promo_verdict.json"
    p.write_text(json.dumps({"verdicts": verdicts}, ensure_ascii=False),
                 encoding="utf-8")
    return p


class TestPromoteScan:

    def test_후보가_0_이면_모델을_부르지_않고_종결한다(self, repo, request_file,
                                                      phases):
        """초기 런의 최빈 경로다 — 원장이 비어 있다."""
        ldg.seed(repo)
        run_id, _p = _enter_06(repo, request_file, phases)
        env = cli.run_promote(repo, scan=True, run_id=run_id)
        assert env["exit"] == 0
        assert env["data"]["candidates"] == []
        assert env["data"]["needs_model"] is False
        _pp, s = st.load(repo, run_id)
        assert s["promotions"] == []

    def test_임계를_넘으면_후보가_올라온다(self, repo, request_file, phases):
        _fill_ledger(repo, "인가 규칙 누락", "AUTHZ_MISSING_RULE", "critical",
                     ["r1", "r2"])
        run_id, _p = _enter_06(repo, request_file, phases)
        env = cli.run_promote(repo, scan=True, run_id=run_id)
        assert env["exit"] == 0
        assert len(env["data"]["candidates"]) == 1
        assert env["data"]["needs_model"] is True

    def test_한_런에_몰린_것은_후보가_아니다(self, repo, request_file, phases):
        """distinct_runs >= 2 — 그 런의 특성이지 학습 대상이 아니다.

        같은 런의 같은 페이즈에서 두 번 온 것은 이제 **관측 하나**다 (M30).
        그래서 여기서 막는 것은 `distinct_runs` 이전에 누적 자체다.
        """
        _fill_ledger(repo, "인가 규칙 누락", "AUTHZ_MISSING_RULE", "critical",
                     ["r1", "r1"])
        run_id, _p = _enter_06(repo, request_file, phases)
        env = cli.run_promote(repo, scan=True, run_id=run_id)
        assert env["data"]["candidates"] == []
        assert env["data"]["held"] == []


def _staged_authz(repo, request_file, phases):
    _fill_ledger(repo, "인가 규칙 누락", "AUTHZ_MISSING_RULE", "critical",
                 ["r1", "r2"])
    run_id, paths = _enter_06(repo, request_file, phases)
    cli.run_promote(repo, scan=True, run_id=run_id)
    return run_id, paths


def _one_verdict(**kw):
    """판정은 **어느 후보를 올리는지 가리켜야 한다** — rule_id 는 새로 짓는
    목적지 이름이라 후보의 기본 이름과 다를 수 있다."""
    d = {"action": "create", "judgement": "new", "rule_id": "authz-catchall",
         "category": "AUTHZ_MISSING_RULE", "enforceable": "prose",
         "rationale": "캐치올 위치는 기계가 못 본다"}
    d.update(kw)
    return d


class TestPromoteVerdict:

    def test_duplicate_에서_create_는_금지다(self, repo, request_file, phases):
        run_id, paths = _staged_authz(repo, request_file, phases)
        f = _verdict_file(paths, [_one_verdict(judgement="duplicate",
                                               action="create")])
        env = cli.run_promote(repo, apply=True, verdict_file=str(f),
                              run_id=run_id)
        assert env["exit"] == 8
        assert "duplicate" in json.dumps(env["data"], ensure_ascii=False)

    def test_contradicts_는_쓰기를_차단하고_에스컬레이션한다(self, repo,
                                                          request_file, phases):
        run_id, paths = _staged_authz(repo, request_file, phases)
        f = _verdict_file(paths, [_one_verdict(judgement="contradicts")])
        env = cli.run_promote(repo, apply=True, verdict_file=str(f),
                              run_id=run_id)
        assert env["exit"] == 10
        _pp, s = st.load(repo, run_id)
        assert s["escalated"] is True

    def test_기계로_막을_수_있는_규칙의_산문_승격은_exit_8(self, repo,
                                                        request_file, phases):
        _fill_ledger(repo, "경계를 넘는 import", "BOUNDARY_VIOLATION",
                     "critical", ["r1", "r2"])
        run_id, paths = _enter_06(repo, request_file, phases)
        cli.run_promote(repo, scan=True, run_id=run_id)
        f = _verdict_file(paths, [_one_verdict(rule_id="no-restricted-imports",
                                               category="BOUNDARY_VIOLATION",
                                               enforceable="prose")])
        env = cli.run_promote(repo, apply=True, verdict_file=str(f),
                              run_id=run_id)
        assert env["exit"] == 8

    def test_런당_create_상한은_3건이다(self, repo, request_file, phases):
        run_id, paths = _staged_authz(repo, request_file, phases)
        f = _verdict_file(paths, [_one_verdict(rule_id="r%d" % i)
                                  for i in range(4)])
        # 넷 다 같은 후보를 가리키지만, 상한 검사는 create 의 **개수**를 본다
        env = cli.run_promote(repo, apply=True, verdict_file=str(f),
                              run_id=run_id)
        assert env["exit"] == 8
        assert "3" in json.dumps(env["data"], ensure_ascii=False)


class TestPromoteApply:

    def _ready(self, repo, request_file, phases):
        run_id, paths = _staged_authz(repo, request_file, phases)
        f = _verdict_file(paths, [_one_verdict()])
        return run_id, paths, f

    def test_적용이_changelog_에_줄을_남긴다(self, repo, request_file, phases):
        run_id, paths, f = self._ready(repo, request_file, phases)
        env = cli.run_promote(repo, apply=True, verdict_file=str(f),
                              run_id=run_id)
        assert env["exit"] == 0, env["render"]
        log = (repo / "docs" / "harness" / "pipeline" / "ledger"
               / "rules_changelog.md").read_text(encoding="utf-8")
        assert "authz-catchall" in log
        assert run_id in log

    def test_적용이_promotions_를_applied_로_만든다(self, repo, request_file,
                                                   phases):
        run_id, paths, f = self._ready(repo, request_file, phases)
        cli.run_promote(repo, apply=True, verdict_file=str(f), run_id=run_id)
        _pp, s = st.load(repo, run_id)
        assert s["promotions"]
        assert all(p["status"] in ("applied", "rejected", "skipped")
                   for p in s["promotions"])
        assert any(p["status"] == "applied" for p in s["promotions"])

    def test_산출_파일이_07_promo_applied_다(self, repo, request_file, phases):
        run_id, paths, f = self._ready(repo, request_file, phases)
        cli.run_promote(repo, apply=True, verdict_file=str(f), run_id=run_id)
        assert (paths.run_dir / "07_promo_applied.json").exists()

    def test_lint_승격인데_베이스라인_diff_가_없으면_rejected(self, repo,
                                                            request_file,
                                                            phases):
        """규칙은 추가했는데 아무것도 안 막는 것이 조용히 통과하지 않는다."""
        _fill_ledger(repo, "경계를 넘는 import", "BOUNDARY_VIOLATION",
                     "critical", ["r1", "r2"])
        run_id, paths = _enter_06(repo, request_file, phases)
        cli.run_promote(repo, scan=True, run_id=run_id)
        f = _verdict_file(paths, [_one_verdict(rule_id="no-restricted-imports",
                                               category="BOUNDARY_VIOLATION",
                                               enforceable="lint",
                                               baseline_diff="")])
        cli.run_promote(repo, apply=True, verdict_file=str(f), run_id=run_id)
        _pp, s = st.load(repo, run_id)
        assert any(p["status"] == "rejected" for p in s["promotions"])
        assert "베이스라인" in json.dumps(s["promotions"], ensure_ascii=False)

    def test_승격이_이벤트로_남는다(self, repo, request_file, phases):
        run_id, paths, f = self._ready(repo, request_file, phases)
        cli.run_promote(repo, apply=True, verdict_file=str(f), run_id=run_id)
        kinds = [json.loads(l)["kind"]
                 for l in paths.events.read_text(encoding="utf-8").splitlines()
                 if l]
        assert "promoted" in kinds


class TestPromoteTargetMatching:
    """판정이 어느 후보를 가리키는가 (G-1).

    `apply()` 가 한 루프 안에서 `finding_key` 정확 일치와 `category` 약한
    일치를 **섞어** 검사하고 먼저 걸리는 쪽에서 멈췄다. 배열 앞쪽의 약한
    일치가 뒤쪽의 정확한 일치를 이긴다 — 엉뚱한 규칙이 changelog 에 쓰이고
    근거 열도 다른 버킷에서 온다.
    """

    def _promos(self):
        return [
            {"rule_id": "a", "finding_key": "KEY-A", "category": "TX_BOUNDARY",
             "enforceable": "prose", "severity": "major", "count": 3,
             "distinct_runs": 2, "status": "staged", "reason": None},
            {"rule_id": "b", "finding_key": "KEY-B", "category": "TX_BOUNDARY",
             "enforceable": "prose", "severity": "critical", "count": 9,
             "distinct_runs": 4, "status": "staged", "reason": None},
        ]

    def test_finding_key_일치가_category_일치를_이긴다(self, repo):
        ldg.seed(repo)
        promos = self._promos()
        promo_mod.apply(repo, "r9", promos, [
            {"rule_id": "tx-b", "finding_key": "KEY-B", "category": "TX_BOUNDARY",
             "enforceable": "prose", "judgement": "new", "action": "create",
             "rationale": "필요하다"}])
        by_key = {p["finding_key"]: p for p in promos}
        assert by_key["KEY-B"]["status"] == "applied"
        assert by_key["KEY-A"]["status"] == "staged", \
            "앞쪽의 category 일치가 정확한 키 일치를 이기면 안 된다"

    def test_한_판정이_두_후보를_동시에_바꾸지_않는다(self, repo):
        ldg.seed(repo)
        promos = self._promos()
        _p, rows = promo_mod.apply(repo, "r9", promos, [
            {"rule_id": "x", "category": "TX_BOUNDARY", "enforceable": "prose",
             "judgement": "new", "action": "create", "rationale": "하나"},
            {"rule_id": "y", "category": "TX_BOUNDARY", "enforceable": "prose",
             "judgement": "new", "action": "create", "rationale": "둘"}])
        touched = [p for p in promos if p["status"] != "staged"]
        assert len(touched) == 2, "두 판정이 같은 행을 잡아 앞을 덮으면 안 된다"
        assert len(rows) == 2

    def test_없는_finding_key_는_category_로_낙하하지_않는다(self, repo):
        """이름을 부른 것과 다른 지적이 승격되느니 거부가 맞다."""
        ldg.seed(repo)
        promos = self._promos()
        errors, _blocked = promo_mod.check_verdicts(repo, [
            {"rule_id": "z", "finding_key": "KEY-없음", "category": "TX_BOUNDARY",
             "enforceable": "prose", "judgement": "new", "action": "create"}],
            promos)
        assert errors, "후보에 없는 finding_key 는 거부돼야 한다"

    def test_check_verdicts_와_apply_가_같은_후보를_가리킨다(self, repo):
        ldg.seed(repo)
        promos = self._promos()
        v = {"rule_id": "tx", "finding_key": "KEY-B", "category": "TX_BOUNDARY",
             "enforceable": "prose", "judgement": "new", "action": "create",
             "rationale": "r"}
        errors, _b = promo_mod.check_verdicts(repo, [v], promos)
        assert errors == []
        promo_mod.apply(repo, "r9", promos, [v])
        assert [p for p in promos if p["status"] == "applied"][0][
            "finding_key"] == "KEY-B"


class TestPromoteStatePreservation:
    """`--scan` 은 읽기다 (G-3).

    읽기가 상태를 바꾸는 것이 이 결함의 뿌리다. `--scan`/`--stage` 가
    `s["promotions"]` 를 무조건 새 staged 목록으로 덮어써, `--apply` 뒤에
    다시 `--scan` 이 돌면 `applied` 가 사라진다 — `report` 가 exit 6 을 내고
    두 번째 `--apply` 에서 changelog 가 중복된다.
    """

    def test_scan_은_applied_를_되돌리지_않는다(self, repo, request_file, phases):
        _fill_ledger(repo, "인가 규칙 누락", "AUTHZ_MISSING_RULE", "critical",
                     ["r1", "r2"])
        run_id, _p = _enter_06(repo, request_file, phases)
        paths, s = st.load(repo, run_id)
        s["promotions"] = [{"rule_id": "keep", "finding_key": "K",
                            "category": "AUTHZ_MISSING_RULE",
                            "enforceable": "prose", "severity": "critical",
                            "count": 2, "distinct_runs": 2,
                            "status": "applied", "reason": "이미 썼다"}]
        st.save(paths, s)
        cli.run_promote(repo, scan=True, run_id=run_id)
        _pp, s2 = st.load(repo, run_id)
        assert s2["promotions"][0]["status"] == "applied"

    def test_stage_는_applied_를_지우지_않는다(self, repo, request_file, phases):
        _fill_ledger(repo, "인가 규칙 누락", "AUTHZ_MISSING_RULE", "critical",
                     ["r1", "r2"])
        run_id, _p = _enter_06(repo, request_file, phases)
        cli.run_promote(repo, stage=True, run_id=run_id)
        paths, s = st.load(repo, run_id)
        assert s["promotions"], "후보가 올라와야 한다"
        s["promotions"][0]["status"] = "applied"
        s["promotions"][0]["reason"] = "이미 썼다"
        st.save(paths, s)
        cli.run_promote(repo, stage=True, run_id=run_id)
        _pp, s2 = st.load(repo, run_id)
        assert s2["promotions"][0]["status"] == "applied"
        assert s2["promotions"][0]["reason"] == "이미 썼다"

    def test_stage_는_새_후보를_더한다(self, repo, request_file, phases):
        _fill_ledger(repo, "인가 규칙 누락", "AUTHZ_MISSING_RULE", "critical",
                     ["r1", "r2"])
        run_id, _p = _enter_06(repo, request_file, phases)
        cli.run_promote(repo, stage=True, run_id=run_id)
        _fill_ledger(repo, "트랜잭션 경계가 없다", "TX_BOUNDARY", "critical",
                     ["r3", "r4"])
        cli.run_promote(repo, stage=True, run_id=run_id)
        _pp, s = st.load(repo, run_id)
        cats = {p["category"] for p in s["promotions"]}
        assert cats == {"AUTHZ_MISSING_RULE", "TX_BOUNDARY"}

    def test_promotions_가_빈_리스트면_전량_재stage_하지_않는다(
            self, repo, request_file, phases):
        """`or` 가 적법하게 빈 `[]` 를 거짓으로 읽는 자리 — G-4:1655 와 같은 모양."""
        _fill_ledger(repo, "인가 규칙 누락", "AUTHZ_MISSING_RULE", "critical",
                     ["r1", "r2"])
        run_id, paths = _enter_06(repo, request_file, phases)
        _p, s = st.load(repo, run_id)
        s["promotions"] = []
        st.save(_p, s)
        vf = paths.run_dir / "07_promo_verdict.json"
        vf.write_text(json.dumps({"verdicts": [
            {"rule_id": "authz", "category": "AUTHZ_MISSING_RULE",
             "enforceable": "prose", "judgement": "new", "action": "create",
             "rationale": "r"}]}, ensure_ascii=False), encoding="utf-8")
        cli.run_promote(repo, apply=True, verdict_file=str(vf), run_id=run_id)
        _pp, s2 = st.load(repo, run_id)
        # 아무것도 staged 되지 않은 런에서 판정만으로 후보가 되살아나면
        # `--stage` 를 건너뛴 승격이 성립한다.
        assert all(p["status"] != "staged" for p in s2["promotions"]), \
            [p["status"] for p in s2["promotions"]]


class TestPromoteFlush:

    def test_flush_가_staged_잔여를_종결한다(self, repo, request_file, phases):
        run_id, _p = _staged_authz(repo, request_file, phases)
        _pp, s = st.load(repo, run_id)
        assert any(p["status"] == "staged" for p in s["promotions"])
        env = cli.run_promote(repo, flush=True, run_id=run_id)
        assert env["exit"] == 0
        _pp, s = st.load(repo, run_id)
        assert not any(p["status"] == "staged" for p in s["promotions"])
        assert all(p["status"] in ("applied", "rejected", "skipped")
                   for p in s["promotions"])


# ---------------------------------------------------------------------------
# Q. review07 — 생략 조건은 결정론이다. 봇이 없으면 생략이 성립하지 않는다
# ---------------------------------------------------------------------------

import review07 as rv7  # noqa: E402


def _enter_07(repo, request_file, phases, review05_status="ok", major=0,
              decide=False):
    run_id, paths = _enter_06(repo, request_file, phases)
    _p, s = st.load(repo, run_id)
    st.set_phase_status(s, "06-pr", "passed")
    s["phase"] = "07-pr-review"
    s["pr"] = {"number": 231, "state": "open", "pushed": True, "head": "feat-x"}
    s["review05"] = dict(s["review05"], status=review05_status, major=major)
    st.save(_p, s)
    if decide:
        # 07 의 절차는 `review07` → 내장 리뷰 → `record` 다. 그 첫 단계를
        # 건너뛰면 외부 계수의 권위가 제출자에게 넘어간다 (G-6).
        cli.run_review07(repo, run_id=run_id)
    return run_id, paths


def _enable_bot(repo, **kw):
    """봇을 켠다. **끈 상태가 기본**이라 켜는 쪽이 명시적이어야 한다."""
    p = repo / harness.CONFIG_REL
    d = harness._read_json(p)
    d["external_pr_review"] = dict(
        {"enabled": True, "bot_logins": ["some-bot"], "poll_sec": 1,
         "timeout_sec": 1}, **kw)
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")


def _external(paths, **kw):
    d = {"status": "reviewed", "major": 0, "findings": [],
         "change_requested": False}
    d.update(kw)
    p = paths.run_dir / "07_external.json"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return p


class TestReview07Skip:

    def test_봇이_꺼져_있으면_생략이_성립하지_않는다(self, repo, request_file,
                                                    phases):
        """'봇이 없으니 리뷰가 없었다' 가 '통과' 가 되지 않는다 (§3.7)."""
        run_id, paths = _enter_07(repo, request_file, phases)
        env = cli.run_review07(repo, run_id=run_id)
        assert env["exit"] == 0
        assert env["data"]["external"]["status"] == "disabled"
        assert env["data"]["skip"] is False
        assert env["data"]["effort"] == "low"

    def test_reviewed_이고_major_0_이면_생략한다(self, repo, request_file,
                                                phases):
        run_id, paths = _enter_07(repo, request_file, phases)
        _enable_bot(repo)
        f = _external(paths)
        env = cli.run_review07(repo, external=str(f), run_id=run_id)
        assert env["data"]["skip"] is True
        assert env["data"]["effort"] == "skipped"

    def test_05_가_ok_가_아니면_medium_이다(self, repo, request_file, phases):
        """리뷰 결손을 비싼 쪽으로 메운다."""
        run_id, paths = _enter_07(repo, request_file, phases,
                                  review05_status="degraded")
        _enable_bot(repo)
        f = _external(paths)
        env = cli.run_review07(repo, external=str(f), run_id=run_id)
        assert env["data"]["skip"] is False
        assert env["data"]["effort"] == "medium"

    def test_external_major_가_있으면_생략하지_않는다(self, repo, request_file,
                                                     phases):
        run_id, paths = _enter_07(repo, request_file, phases)
        _enable_bot(repo)
        # major 는 봇의 자진 신고가 아니라 **findings 구조에서 센다.**
        f = _external(paths, findings=[
            {"title": "인가 누락", "severity": "major", "quote": "x"}])
        env = cli.run_review07(repo, external=str(f), run_id=run_id)
        assert env["data"]["skip"] is False

    def test_not_a_review_는_생략_불성립이고_등급을_떨어뜨린다(self, repo,
                                                             request_file,
                                                             phases):
        run_id, paths = _enter_07(repo, request_file, phases)
        _enable_bot(repo)
        f = _external(paths, status="not_a_review")
        env = cli.run_review07(repo, external=str(f), run_id=run_id)
        assert env["data"]["skip"] is False
        assert env["data"]["effort"] == "low"
        _pp, s = st.load(repo, run_id)
        assert s["grade"] == "PASS_WITH_GAPS"
        assert any("external" in g for g in s["gaps"])

    def test_어휘_밖_status_는_exit_8(self, repo, request_file, phases):
        run_id, paths = _enter_07(repo, request_file, phases)
        _enable_bot(repo)
        f = _external(paths, status="좋았음")
        env = cli.run_review07(repo, external=str(f), run_id=run_id)
        assert env["exit"] == 8


class TestReview07Gaps:
    """gap 기록은 effort 분기와 **독립이다** (G-5).

    `decide()` 가 하나의 if/elif 사슬에 두 결정을 엮어 두어, 05 가 `ok` 가
    아니면 `external:*` gap 이 영영 안 생겼다. 결손 둘 중 하나만 보고서에
    남는다.
    """

    def test_05_결손과_외부_결손이_둘_다_남는다(self, repo, request_file, phases):
        run_id, paths = _enter_07(repo, request_file, phases,
                                  review05_status="degraded")
        env = cli.run_review07(repo, run_id=run_id)
        _p, s = st.load(repo, run_id)
        gaps = s.get("gaps") or []
        assert any(g.startswith("external:") for g in gaps), gaps
        assert env["data"]["effort"] == "medium", "결손은 비싼 쪽으로 메운다"

    def test_gap_은_네_조합에서_일관된다(self, repo):
        """r05.status × reviewed 의 네 조합. 순서를 바꿔 구멍을 옮기지 않았다."""
        cfg = _config(repo)
        cases = [
            ("ok", "reviewed", []),
            ("ok", "disabled", ["external:disabled"]),
            ("degraded", "reviewed", ["review05:degraded"]),
            ("degraded", "disabled", ["review05:degraded", "external:disabled"]),
        ]
        for r05, ext, want in cases:
            got = rv7.decide({"review05": {"status": r05, "major": 0}},
                             {"status": ext, "major": 0}, cfg)
            assert sorted(got["gaps"]) == sorted(want), (r05, ext, got["gaps"])


class TestRecord07ExternalAuthority:
    """외부 Major 의 권위는 `review07` 의 재계수에 있다 (G-6 · 불변식 8)."""

    def test_review07_없이_record_하면_거부된다(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases)
        env = cli.run_record(repo, "07", str(_r07(paths)), run_id=run_id)
        assert env["exit"] == 3
        assert "review07" in env["render"]

    def test_자진_신고된_major_를_저장하지_않는다(self, repo, request_file,
                                                 phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        cli.run_record(repo, "07", str(_r07(paths)), run_id=run_id)
        _p, s = st.load(repo, run_id)
        # 봇이 꺼져 있으므로 review07 이 센 값은 disabled · 0 이다.
        assert s["review07"]["external"]["status"] == "disabled"
        assert s["review07"]["external"]["major"] == 0

    def test_신고와_기계_계수가_다르면_exit_8(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        f = _r07(paths, external={"status": "reviewed", "major": 3})
        env = cli.run_record(repo, "07", str(f), run_id=run_id)
        assert env["exit"] == 8
        assert "기계" in env["render"] or "대조" in env["render"]

    def test_신고가_기계_계수와_같으면_통과한다(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        f = _r07(paths, external={"status": "disabled", "major": 0})
        env = cli.run_record(repo, "07", str(f), run_id=run_id)
        assert env["exit"] in (0, 11), env["render"]


class TestReview07Severity:

    def test_심각도를_못_가르면_Major_로_낙하한다(self):
        """모르는 것이 괜찮은 것이 되면 안 된다 (§E1)."""
        got = rv7.normalize_external({"status": "reviewed", "findings": [
            {"title": "뭔가 이상하다", "quote": "x"}]})
        assert got["findings"][0]["severity"] == "major"
        assert got["major"] == 1

    def test_구조가_없으면_not_a_review_다(self):
        """헤딩 텍스트가 아니라 구조로 판정한다 — 봇 출력 언어에 안 기댄다."""
        got = rv7.normalize_external({"body": "리뷰했습니다. 좋아 보이네요."})
        assert got["status"] == "not_a_review"

    def test_사람_코멘트는_수리_대상이_아니다(self):
        got = rv7.normalize_external({"status": "reviewed", "findings": [
            {"title": "이건 어때요", "severity": "major", "source": "human"}]})
        assert got["findings"] == []
        assert len(got["human_comments"]) == 1
        assert got["major"] == 0


class TestReview07Audit:

    def test_audit_run_은_생략_조건을_만족해도_medium_을_강제한다(
            self, repo, request_file, phases, monkeypatch):
        run_id, paths = _enter_07(repo, request_file, phases)
        _enable_bot(repo)
        f = _external(paths)
        monkeypatch.setattr(rv7, "audit_due", lambda root: True)
        env = cli.run_review07(repo, external=str(f), run_id=run_id)
        assert env["data"]["skip"] is False
        assert env["data"]["effort"] == "medium"
        assert env["data"]["audit_run"] is True
        _pp, s = st.load(repo, run_id)
        assert s["audit"]["is_audit_run"] is True

    def test_audit_주기는_5런마다다(self, repo):
        d = repo / "_workspace" / "runs"
        d.mkdir(parents=True, exist_ok=True)
        for i in range(4):
            (d / ("2026090%d-0000-000%d" % (i, i))).mkdir()
        assert rv7.audit_due(repo) is False
        (d / "20260905-0000-0005").mkdir()
        assert rv7.audit_due(repo) is True


# ---------------------------------------------------------------------------
# R. record --phase 07 — escaped_05 를 세고, 변경 요청은 차단이다
# ---------------------------------------------------------------------------


def _r07(paths, **kw):
    d = {"code_review": "low", "findings": [], "change_requested": False,
         "human_comments": []}
    d.update(kw)
    p = paths.run_dir / "07_pr_review.json"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return p


class TestRecord07:

    def test_깨끗하면_08_로_간다(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        env = cli.run_record(repo, "07", str(_r07(paths)), run_id=run_id)
        assert env["exit"] in (0, 11), env["render"]
        _p, s = st.load(repo, run_id)
        assert s["phase"] == "08-report"
        assert s["review07"]["escaped_05"] == 0

    def test_05_가_못_잡은_것이_escaped_05_로_센다(self, repo, request_file,
                                                  phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        f = _r07(paths, findings=[
            {"id": "G-1", "category": "TX_BOUNDARY", "severity": "major",
             "target_role": "impl", "title": "트랜잭션 경계가 없다",
             "source": "code-review", "quote": "x"}])
        cli.run_record(repo, "07", str(f), run_id=run_id)
        _p, s = st.load(repo, run_id)
        assert s["review07"]["escaped_05"] == 1

    def test_05_가_이미_낸_것은_dedup_된다(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        same = {"category": "TX_BOUNDARY", "severity": "major",
                "target_role": "impl", "title": "트랜잭션 경계가 없다"}
        ldg.append(repo, run_id, "05", [dict(same, resolution="repaired",
                                             reported_by=["arch"],
                                             source="reviewer")])
        f = _r07(paths, findings=[dict(same, id="G-1", source="code-review",
                                       quote="x")])
        cli.run_record(repo, "07", str(f), run_id=run_id)
        _p, s = st.load(repo, run_id)
        assert s["review07"]["escaped_05"] == 0

    def test_변경_요청_미해결은_exit_10(self, repo, request_file, phases):
        """PR 체크가 빨간불인데 파이프라인이 초록불인 척하지 않는다."""
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        f = _r07(paths, change_requested=True, findings=[
            {"id": "G-1", "category": "TX_BOUNDARY", "severity": "major",
             "target_role": "impl", "title": "고쳐라", "source": "external",
             "quote": "x"}])
        env = cli.run_record(repo, "07", str(f), run_id=run_id)
        assert env["exit"] == 10

    def test_변경_요청인데_findings_가_비면_exit_8(self, repo, request_file,
                                                  phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        f = _r07(paths, change_requested=True, findings=[])
        env = cli.run_record(repo, "07", str(f), run_id=run_id)
        assert env["exit"] == 8

    def test_어휘_밖_source_는_exit_8(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        f = _r07(paths, findings=[
            {"id": "G-1", "category": "TX_BOUNDARY", "severity": "major",
             "target_role": "impl", "title": "x", "source": "내가지어낸출처",
             "quote": "x"}])
        env = cli.run_record(repo, "07", str(f), run_id=run_id)
        assert env["exit"] == 8

    def test_PR_이_머지됐으면_아무것도_안_하고_끝낸다(self, repo, request_file,
                                                     phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        _p, s = st.load(repo, run_id)
        s["pr"]["state"] = "merged"
        st.save(_p, s)
        env = cli.run_record(repo, "07", str(_r07(paths)), run_id=run_id)
        assert env["exit"] in (0, 11)
        _p, s = st.load(repo, run_id)
        assert any("pr_closed" in g or "pr_merged" in g for g in s["gaps"])

    def test_사람_코멘트는_수리_대상이_아니다(self, repo, request_file, phases):
        ldg.seed(repo)
        run_id, paths = _enter_07(repo, request_file, phases, decide=True)
        f = _r07(paths, human_comments=[{"body": "이건 어때요"}])
        env = cli.run_record(repo, "07", str(f), run_id=run_id)
        assert env["exit"] in (0, 11)


# ---------------------------------------------------------------------------
# S. 08-report — 재지 못한 것이 조용히 통과하지 않는다
# ---------------------------------------------------------------------------

import report as rep_mod  # noqa: E402


def _enter_08(repo, request_file, phases, grade="PASS"):
    ldg.seed(repo)
    run_id, paths = _enter_07(repo, request_file, phases, decide=True)
    _p, s = st.load(repo, run_id)
    st.set_phase_status(s, "07-pr-review", "passed")
    s["phase"] = "08-report"
    s["grade"] = grade
    s["promotions"] = []
    s["review07"] = {"external": {"status": "disabled", "major": 0},
                     "code_review": "low", "escaped_05": 0}
    st.save(_p, s)
    return run_id, paths


def _report_data(paths, **kw):
    d = {"narrative": {"문제": "재시도가 안 됐다", "원인": "상태 머신",
                       "해결": "리듀서 수정", "결과": "통과",
                       "배운 점": "AC 가 증상을 잠가야 한다"}}
    d.update(kw)
    p = paths.run_dir / "08_report_data.json"
    p.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    return p


class TestReport08:

    def test_필수_섹션_다섯이_전부_있다(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        env = cli.run_report(repo, run_id=run_id)
        assert env["exit"] == 11, env["render"]
        out = (repo / "docs" / "harness" / "pipeline" / "runs"
               / ("%s.md" % run_id)).read_text(encoding="utf-8")
        for sec in rep_mod.REQUIRED_SECTIONS:
            assert sec in out, sec

    def test_캘리브레이션_상태가_partial_과_unverified_를_드러낸다(
            self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        cli.run_report(repo, run_id=run_id)
        out = (repo / "docs" / "harness" / "pipeline" / "runs"
               / ("%s.md" % run_id)).read_text(encoding="utf-8")
        assert "partial" in out or "옛 값" in out
        assert "verified" in out or "미검증" in out

    def test_staged_잔여가_있으면_exit_6(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        _p, s = st.load(repo, run_id)
        s["promotions"] = [{"rule_id": "r", "status": "staged", "reason": None}]
        st.save(_p, s)
        _report_data(paths)
        env = cli.run_report(repo, run_id=run_id)
        assert env["exit"] == 6
        assert "flush" in env["render"]

    def test_INCOMPLETE_면_08_을_돌리지_않는다(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases,
                                  grade="INCOMPLETE")
        _report_data(paths)
        env = cli.run_report(repo, run_id=run_id)
        assert env["exit"] == 3
        assert "ESCALATION" in env["render"]

    def test_입력이_없으면_exit_3(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        env = cli.run_report(repo, run_id=run_id)
        assert env["exit"] == 3

    def test_같은_run_id_로_다시_쓰면_덮어쓴다(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        cli.run_report(repo, run_id=run_id)
        _report_data(paths, narrative={"문제": "두 번째 판"})
        cli.run_report(repo, run_id=run_id)
        out = (repo / "docs" / "harness" / "pipeline" / "runs"
               / ("%s.md" % run_id)).read_text(encoding="utf-8")
        assert "두 번째 판" in out
        assert out.count("## 완료 등급") == 1

    def test_승격_목록은_원장에서_자동으로_나온다(self, repo, request_file,
                                                phases):
        """모델이 빠뜨릴 수 없다 — 서술이 비어도 표는 나온다."""
        run_id, paths = _enter_08(repo, request_file, phases)
        _p, s = st.load(repo, run_id)
        s["promotions"] = [{"rule_id": "authz-catchall", "status": "applied",
                            "category": "AUTHZ_MISSING_RULE", "reason": "x"}]
        st.save(_p, s)
        _report_data(paths, narrative={})
        cli.run_report(repo, run_id=run_id)
        out = (repo / "docs" / "harness" / "pipeline" / "runs"
               / ("%s.md" % run_id)).read_text(encoding="utf-8")
        assert "authz-catchall" in out

    def test_보고서는_파이프라인을_실패시키지_않는다(self, repo, request_file,
                                                   phases):
        """섹션이 비어도 산출되고 **런도 닫힌다** — 원장에 기록만 한다."""
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths, narrative={})
        env = cli.run_report(repo, run_id=run_id)
        assert env["ok"] is True
        assert env["exit"] == 11
        assert env["data"]["closed"] is True, "섹션이 빠져도 런은 닫힌다"

    # ── M24. 08 의 동사가 런을 닫는다.

    def test_report_가_런을_닫는다(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        env = cli.run_report(repo, run_id=run_id)
        assert env["exit"] == 11, env["render"]
        assert env["data"]["closed"] is True
        _p, s = st.load(repo, run_id)
        assert s["phases"]["08-report"]["status"] == "passed"
        assert s["phase"] == st.DONE
        assert s["run_status"] == st.DONE
        assert s.get("closed_at")

    def test_런_완료가_render_에_있다(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        env = cli.run_report(repo, run_id=run_id)
        assert "런 완료" in env["render"]
        assert run_id in env["render"], "보고서 경로도 함께 남는다"

    def test_닫힌_런에_다시_쓰면_덮어쓰고_exit_0(self, repo, request_file, phases):
        """`08-report.md` 가 요구하는 재작성 — 전이는 한 번뿐이다."""
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        assert cli.run_report(repo, run_id=run_id)["exit"] == 11
        _report_data(paths, narrative={"문제": "두 번째 판"})
        env = cli.run_report(repo, run_id=run_id)
        assert env["exit"] == 0
        assert env["data"]["closed"] is True
        out = (repo / "docs" / "harness" / "pipeline" / "runs"
               / ("%s.md" % run_id)).read_text(encoding="utf-8")
        assert "두 번째 판" in out
        _p, s = st.load(repo, run_id)
        assert s["run_status"] == st.DONE
        kinds = [json.loads(x)["kind"] for x
                 in paths.events.read_text(encoding="utf-8").splitlines() if x.strip()]
        assert kinds.count("run_closed") == 1, "두 번 닫히지 않는다"

    def test_07_이_안_끝났으면_보고서만_쓰고_닫지_않는다(self, repo, request_file,
                                                      phases):
        """전이 조건은 08 자신의 `requires` 다. 없으면 03 에서 부른 report 가
        런을 닫아 버린다."""
        run_id, paths = _enter_08(repo, request_file, phases)
        _p, s = st.load(repo, run_id)
        st.set_phase_status(s, "07-pr-review", "running")
        st.save(_p, s)
        _report_data(paths)
        env = cli.run_report(repo, run_id=run_id)
        assert env["exit"] == 0
        assert env["data"]["closed"] is False
        assert (repo / "docs" / "harness" / "pipeline" / "runs"
                / ("%s.md" % run_id)).exists(), "보고서는 그래도 쓴다"
        _p, s = st.load(repo, run_id)
        assert s["run_status"] == "active"
        assert st.phase_status(s, "08-report") != "passed"

    def test_닫힌_런은_latest_run_id_에서_빠진다(self, repo, request_file, phases):
        """`state.py` 의 `!= "done"` 필터에 드디어 생산자가 생긴다."""
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        cli.run_report(repo, run_id=run_id)
        # 살아 있는 런이 하나라도 있으면 닫힌 런은 뽑히지 않는다.
        other, _ = st.create_run(repo, "other", request_file)
        assert st.latest_run_id(repo) == other.run_id

    def test_run_closed_이벤트가_등급과_gaps_를_담는다(self, repo, request_file,
                                                     phases):
        run_id, paths = _enter_08(repo, request_file, phases,
                                  grade="PASS_WITH_GAPS")
        _p, s = st.load(repo, run_id)
        s["gaps"] = ["stage_absent:e2e"]
        st.save(_p, s)
        _report_data(paths)
        cli.run_report(repo, run_id=run_id)
        ev = [json.loads(x) for x
              in paths.events.read_text(encoding="utf-8").splitlines() if x.strip()]
        closed = [e for e in ev if e["kind"] == "run_closed"]
        assert len(closed) == 1
        assert closed[0]["data"]["grade"] == "PASS_WITH_GAPS"
        assert closed[0]["data"]["gaps"] == ["stage_absent:e2e"]

    def test_닫힌_런에_advance_는_전이하지_않는다(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        cli.run_report(repo, run_id=run_id)
        env = cli.run_advance(repo, "08", run_id=run_id)
        assert env["exit"] == 0
        assert env["data"]["closed"] is True
        ev = [json.loads(x) for x
              in paths.events.read_text(encoding="utf-8").splitlines() if x.strip()]
        assert len([e for e in ev if e["kind"] == "phase_pass"
                    and e.get("phase") == "08-report"]) == 1

    def test_record_08_은_report_로_안내한다(self, repo, request_file, phases):
        """"미구현" 이라고 말하던 자리다 — 구현돼 있고 동사가 다를 뿐이다."""
        run_id, paths = _enter_08(repo, request_file, phases)
        src = _report_data(paths)
        env = cli.run_record(repo, "08", str(src), run_id=run_id)
        assert env["exit"] == 2
        assert "report" in env["render"]
        assert "미구현" not in env["render"]

    def test_gaps_가_건너뛴_게이트로_나열된다(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases,
                                  grade="PASS_WITH_GAPS")
        _p, s = st.load(repo, run_id)
        s["gaps"] = ["stage_absent:e2e", "adapter_unverified"]
        st.save(_p, s)
        _report_data(paths)
        cli.run_report(repo, run_id=run_id)
        out = (repo / "docs" / "harness" / "pipeline" / "runs"
               / ("%s.md" % run_id)).read_text(encoding="utf-8")
        assert "stage_absent:e2e" in out
        assert "adapter_unverified" in out

    def test_모델_호출_수는_근사로_표기된다(self, repo, request_file, phases):
        run_id, paths = _enter_08(repo, request_file, phases)
        _report_data(paths)
        cli.run_report(repo, run_id=run_id)
        out = (repo / "docs" / "harness" / "pipeline" / "runs"
               / ("%s.md" % run_id)).read_text(encoding="utf-8")
        assert "근사" in out


# ---------------------------------------------------------------------------
# T. doctor — 06 이 exit 9 로 멈출 것을 기동 전에, 무료로 알려 준다
# ---------------------------------------------------------------------------


class TestDoctorRemote:

    def test_원격이_없으면_WARN_이고_막지는_않는다(self, repo):
        """원격 없이 로컬까지만 가는 것도 정당한 선택이고, 그 선택은 사람의 것이다."""
        config = harness._read_json(repo / harness.CONFIG_REL)
        got = cli._check_remote(repo, config)
        assert got["status"] == "WARN"
        assert "3지선다" in got["message"]

    def test_원격과_base_가_있으면_PASS(self, repo, tmp_path):
        _branch(repo, "feat-x")
        _remote(repo, tmp_path)
        config = harness._read_json(repo / harness.CONFIG_REL)
        got = cli._check_remote(repo, config)
        assert got["status"] == "PASS"

    def test_실물_리포에서_원격_검사가_통과한다(self):
        config = harness._read_json(ROOT / harness.CONFIG_REL)
        got = cli._check_remote(ROOT, config)
        assert got["status"] == "PASS", got["message"]


class TestDoctorExternalBot:

    def test_꺼져_있으면_PASS_이고_그_이유를_적는다(self, repo):
        config = harness._read_json(repo / harness.CONFIG_REL)
        got = cli._check_external_bot(config)
        assert got["status"] == "PASS"
        assert "내장 리뷰가 항상" in got["message"]

    def test_켜_놓고_대상이_없으면_FAIL(self, repo):
        _enable_bot(repo, bot_logins=[])
        config = harness._read_json(repo / harness.CONFIG_REL)
        got = cli._check_external_bot(config)
        assert got["status"] == "FAIL"
        assert "기다린다" in got["message"]

    def test_상속값임을_메시지가_밝힌다(self, repo):
        _enable_bot(repo)
        config = harness._read_json(repo / harness.CONFIG_REL)
        got = cli._check_external_bot(config)
        assert got["status"] == "PASS"
        assert "미검증 상속값" in got["message"]


class TestChangelogHeader:

    def test_표_헤더가_산문이_나열한_열_개와_맞는다(self):
        """산문은 열 개를 나열하는데 표 헤더는 아홉이었다 — 철회 사유가 없었다."""
        import ledger as L
        head = [l for l in L.CHANGELOG_HEADER.splitlines()
                if l.startswith("| 날짜")]
        assert head, L.CHANGELOG_HEADER
        cols = [c for c in head[0].split("|") if c.strip()]
        assert len(cols) == 10, cols
        assert "철회 사유" in head[0]

    def test_실물_changelog_도_같은_헤더다(self):
        p = (ROOT / "docs" / "harness" / "pipeline" / "ledger"
             / "rules_changelog.md")
        assert "철회 사유" in p.read_text(encoding="utf-8")


class TestHorizonRender:

    def test_다음이_없으면_런_완료라고_말한다(self):
        got = cli._horizon_render(None)
        assert "런 완료" in got

    def test_범위를_문자열로_박지_않고_페이즈에서_유도한다(self):
        loaded, _broken = cli.load_phases(ROOT)
        got = cli._horizon_render("09-nope", loaded)
        assert "01-plan" in got and "08-report" in got
        assert "01~04" not in got
