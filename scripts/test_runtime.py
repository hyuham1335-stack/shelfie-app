"""`scripts/runtime.py` — 코어와 실행기가 함께 쓰는 원시요소의 테스트.

**여기 있는 것은 전부 `test_execute.py` 에서 옮겨 온 것이다.** 옮긴 이유는
질문이 바뀌어서가 아니라 **답하는 코드의 주소가 바뀌어서**다 — 트랜스크립트
읽기와 출력 인코딩은 순차 실행기의 것이 아니라 코어의 것이고, 코어가
실행기를 import 하는 한 8페이즈 코어를 실행기 없이 떼어 낼 수 없다.

그래서 **본문은 한 줄도 안 고쳤다.** 바뀐 것은 부르는 이름뿐이다
(`rt.read_cost_state` → `rt.read_cost_state`).
"""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import runtime as rt


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

        with patch.object(rt.sys, "stdout", FakeStream()), \
             patch.object(rt.sys, "stderr", FakeStream()):
            rt.force_utf8_output()

        assert len(calls) == 2
        for kwargs in calls:
            assert kwargs["encoding"] == "utf-8"
            assert kwargs["errors"] == "replace"

    def test_stream_without_reconfigure_is_tolerated(self):
        import io as _io
        with patch.object(rt.sys, "stdout", _io.StringIO()), \
             patch.object(rt.sys, "stderr", _io.StringIO()):
            rt.force_utf8_output()

    def test_reconfigure_failure_is_tolerated(self):
        class Hostile:
            def reconfigure(self, **kwargs):
                raise ValueError("detached")

        with patch.object(rt.sys, "stdout", Hostile()), \
             patch.object(rt.sys, "stderr", Hostile()):
            rt.force_utf8_output()


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
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
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
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
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
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
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
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_chars"] == 100
        assert m["tool_result_count"] == 1

    def test_missing_transcript_yields_nothing(self, transcripts):
        """0 으로 채우면 '재지 않았다'와 '0 이었다'가 같은 칸에 들어간다 (ADR-H007)."""
        assert rt.read_session_metrics("nope", transcript_root=transcripts) == {}

    def test_missing_session_id_yields_nothing(self, transcripts):
        assert rt.read_session_metrics(None, transcript_root=transcripts) == {}
        assert rt.read_session_metrics("", transcript_root=transcripts) == {}

    def test_broken_lines_are_skipped_not_fatal(self, transcripts):
        p = transcripts / "C--some-slug" / "abc.jsonl"
        _jsonl(p, [_tool_use("Bash", "t1"), _tool_result("가" * 40, "t1")])
        p.write_text(p.read_text(encoding="utf-8") + "\n{not json\n", encoding="utf-8")
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_chars"] == 40

    def test_finds_transcript_under_any_slug(self, transcripts):
        """슬러그를 유도하지 않는다 — 이 리포는 경로 casing 함정에 두 번 물렸다.

        session_id 는 UUID 라 glob 하나로 유일하게 잡힌다.
        """
        (transcripts / "C--Users-hyu13-PROJECT-x").mkdir()
        _jsonl(transcripts / "C--Users-hyu13-PROJECT-x" / "zzz.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("y" * 77, "t1"),
        ])
        m = rt.read_session_metrics("zzz", transcript_root=transcripts)
        assert m["tool_result_chars"] == 77

    # --- 합계에서 분포로 (PILOT-LOG "다음에 볼 것" 1번) ---------------------
    #
    # 끌어온 양 ↔ 비용 r=0.752 는 합계가 후보 눈금이라는 뜻이지 예산이라는
    # 뜻이 아니다. 같은 양(≈79,800자)을 끌어온 두 step 이 22 turn 과 44 turn
    # 으로 갈렸다 — booklist-props 와 request-contract. 합계와 건수로는 그
    # 차이를 볼 수 없고, tool_result_count 는 15 step 전부에서 turns-1 이라
    # 새 정보도 아니다. 새 정보는 **한 호출이 얼마나 큰가**와 **그 중 몇 자가
    # 이미 왔던 것인가**뿐이다.

    def test_percentiles_are_observed_values_not_interpolated(self, transcripts):
        """유도된 값이 원자료로 오해되지 않게 한다.

        보간하면 관측된 적 없는 숫자가 칸에 앉는다. 최근접 순위로 뽑아
        **실제로 온 결과 하나**를 돌려준다 — 100 과 300 의 p50 은 200 이
        아니라 100 이다.
        """
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("a" * 100, "t1"),
            _tool_use("Bash", "t2"), _tool_result("b" * 300, "t2"),
        ])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_p50"] == 100
        assert m["tool_result_max"] == 300

    def test_percentiles_split_a_wide_distribution(self, transcripts):
        recs = []
        for i in range(1, 11):
            recs += [_tool_use("Bash", f"t{i}"), _tool_result("x" * (i * 100), f"t{i}")]
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", recs)
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert (m["tool_result_p50"], m["tool_result_p90"], m["tool_result_max"])             == (500, 900, 1000)

    def test_single_result_collapses_the_percentiles(self, transcripts):
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("z" * 640, "t1"),
        ])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_p50"] == m["tool_result_p90"] == m["tool_result_max"] == 640

    def test_repeat_counts_only_the_second_and_later_arrivals(self, transcripts):
        """같은 것을 또 끌어온 몫. 첫 등장은 반복이 아니다.

        ADR-H009 가 "읽기 336회 중 80회(22%)는 이미 읽은 파일을 또 읽은
        것"이라 적은 그 숫자를, 도구 이름이 아니라 **내용**으로 잰다.
        """
        same = "같은 결과" * 20   # 100자
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result(same, "t1"),
            _tool_use("Bash", "t2"), _tool_result("다른 것" * 10, "t2"),
            _tool_use("Bash", "t3"), _tool_result(same, "t3"),
        ])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_repeat_count"] == 1
        assert m["tool_result_repeat_chars"] == 100

    def test_three_identical_results_count_two_repeats(self, transcripts):
        same = "가" * 50
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result(same, "t1"),
            _tool_use("Bash", "t2"), _tool_result(same, "t2"),
            _tool_use("Bash", "t3"), _tool_result(same, "t3"),
        ])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_repeat_count"] == 2
        assert m["tool_result_repeat_chars"] == 100

    def test_no_duplicates_means_zero_repeat(self, transcripts):
        """0 과 미측정을 가른다 — 여기서는 **잰 결과가 0** 이므로 칸이 있어야 한다."""
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("가" * 40, "t1"),
            _tool_use("Bash", "t2"), _tool_result("나" * 40, "t2"),
        ])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_repeat_count"] == 0
        assert m["tool_result_repeat_chars"] == 0

    def test_empty_results_are_not_repeats_of_each_other(self, transcripts):
        """빈 결과가 서로의 중복으로 세어지면 재수신 건수가 거짓말을 한다."""
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("", "t1"),
            _tool_use("Bash", "t2"), _tool_result("", "t2"),
            _tool_use("Bash", "t3"), _tool_result("", "t3"),
        ])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_count"] == 3
        assert m["tool_result_repeat_count"] == 0

    def test_no_tool_results_yields_no_distribution_keys(self, transcripts):
        """결과가 0 건이면 분포 칸을 만들지 않는다.

        0 으로 채우면 "한 번도 안 끌어왔다"와 "안 쟀다"가 같은 칸에
        들어간다 — ADR-H007 이 attempts 에서 겪은 실패다.
        """
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [_tool_use("Bash", "t1")])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_count"] == 0
        for key in ("tool_result_p50", "tool_result_p90", "tool_result_max",
                    "tool_result_repeat_chars", "tool_result_repeat_count"):
            assert key not in m

    def test_sidechain_results_stay_out_of_the_distribution(self, transcripts):
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("가" * 100, "t1"),
            _tool_result("나" * 90000, "t2", sidechain=True),
        ])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_max"] == 100

    def test_broken_lines_do_not_poison_the_distribution(self, transcripts):
        p = transcripts / "C--some-slug" / "abc.jsonl"
        _jsonl(p, [_tool_use("Bash", "t1"), _tool_result("가" * 40, "t1")])
        p.write_text(p.read_text(encoding="utf-8") + chr(10) + "{not json" + chr(10),
                     encoding="utf-8")
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_max"] == 40
        assert m["tool_result_repeat_count"] == 0

    def test_list_shaped_result_content_is_counted(self, transcripts):
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"),
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1",
                 "content": [{"type": "text", "text": "가" * 30}]}]}},
        ])
        m = rt.read_session_metrics("abc", transcript_root=transcripts)
        assert m["tool_result_chars"] == 30

