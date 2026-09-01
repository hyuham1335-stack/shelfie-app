#!/usr/bin/env python3
"""scripts/harness.py — init · doctor 단위 테스트.

ROADMAP 1단계 게이트 G1: "일부러 깨뜨린 config를 doctor가 전부 거부하는가."
거부만 검사하면 절반이다. 정상 config가 전부에서 통과하는 것(오탐 없음)까지 같이 본다.

각 테스트는 tmpdir에 최소 리포를 세우고 그 위에서 doctor를 돌린다.
스키마·어댑터·계약 템플릿은 실물을 복사하므로, 실물이 바뀌면 이 테스트가 먼저 깨진다.
"""

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import harness  # noqa: E402


# 실물에서 픽스처로 복사하는 파일들 — 하네스 계층의 정본
COPIED = [
    "harness/config.schema.json",
    "harness/adapters/adapter.schema.json",
    "harness/adapters/nextjs-ts.json",
    "harness/templates/contract.md",
    "harness/config.json",
    "harness/profiles/nextjs-ts/config.json",
]

# 어댑터가 `run <script>` 로 참조하는 스크립트가 전부 들어 있어야 한다
FIXTURE_PACKAGE_JSON = {
    "name": "fixture",
    "private": True,
    "scripts": {
        "dev": "next dev",
        "typecheck": "tsc --noEmit",
        "lint": "eslint .",
        "test": "vitest run",
        "build": "next build",
        "audit": "npm audit --audit-level=high",
    },
}

# 역할 소유 경계가 실제로 갈리는지 보려면 impl 파일과 test 파일이 둘 다 있어야 한다
FIXTURE_SOURCES = [
    "src/app/page.tsx",
    "src/app/api/analyze/route.ts",
    "src/components/upload/Picker.tsx",
    "src/lib/match.ts",
    "src/lib/match.test.ts",
    "src/services/aladin.ts",
    "src/types/book.ts",
]


def _write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _build_fixture(root: Path):
    for rel in COPIED:
        dst = root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, dst)
    _write(root / "package.json", json.dumps(FIXTURE_PACKAGE_JSON, indent=2) + "\n")
    _write(root / "CLAUDE.md", "# fixture\n")
    for rel in FIXTURE_SOURCES:
        _write(root / rel, "// fixture\n")


