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
