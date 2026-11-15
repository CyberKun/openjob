"""Publish index-data, then have the Pages build read it back.

The Actions push used a Bearer extraheader. Git does not treat that as a
credential, so the runner asked for a username and exited 128. These tests
run the scripts the workflows call: Basic auth in the checkout style, a
non-shallow second publish, and the Pages fetch plus build-index command.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLISH = ROOT / "scripts" / "index-data-remote.sh"
FETCH = ROOT / "scripts" / "fetch-index-data.sh"
TOKEN = "fixture-index-token"
AUTH_KEY = "http.https://github.com/.extraheader"


class HeaderTests(unittest.TestCase):
    def test_basic_header_matches_checkout_and_can_be_cleared(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            subprocess.run(["git", "init", str(data)], check=True, capture_output=True, text=True)
            result = subprocess.run(
                [
                    "bash",
                    "-c",
                    'source "$1"; configure_auth "$2"; git -C "$2" config --local --get "$3"',
                    "_",
                    str(PUBLISH),
                    str(data),
                    AUTH_KEY,
                ],
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "TOKEN": TOKEN},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = [line for line in result.stdout.splitlines() if line]
            self.assertTrue(lines[0].startswith("::add-mask::"), lines[0][:12])
            masked = lines[0].removeprefix("::add-mask::")
            header = lines[1]
            self.assertEqual(header, f"AUTHORIZATION: basic {masked}")
            decoded = base64.b64decode(masked)
            self.assertEqual(decoded, b"x-access-token:" + TOKEN.encode())
            self.assertEqual(base64.b64encode(decoded).decode(), masked)
            cleared = subprocess.run(
                [
                    "bash",
                    "-c",
                    'source "$1"; clear_auth "$2"; git -C "$2" config --local --get "$3" || true',
                    "_",
                    str(PUBLISH),
                    str(data),
                    AUTH_KEY,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertEqual(cleared.stdout.strip(), "")
            config = (data / ".git" / "config").read_text(encoding="utf-8")
            self.assertNotIn(TOKEN, config)
            self.assertNotIn(masked, config)
            self.assertNotIn("AUTHORIZATION", config)


class PublishChainTests(unittest.TestCase):
    def test_first_push_creates_the_branch_and_the_second_is_a_fast_forward(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bare = root / "origin.git"
            _git("init", "--bare", "-b", "main", str(bare))
            remote = f"file://{bare}"
            env = _token_env()

            first = root / "first"
            created = _run(PUBLISH, "prepare", str(first), remote, env=env)
            self.assertIn("Starting it.", created.stdout)
            self.assertEqual(_git("-C", str(first), "rev-parse", "--is-shallow-repository").stdout.strip(), "false")
            self.assertEqual(_git("-C", str(first), "log", "-1", "--format=%s").stdout.strip(), "Start the index data branch.")
            _write_shard(first, "one")
            pushed = _run(PUBLISH, "publish", str(first), env=env)
            self.assertEqual(pushed.returncode, 0, pushed.stderr)
            self.assertNotIn(TOKEN, pushed.stdout)
            self.assertNotIn("AUTHORIZATION", (first / ".git" / "config").read_text(encoding="utf-8"))
            self.assertEqual(_count(bare), 2)

            second = root / "second"
            again = _run(PUBLISH, "prepare", str(second), remote, env=env)
            self.assertIn("Checked out index-data.", again.stdout)
            self.assertEqual(_git("-C", str(second), "rev-parse", "--is-shallow-repository").stdout.strip(), "false")
            self.assertEqual(
                _git("-C", str(second), "rev-parse", "HEAD").stdout.strip(),
                _git("--git-dir", str(bare), "rev-parse", "index-data").stdout.strip(),
            )
            tip = _git("-C", str(second), "rev-parse", "HEAD").stdout.strip()
            quiet = _run(PUBLISH, "publish", str(second), env=env)
            self.assertIn("No index changes.", quiet.stdout)
            self.assertEqual(_git("--git-dir", str(bare), "rev-parse", "index-data").stdout.strip(), tip)

            _write_shard(second, "two")
            _run(PUBLISH, "publish", str(second), env=env)
            self.assertEqual(_count(bare), 3)
            parent = _git("--git-dir", str(bare), "rev-parse", "index-data^").stdout.strip()
            self.assertEqual(parent, tip)
            messages = _git("--git-dir", str(bare), "log", "--format=%s", "index-data").stdout.splitlines()
            self.assertEqual(messages, ["Index public jobs.", "Index public jobs.", "Start the index data branch."])

    def test_a_rejected_push_still_removes_the_header(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bare = root / "origin.git"
            _git("init", "--bare", "-b", "main", str(bare))
            remote = f"file://{bare}"
            env = _token_env()
            data = root / "data"
            _run(PUBLISH, "prepare", str(data), remote, env=env)
            _write_shard(data, "one")
            _run(PUBLISH, "publish", str(data), env=env)

            other = root / "other"
            _run(PUBLISH, "prepare", str(other), remote, env=env)
            _write_shard(other, "two")
            _run(PUBLISH, "publish", str(other), env=env)

            _write_shard(data, "stale")
            rejected = _run(PUBLISH, "publish", str(data), env=env, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("[rejected]", rejected.stderr)
            self.assertIn("failed to push", rejected.stderr)
            config = (data / ".git" / "config").read_text(encoding="utf-8")
            self.assertNotIn(TOKEN, config)
            self.assertNotIn("AUTHORIZATION", config)
            self.assertNotIn("extraheader", config)

    def test_a_fetch_error_that_is_not_a_missing_branch_does_not_start_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp) / "data"
            result = _run(
                PUBLISH,
                "prepare",
                str(data),
                "file:///tmp/openjob-index-data-missing-remote.git",
                env=_token_env(),
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("Starting it.", result.stdout)
            if (data / ".git").exists():
                log = subprocess.run(
                    ["git", "-C", str(data), "log", "--oneline"],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertNotIn("Start the index data branch.", log.stdout)

    def test_publish_without_a_token_fails_before_it_pushes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bare = root / "origin.git"
            _git("init", "--bare", "-b", "main", str(bare))
            data = root / "data"
            _run(PUBLISH, "prepare", str(data), f"file://{bare}", env=_token_env())
            _write_shard(data, "one")
            env = _token_env()
            env.pop("TOKEN")
            result = _run(PUBLISH, "publish", str(data), env=env, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("TOKEN is required", result.stderr)
            missing = subprocess.run(
                ["git", "--git-dir", str(bare), "rev-parse", "--verify", "index-data"],
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(missing.returncode, 0)
            self.assertEqual(
                _git("-C", str(data), "log", "-1", "--format=%s").stdout.strip(),
                "Start the index data branch.",
            )


class PagesFetchTests(unittest.TestCase):
    def test_pages_archives_index_data_and_renders_indexed_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bare = root / "origin.git"
            _git("init", "--bare", "-b", "main", str(bare))
            remote = f"file://{bare}"
            main = root / "main"
            _git("init", "-b", "main", str(main))
            _git("-C", str(main), "config", "user.email", "t@example.com")
            _git("-C", str(main), "config", "user.name", "OpenJob Test")
            (main / "README").write_text("main\n", encoding="utf-8")
            _git("-C", str(main), "add", "README")
            _git("-C", str(main), "commit", "-m", "main")
            _git("-C", str(main), "remote", "add", "origin", remote)
            _git("-C", str(main), "push", "origin", "main")

            data = root / "data"
            _run(PUBLISH, "prepare", str(data), remote, env=_token_env())
            _write_shard(data, "live")
            _run(PUBLISH, "publish", str(data), env=_token_env())

            checkout = root / "checkout"
            _git("clone", "-q", "--depth=1", remote, str(checkout))
            self.assertEqual(_git("-C", str(checkout), "rev-parse", "--is-shallow-repository").stdout.strip(), "true")
            fetched = _run(FETCH, "index-data", cwd=checkout)
            self.assertIn("Fetched index-data", fetched.stdout)
            shard = checkout / "index-data" / "shards" / "greenhouse" / "indexfixture.json"
            self.assertTrue(shard.is_file())

            site = root / "site"
            out = site / "index.json"
            built = subprocess.run(
                [
                    _python(),
                    "-m",
                    "validator",
                    "build-index",
                    "--root",
                    str(ROOT),
                    "--out",
                    str(out),
                    "--pages",
                    str(site),
                    "--index-data",
                    str(checkout / "index-data"),
                ],
                check=False,
                capture_output=True,
                text=True,
                cwd=ROOT,
            )
            self.assertEqual(built.returncode, 0, built.stderr)
            document = json.loads(out.read_text(encoding="utf-8"))
            indexed = [post for post in document["posts"] if post.get("origin") == "indexed"]
            self.assertEqual(len(indexed), 1)
            self.assertIsNone(indexed[0]["permalink"])
            self.assertEqual(indexed[0]["title"], "Engineer")
            self.assertEqual(indexed[0]["source_url"], "https://boards.example/index-fixture-role")
            hub = (site / "c" / "indexfixture" / "index.html").read_text(encoding="utf-8")
            self.assertIn("Jobs at Index Fixture", hub)
            self.assertIn("https://boards.example/index-fixture-role", hub)
            self.assertIn("Claim this page", hub)
            self.assertNotIn("JobPosting", hub)
            home = (site / "index.html").read_text(encoding="utf-8")
            self.assertIn("https://boards.example/index-fixture-role", home)
            self.assertFalse((site / "p" / "indexed").exists())
            feed = (site / "jobs.xml").read_text(encoding="utf-8")
            self.assertNotIn("boards.example/index-fixture-role", feed)

    def test_a_missing_index_data_branch_does_not_fail_the_pages_fetch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bare = root / "origin.git"
            _git("init", "--bare", "-b", "main", str(bare))
            main = root / "main"
            _git("init", "-b", "main", str(main))
            _git("-C", str(main), "config", "user.email", "t@example.com")
            _git("-C", str(main), "config", "user.name", "OpenJob Test")
            (main / "README").write_text("main\n", encoding="utf-8")
            _git("-C", str(main), "add", "README")
            _git("-C", str(main), "commit", "-m", "main")
            _git("-C", str(main), "remote", "add", "origin", f"file://{bare}")
            _git("-C", str(main), "push", "origin", "main")
            checkout = root / "checkout"
            _git("clone", "-q", "--depth=1", f"file://{bare}", str(checkout))
            fetched = _run(FETCH, "index-data", cwd=checkout)
            self.assertIn("does not exist yet", fetched.stdout)
            self.assertTrue((checkout / "index-data").is_dir())
            self.assertEqual(list((checkout / "index-data").iterdir()), [])

    def test_a_broken_remote_fails_the_pages_fetch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            checkout = Path(tmp) / "checkout"
            _git("init", "-b", "main", str(checkout))
            _git("-C", str(checkout), "remote", "add", "origin", "file:///tmp/openjob-pages-missing-remote.git")
            result = _run(FETCH, "index-data", cwd=checkout, check=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("does not exist yet", result.stdout)


class WorkflowContractTests(unittest.TestCase):
    def test_the_workflows_call_these_scripts_and_not_bearer_auth(self) -> None:
        index = (ROOT / ".github" / "workflows" / "index.yml").read_text(encoding="utf-8")
        pages = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        publish = PUBLISH.read_text(encoding="utf-8")
        fetch = FETCH.read_text(encoding="utf-8")
        self.assertNotIn("AUTHORIZATION: bearer", index)
        self.assertNotIn("AUTHORIZATION: bearer", publish)
        self.assertNotIn("--depth=1", index)
        self.assertIn('bash repo/scripts/index-data-remote.sh prepare data "https://github.com/${GITHUB_REPOSITORY}.git"', index)
        self.assertIn("bash repo/scripts/index-data-remote.sh publish data", index)
        self.assertIn("TOKEN: ${{ github.token }}", index)
        self.assertIn("actions: write", index)
        self.assertIn('workflow_id: "pages.yml"', index)
        self.assertIn('ref: "main"', index)
        self.assertIn("bash scripts/fetch-index-data.sh index-data", pages)
        self.assertIn(
            "python -m validator build-index --root . --out site/index.json --pages site --index-data index-data",
            pages,
        )
        self.assertIn("workflow_dispatch:", pages)
        for line in publish.splitlines():
            if "push origin" in line:
                self.assertNotIn("TOKEN", line)
                self.assertNotIn("extraheader", line)
                self.assertNotIn("bearer", line.lower())
        self.assertIn("::add-mask::", publish)
        self.assertIn(AUTH_KEY, publish)
        self.assertIn("--unset-all", publish)
        fetch_lines = [line for line in publish.splitlines() if "fetch origin" in line]
        self.assertEqual(len(fetch_lines), 1)
        self.assertNotIn("--depth", fetch_lines[0])
        self.assertIn("credential.helper=", fetch_lines[0])
        self.assertIn("--depth=1", fetch)
        self.assertNotIn("http.extraheader=", fetch)


def _python() -> str:
    return os.environ.get("PYTHON", "python3")


def _token_env() -> dict[str, str]:
    env = os.environ.copy()
    env["TOKEN"] = TOKEN
    return env


def _run(*args: str, env: dict[str, str] | None = None, cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["bash", *args],
        check=False,
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd,
    )
    if check and result.returncode != 0:
        raise AssertionError(f"{args}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
    return result


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(["git", *args], check=False, capture_output=True, text=True)
    if result.returncode != 0:
        raise AssertionError(f"git {args}\n{result.stderr}")
    return result


def _count(bare: Path) -> int:
    result = _git("--git-dir", str(bare), "rev-list", "--count", "index-data")
    return int(result.stdout.strip())


def _write_shard(data: Path, marker: str) -> None:
    shard = data / "shards" / "greenhouse"
    shard.mkdir(parents=True, exist_ok=True)
    (shard / "indexfixture.json").write_text(json.dumps(_shard()), encoding="utf-8")
    (data / "report.json").write_text(json.dumps({"publish": True, "marker": marker}), encoding="utf-8")


def _shard() -> dict:
    return {
        "ats": "greenhouse",
        "board": "indexfixture",
        "slug": "indexfixture",
        "name": "Index Fixture",
        "website": "https://indexfixture.example",
        "status": "ok",
        "checked_at": "2026-11-15T06:00:00Z",
        "failed_at": None,
        "jobs": [
            {
                "id": "live",
                "title": "Engineer",
                "company": "Index Fixture",
                "location": "Remote",
                "remote": "remote",
                "department": "Research",
                "employment_type": "FULL_TIME",
                "salary_text": "",
                "salary_source": "",
                "posted": "2026-11-01",
                "updated": "",
                "deadline": "",
                "source_url": "https://boards.example/index-fixture-role",
                "apply_url": "https://boards.example/index-fixture-role",
                "first_seen": "2026-11-15T06:00:00Z",
                "last_checked": "2026-11-15T06:00:00Z",
            }
        ],
    }


if __name__ == "__main__":
    unittest.main()