class DoctorTestBase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "repo"
        _build_fixture(self.root)

    def tearDown(self):
        self._tmp.cleanup()

    # --- 픽스처 조작 ---

    def _load(self, rel):
        return json.loads((self.root / rel).read_text(encoding="utf-8"))

    def _save(self, rel, data):
        _write(self.root / rel, json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    def config(self):
        return self._load("harness/config.json")

    def save_config(self, cfg):
        self._save("harness/config.json", cfg)

    def adapter(self):
        return self._load("harness/adapters/nextjs-ts.json")

    def save_adapter(self, ad):
        self._save("harness/adapters/nextjs-ts.json", ad)

    # --- 실행 & 단언 ---

    def doctor(self):
        return harness.run_doctor(self.root)

    def assertRejected(self, report, needle):
        self.assertEqual(2, report.exit_code, "거부되지 않았다:\n" + report.text())
        hit = any(needle in c.message or needle in c.name for c in report.failures)
        self.assertTrue(hit, "실패 사유에 %r 가 없다:\n%s" % (needle, report.text()))


class BaselinePassesTest(DoctorTestBase):
    """정상 config는 통과해야 한다 — 오탐 검사."""

    def test_clean_config_passes(self):
        report = self.doctor()
        self.assertEqual(0, report.exit_code, report.text())
        self.assertEqual([], report.failures, report.text())

    def test_null_cmd_stages_are_reported_not_silently_passed(self):
        """cmd: null 스테이지는 '없는 것'이지 '통과한 것'이 아니다."""
        text = self.doctor().text()
        for stage in ("e2e", "docs"):
            self.assertIn(stage, text, "%s 스킵이 보고되지 않았다:\n%s" % (stage, text))

    def test_unverified_adapter_and_missing_calibration_warn(self):
        report = self.doctor()
        warn_text = "\n".join(c.message for c in report.checks if c.status == "WARN")
        self.assertIn("verified", warn_text, report.text())
        self.assertIn("캘리브레이션", warn_text, report.text())


class BrokenConfigRejectedTest(DoctorTestBase):
    """G1 — 깨뜨린 config 8종을 전부 거부하는가."""

    def test_1_role_ownership_overlap(self):
        cfg = self.config()
        for role in cfg["roles"]:
            role.pop("excludes", None)
        self.save_config(cfg)
        self.assertRejected(self.doctor(), "src/lib/match.test.ts")

    def test_2_contract_section_mismatch(self):
        cfg = self.config()
        cfg["contract"]["sections"]["units"] = "## 존재하지않는절"
        self.save_config(cfg)
        self.assertRejected(self.doctor(), "## 존재하지않는절")

    def test_3_runner_bin_not_whitelisted(self):
        ad = self.adapter()
        ad["runner"]["bin"] = "sh"
        self.save_adapter(ad)
        self.assertRejected(self.doctor(), "sh")

    def test_4_stage_cmd_references_missing_script(self):
        ad = self.adapter()
        ad["stages"]["compile"]["cmd"] = ["run", "nonexistent"]
        self.save_adapter(ad)
        self.assertRejected(self.doctor(), "nonexistent")

    def test_5_adapter_requires_unmet(self):
        pkg = self._load("package.json")
        del pkg["scripts"]["test"]
        self._save("package.json", pkg)
        self.assertRejected(self.doctor(), "scripts.test")

    def test_6_schema_type_violation(self):
        cfg = self.config()
        cfg["budget"]["files_max"] = "10"
        self.save_config(cfg)
        self.assertRejected(self.doctor(), "budget.files_max")

    def test_7_unknown_adapter_id(self):
        cfg = self.config()
        cfg["adapter"] = "does-not-exist"
        self.save_config(cfg)
        self.assertRejected(self.doctor(), "does-not-exist")

    def test_8_main_owned_overlaps_role_owned(self):
        cfg = self.config()
        cfg["main_owned_paths"].append("src/lib/**")
        self.save_config(cfg)
        self.assertRejected(self.doctor(), "src/lib/match.ts")

    # --- 부수 거부 케이스 ---

    def test_primary_role_must_exist(self):
        cfg = self.config()
        cfg["primary_role"] = "nope"
        self.save_config(cfg)
        self.assertRejected(self.doctor(), "primary_role")

    def test_missing_config_file(self):
        (self.root / "harness/config.json").unlink()
        self.assertRejected(self.doctor(), "harness/config.json")

    def test_malformed_json_is_rejected(self):
        _write(self.root / "harness/config.json", "{ not json")
        self.assertRejected(self.doctor(), "harness/config.json")

    def test_unowned_source_file_is_surfaced(self):
        """어느 역할도 소유하지 않는 소스 파일은 조용히 넘어가지 않는다."""
        _write(self.root / "src/orphan/stray.ts", "// fixture\n")
        self.assertIn("src/orphan/stray.ts", self.doctor().text())


class SchemaValidatorTest(unittest.TestCase):
    """스키마에 적었는데 검사되지 않는 규칙 = 이 계층에서 가장 위험한 조용한 통과."""

    def test_unsupported_keyword_raises(self):
        with self.assertRaises(harness.SchemaError):
            harness.validate({"a": 1}, {"type": "object", "oneOf": [{}]})

    def test_underscore_keys_allowed_under_additional_properties_false(self):
        schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {"a": {"type": "integer"}},
        }
        self.assertEqual([], harness.validate({"a": 1, "_note": "주석"}, schema))
        self.assertNotEqual([], harness.validate({"a": 1, "b": 2}, schema))

    def test_type_list_and_null(self):
        schema = {"type": ["array", "null"], "items": {"type": "string"}}
        self.assertEqual([], harness.validate(None, schema))
        self.assertEqual([], harness.validate(["x"], schema))
        self.assertNotEqual([], harness.validate([1], schema))

    def test_bool_is_not_integer(self):
        self.assertNotEqual([], harness.validate(True, {"type": "integer"}))

    def test_local_ref(self):
        schema = {
            "definitions": {"n": {"type": "integer", "minimum": 1}},
            "type": "object",
            "properties": {"x": {"$ref": "#/definitions/n"}},
        }
        self.assertEqual([], harness.validate({"x": 3}, schema))
        self.assertNotEqual([], harness.validate({"x": 0}, schema))

    def test_error_path_points_at_the_offending_key(self):
        schema = {
            "type": "object",
            "properties": {"budget": {"type": "object", "properties": {"files_max": {"type": "integer"}}}},
        }
        errs = harness.validate({"budget": {"files_max": "10"}}, schema)
        self.assertTrue(any("budget.files_max" in e for e in errs), errs)


