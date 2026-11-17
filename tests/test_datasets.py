import gzip
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from validator.datasets import write_datasets


class DatasetTests(unittest.TestCase):
    def test_complete_stable_checked_shards_and_owner_body(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "talents").mkdir()
            (root / "talents/ada.md").write_text("---\nkind: talent\n---\n\nHello from Ada.\n", encoding="utf-8")
            posts = [{"kind": "job", "path": f"indexed/test/{i:04}", "title": "工程师", "origin": "indexed", "source_url": "https://example.com"} for i in range(1002)]
            posts.append({"kind": "talent", "path": "talents/ada.md", "title": "Ada", "origin": "owner", "source_url": "https://example.com", "shares": ["omit"]})
            doc = {"generated": "2026-11-15T00:00:00Z", "source": "https://github.com/softprobe/openjob", "posts": posts}
            out = root / "out"
            manifest = write_datasets(root, out, doc)
            dataset_schema = json.loads((out / "record.schema.json").read_text(encoding="utf-8"))
            self.assertIn("null", dataset_schema["properties"]["owner"]["type"])
            self.assertIn("api", dataset_schema["properties"]["origin"]["enum"])
            self.assertIn("explicit consent", manifest["owner_license"])
            self.assertEqual(manifest["datasets"]["jobs"]["count"], 1002)
            self.assertEqual(len(manifest["datasets"]["jobs"]["shards"]), 2)
            self.assertIn(f"/data/snapshots/{manifest['snapshot_id']}/", manifest["datasets"]["jobs"]["shards"][0]["url"])
            self.assertIn(f"/data/snapshots/{manifest['snapshot_id']}/record.schema.json", manifest["datasets"]["jobs"]["schema_url"])
            all_rows = []
            for dataset in manifest["datasets"].values():
                for shard in dataset["shards"]:
                    data = (out / shard["url"].rsplit("/", 1)[-1]).read_bytes()
                    zipped = (out / shard["gzip"]["url"].rsplit("/", 1)[-1]).read_bytes()
                    self.assertEqual(hashlib.sha256(data).hexdigest(), shard["sha256"])
                    self.assertEqual(hashlib.sha256(zipped).hexdigest(), shard["gzip"]["sha256"])
                    self.assertEqual(gzip.decompress(zipped), data)
                    all_rows.extend(json.loads(line) for line in data.splitlines())
            self.assertEqual(len({row["path"] for row in all_rows}), 1003)
            self.assertEqual(all_rows[-1]["body_markdown"].strip(), "Hello from Ada.")
            self.assertNotIn("shares", all_rows[-1])
            doc["posts"].reverse()
            self.assertEqual(write_datasets(root, root / "other", doc)["snapshot_id"], manifest["snapshot_id"])



if __name__ == "__main__":
    unittest.main()