def _cost_state(usd=1.5, models=None, **kw):
    """트랜스크립트 끝에 실제로 있는 레코드의 모양."""
    rec = {"type": "cost-state", "totalCostUSD": usd,
           "totalAPIDuration": 1000, "totalDuration": 2000,
           "hasUnknownModelCost": False,
           "modelUsage": models if models is not None else {
               "claude-opus-5[1m]": {
                   "inputTokens": 10, "outputTokens": 20, "thinkingTokens": 5,
                   "cacheReadInputTokens": 300, "cacheCreationInputTokens": 40,
                   "webSearchRequests": 0, "costUSD": usd}}}
    rec.update(kw)
    return rec


class TestCostState:
    """세션 누적 비용은 트랜스크립트의 `cost-state` 레코드에 이미 있다.

    **서브에이전트를 포함한다** — 43개 트랜스크립트로 갈랐다. 서브에이전트가
    0개인 세션 다섯에서 메인 트랜스크립트만으로 `modelUsage` 와 정확히
    일치하고(예 outputTokens 13,343 = 13,343), 서브에이전트가 있는 세션에서는
    메인만으로 크게 모자란다. 포함하지 않는다면 뒤쪽도 일치해야 한다.

    **트랜스크립트 재구성을 대조 장치로 짓지 않는다.** 서브에이전트 jsonl 은
    `apiBlockIndex` 로 쪼갠 부분 usage 를 담고, `modelUsage` 에는 트랜스크립트에
    레코드조차 없는 haiku 부수 호출이 있다 — 재구성값은 신뢰할 수 없는 하한이다.
    """

    def test_마지막_cost_state_가_이긴다(self, transcripts):
        """한 파일에 두 건인 경우가 실물 43개 중 6건이다.

        누적값은 같고 `totalDuration` 만 다르다 — 뒤의 것이 그 세션의 최종이다.
        """
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _cost_state(usd=1.0), _tool_use("Bash", "t1"), _cost_state(usd=3.25),
        ])
        c = rt.read_cost_state("abc", transcript_root=transcripts)
        assert c["session_cost_usd"] == 3.25

    def test_cost_state_가_없으면_빈_dict_다(self, transcripts):
        """실물 43개 중 9개가 이 경우다 — 아직 안 끝난 세션이다.

        레코드는 트랜스크립트의 **마지막 줄**로 써지므로, 그 세션 자신의
        SessionEnd 훅은 이 값을 볼 수 없다. 0 으로 채우면 "안 잰 세션" 과
        "정말 공짜였던 세션" 이 같은 칸에 들어간다 (ADR-H007).
        """
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _tool_use("Bash", "t1"), _tool_result("x", "t1"),
        ])
        assert rt.read_cost_state(
            "abc", transcript_root=transcripts) == {}

    def test_unknown_model_cost_면_비용_대신_플래그를_적는다(self, transcripts):
        """값을 모르는 모델이 섞이면 그 합계는 비용이 아니다."""
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _cost_state(usd=9.0, hasUnknownModelCost=True),
        ])
        c = rt.read_cost_state("abc", transcript_root=transcripts)
        assert "session_cost_usd" not in c
        assert c["unknown_model_cost"] is True
        assert c["session_output_tokens"] == 20, "토큰은 그래도 잰 값이다"

    def test_토큰을_모델_넘어_합산한다(self, transcripts):
        """opus 와 haiku 가 한 세션에 섞인다 — 실물이 그렇다."""
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _cost_state(usd=2.0, models={
                "claude-opus-5[1m]": {"inputTokens": 10, "outputTokens": 20,
                                      "thinkingTokens": 5,
                                      "cacheReadInputTokens": 300,
                                      "cacheCreationInputTokens": 40,
                                      "costUSD": 1.9},
                "claude-haiku-4-5-20251001": {"inputTokens": 1, "outputTokens": 2,
                                              "thinkingTokens": 0,
                                              "cacheReadInputTokens": 0,
                                              "cacheCreationInputTokens": 0,
                                              "costUSD": 0.1}}),
        ])
        c = rt.read_cost_state("abc", transcript_root=transcripts)
        assert c["session_input_tokens"] == 11
        assert c["session_output_tokens"] == 22
        assert c["session_cache_read"] == 300
        assert c["session_cache_write"] == 40
        assert sorted(c["models"]) == ["claude-haiku-4-5-20251001",
                                       "claude-opus-5[1m]"]

    def test_모르는_필드는_그_키만_빠진다(self, transcripts):
        """`totalCostUSD` 가 문자열이면 비용만 없고 토큰은 산다."""
        _jsonl(transcripts / "C--some-slug" / "abc.jsonl", [
            _cost_state(usd="많이"),
        ])
        c = rt.read_cost_state("abc", transcript_root=transcripts)
        assert "session_cost_usd" not in c
        assert c["session_output_tokens"] == 20

    def test_깨진_줄이_나머지를_버리지_않는다(self, transcripts):
        path = transcripts / "C--some-slug" / "abc.jsonl"
        _jsonl(path, [_cost_state(usd=4.5)])
        with path.open("a", encoding="utf-8") as fh:
            # `_jsonl` 은 끝에 개행을 안 붙인다.
            fh.write("\n{ broken\n")
        c = rt.read_cost_state("abc", transcript_root=transcripts)
        assert c["session_cost_usd"] == 4.5

    def test_세션_아이디가_없으면_빈_dict_다(self, transcripts):
        assert rt.read_cost_state(
            None, transcript_root=transcripts) == {}