class GlobTest(unittest.TestCase):
    """소유 경계 판정이 이 함수 하나에 달려 있다."""

    def assertMatch(self, pattern, path, expected=True):
        self.assertEqual(expected, harness.glob_match(pattern, path), "%s vs %s" % (pattern, path))

    def test_double_star(self):
        self.assertMatch("src/lib/**", "src/lib/match.ts")
        self.assertMatch("src/lib/**", "src/lib/deep/nested.ts")
        self.assertMatch("src/lib/**", "src/app/page.tsx", False)

    def test_leading_double_star(self):
        self.assertMatch("**/*.test.ts", "src/lib/match.test.ts")
        self.assertMatch("**/*.test.ts", "match.test.ts")
        self.assertMatch("**/*.test.ts", "src/lib/match.ts", False)

    def test_single_star_does_not_cross_slash(self):
        self.assertMatch("src/*.ts", "src/a.ts")
        self.assertMatch("src/*.ts", "src/lib/a.ts", False)

    def test_dotted_pattern(self):
        self.assertMatch("*.config.*", "vitest.config.ts")
        self.assertMatch("*.config.*", "src/vitest.config.ts", False)

    def test_exact_path(self):
        self.assertMatch("package.json", "package.json")
        self.assertMatch("package.json", "sub/package.json", False)


class InitTest(DoctorTestBase):
    def test_refuses_to_overwrite_existing_config(self):
        self.assertEqual(2, harness.run_init(self.root, adapter="nextjs-ts", name="shelfie"))

    def test_creates_config_from_profile_seed(self):
        target = self.root / "harness/config.json"
        target.unlink()
        self.assertEqual(0, harness.run_init(self.root, adapter="nextjs-ts", name="bookshelf"))
        raw = target.read_text(encoding="utf-8")
        cfg = json.loads(raw)
        self.assertEqual("bookshelf", cfg["project"]["name"])
        self.assertEqual("nextjs-ts", cfg["adapter"])
        self.assertNotIn("{{", raw)

    def test_seeded_config_passes_doctor(self):
        """시드가 doctor를 통과하지 못하면 init은 깨진 리포를 만드는 것이다."""
        (self.root / "harness/config.json").unlink()
        harness.run_init(self.root, adapter="nextjs-ts", name="bookshelf")
        report = self.doctor()
        self.assertEqual(0, report.exit_code, report.text())

    def test_force_overwrites(self):
        self.assertEqual(0, harness.run_init(self.root, adapter="nextjs-ts", name="other", force=True))
        self.assertEqual("other", self.config()["project"]["name"])

    def test_unknown_adapter_refused(self):
        (self.root / "harness/config.json").unlink()
        self.assertEqual(2, harness.run_init(self.root, adapter="nope", name="x"))

    def test_invalid_name_refused(self):
        (self.root / "harness/config.json").unlink()
        self.assertEqual(2, harness.run_init(self.root, adapter="nextjs-ts", name="Not A Slug"))


JUNIT_FIXTURE = """<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="203" failures="0" errors="0" time="0.22">
  <testsuite name="a.test.ts" tests="120" failures="0" errors="0" />
  <testsuite name="b.test.ts" tests="83" failures="0" errors="0" />
</testsuites>
"""


class CalibrateTest(DoctorTestBase):
    """실측이 정책의 입력이 되므로, 재지 않은 것을 잰 척하는 경로가 하나도 없어야 한다."""

    def setUp(self):
        super().setUp()
        _write(self.root / "reports/junit/vitest.xml", JUNIT_FIXTURE)

    def fake_runner(self, durations=None, failing=None):
        """(stage, cmd, cwd, timeout) -> (exit_code, seconds). 실제 npm 을 돌리지 않는다."""
        durations = durations or {}
        failing = set(failing or [])
        calls = []

        def run(stage, cmd, cwd, timeout_sec):
            calls.append((stage, tuple(cmd)))
            return (1 if stage in failing else 0), durations.get(stage, 1.0)

        run.calls = calls
        return run

    def load(self):
        return json.loads((self.root / "harness/calibration.json").read_text(encoding="utf-8"))

    # --- 기본 동작 ---

    def test_writes_calibration_file(self):
        code = harness.run_calibrate(self.root, runner=self.fake_runner({"full": 4.7}))
        self.assertEqual(0, code)
        data = self.load()
        self.assertEqual("nextjs-ts", data["adapter"])
        self.assertIn("measured_at", data)
        self.assertEqual(4.7, data["stages"]["full"]["sec"])
        self.assertTrue(data["stages"]["full"]["ok"])

    def test_null_cmd_stage_is_skipped_not_measured(self):
        runner = self.fake_runner()
        harness.run_calibrate(self.root, runner=runner)
        for stage in ("e2e", "docs"):
            entry = self.load()["stages"][stage]
            self.assertIsNone(entry["sec"])
            self.assertTrue(entry["skipped"])
            self.assertIn("cmd:null", entry["reason"])
        ran = set(stage for stage, _ in runner.calls)
        self.assertNotIn("e2e", ran)
        self.assertNotIn("docs", ran)

    def test_scoped_is_skipped_without_select(self):
        harness.run_calibrate(self.root, runner=self.fake_runner())
        entry = self.load()["stages"]["scoped"]
        self.assertIsNone(entry["sec"])
        self.assertTrue(entry["skipped"])
        self.assertIn("선택 대상", entry["reason"])

    def test_scoped_is_measured_with_select(self):
        runner = self.fake_runner({"scoped": 2.0})
        harness.run_calibrate(self.root, runner=runner, select="정규화")
        entry = self.load()["stages"]["scoped"]
        self.assertEqual(2.0, entry["sec"])
        self.assertFalse(entry.get("skipped", False))
        scoped_cmd = next(cmd for stage, cmd in runner.calls if stage == "scoped")
        self.assertIn("-t", scoped_cmd)
        self.assertIn("정규화", scoped_cmd)

    def test_single_stage_only(self):
        runner = self.fake_runner()
        harness.run_calibrate(self.root, stage="lint", runner=runner)
        self.assertEqual({"lint"}, set(stage for stage, _ in runner.calls))

    def test_runner_bin_is_resolved_to_a_real_path(self):
        """Windows 에서 npm 은 npm.cmd 다.

        shutil.which 가 찾았다고 subprocess 가 bare name 으로 띄울 수 있는 것이
        아니다 — 해석된 경로를 argv[0] 에 넣어야 한다. shell=True 는 쓰지 않는다:
        러너 화이트리스트가 막으려는 임의 명령 실행 벡터가 되살아난다.
        """
        original = harness.shutil.which
        harness.shutil.which = lambda name: "C:\\fake\\npm.cmd" if name == "npm" else original(name)
        try:
            runner = self.fake_runner()
            harness.run_calibrate(self.root, stage="lint", runner=runner)
        finally:
            harness.shutil.which = original
        argv = next(cmd for stage, cmd in runner.calls if stage == "lint")
        self.assertEqual("C:\\fake\\npm.cmd", argv[0])

    def test_unresolvable_bin_blocks_before_running_anything(self):
        """해석되지 않는 러너는 doctor 가 먼저 막는다 — 잴 기회조차 오지 않는다.

        _resolve_bin 이 bare name 을 그대로 돌려주는 것이 곧 '못 찾았다'는 신호이고,
        doctor 의 러너 검사가 그 신호를 FAIL 로 바꾼다.
        """
        original = harness.shutil.which
        harness.shutil.which = lambda name: None
        try:
            self.assertEqual("npm", harness._resolve_bin(self.root, "npm"))
            runner = self.fake_runner()
            code = harness.run_calibrate(self.root, stage="lint", runner=runner)
        finally:
            harness.shutil.which = original
        self.assertEqual(2, code)
        self.assertEqual([], runner.calls)

    # --- 실패한 트리에서 잰 값은 캘리브레이션이 아니다 ---

    def test_failing_stage_exits_10_and_writes_nothing(self):
        code = harness.run_calibrate(self.root, runner=self.fake_runner(failing={"lint"}))
        self.assertEqual(10, code)
        self.assertFalse(
            (self.root / "harness/calibration.json").exists(),
            "빨간 트리에서 잰 값이 근거로 커밋되면 안 된다",
        )

    def test_refuses_when_doctor_fails(self):
        cfg = self.config()
        cfg["adapter"] = "does-not-exist"
        self.save_config(cfg)
        code = harness.run_calibrate(self.root, runner=self.fake_runner())
        self.assertEqual(2, code)
        self.assertFalse((self.root / "harness/calibration.json").exists())

    # --- junit 파싱 ---

    def test_parses_junit_report(self):
        harness.run_calibrate(self.root, runner=self.fake_runner({"full": 4.7}))
        full = self.load()["stages"]["full"]
        self.assertEqual(203, full["tests_ran"])
        self.assertEqual(2, full["suites"])
        self.assertEqual(0, full["failures"])

    def test_missing_report_is_recorded_as_unmatched(self):
        (self.root / "reports/junit/vitest.xml").unlink()
        harness.run_calibrate(self.root, runner=self.fake_runner())
        data = self.load()
        self.assertFalse(data["report_glob_matched"])
        self.assertIsNone(data["stages"]["full"]["tests_ran"])

    # --- 정책은 상수가 아니라 캘리브레이션의 함수다 ---

    def test_derived_policy_short_suite(self):
        harness.run_calibrate(self.root, runner=self.fake_runner({"full": 4.7}))
        d = self.load()["derived"]
        self.assertFalse(d["background_full_regression"])
        self.assertEqual(300, d["full_timeout_sec"])
        self.assertEqual(182, d["tests_ran_floor"])

    def test_derived_policy_long_suite(self):
        harness.run_calibrate(self.root, runner=self.fake_runner({"full": 500.0}))
        d = self.load()["derived"]
        self.assertTrue(d["background_full_regression"])
        self.assertEqual(2000, d["full_timeout_sec"])

    # --- 시크릿 유출 차단 ---

    def test_env_probe_records_presence_not_value(self):
        import os

        os.environ["ANTHROPIC_API_KEY"] = "sk-secret-value-do-not-leak"
        try:
            harness.run_calibrate(self.root, runner=self.fake_runner())
        finally:
            del os.environ["ANTHROPIC_API_KEY"]
        raw = (self.root / "harness/calibration.json").read_text(encoding="utf-8")
        self.assertNotIn("sk-secret-value-do-not-leak", raw)
        self.assertIs(True, self.load()["infra"]["anthropic_key"])

    # --- doctor 연동 ---

    def test_doctor_stops_warning_once_calibrated(self):
        before = "\n".join(c.message for c in self.doctor().checks if c.status == "WARN")
        self.assertIn("캘리브레이션", before)

        harness.run_calibrate(self.root, runner=self.fake_runner({"full": 4.7}))

        report = self.doctor()
        self.assertEqual(0, report.exit_code, report.text())
        calibration = next(c for c in report.checks if c.name == "캘리브레이션 상태")
        self.assertEqual("PASS", calibration.status, report.text())
        # 어댑터 검증과 캘리브레이션은 다른 것이다 — verified:false 경고는 남는다
        warns = "\n".join(c.message for c in report.checks if c.status == "WARN")
        self.assertIn("verified", warns)


class RealRepoTest(unittest.TestCase):
    """실물 리포에서도 통과해야 한다 — 픽스처만 통과하는 것은 의미가 없다."""

    def test_doctor_passes_on_this_repo(self):
        report = harness.run_doctor(ROOT)
        self.assertEqual(0, report.exit_code, report.text())

    def test_cli_exit_code(self):
        r = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "harness.py"), "doctor"],
            cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8",
        )
        self.assertEqual(0, r.returncode, (r.stdout or "") + (r.stderr or ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
