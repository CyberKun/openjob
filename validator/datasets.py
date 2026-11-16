"""Build complete, reproducible public datasets from the catalog snapshot."""

from __future__ import annotations

import gzip
import hashlib
import json
import re
from pathlib import Path

from indexer.catalog import INDEXED_NOTICE
from validator.posts import load_post, schema_dir

VERSION = "1"
MAX_ROWS = 1000
MAX_BYTES = 10 * 1024 * 1024
ORIGIN = "https://openjob.softprobe.ai"


def _json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_datasets(root: Path, out: Path, document: dict, *, origin: str = ORIGIN) -> dict:
    """Write shards and manifest. The manifest is written only after all shards."""
    out.mkdir(parents=True, exist_ok=True)
    groups: dict[str, list[dict]] = {"jobs": [], "talent": []}
    for post in document["posts"]:
        kind = post.get("kind")
        group = "jobs" if kind == "job" else "talent" if kind in ("talent", "talent-ref") else None
        if group is None:
            continue
        record = {key: value for key, value in post.items() if key not in ("share_text", "shares")}
        if post.get("origin", "owner") == "owner":
            _, record["body_markdown"] = load_post(root / post["path"])
        groups[group].append(record)

    canonical = hashlib.sha256(VERSION.encode("ascii") + b"\n")
    for group, records in groups.items():
        records.sort(key=lambda record: record["path"])
        paths = [record["path"] for record in records]
        if len(paths) != len(set(paths)):
            raise ValueError(f"Duplicate {group} identifier in dataset")
        canonical.update(group.encode("ascii") + b"\n")
        for record in records:
            canonical.update(_json(record) + b"\n")
    snapshot = canonical.hexdigest()
    datasets = {}
    for group, records in groups.items():
        shards = []
        rows: list[tuple[str, bytes]] = []
        size = 0

        def flush() -> None:
            nonlocal rows, size
            if not rows:
                return
            data = b"".join(row for _, row in rows)
            compressed = gzip.compress(data, mtime=0)
            name = f"{group}-{snapshot}-{len(shards):05d}.jsonl"
            (out / name).write_bytes(data)
            (out / (name + ".gz")).write_bytes(compressed)
            shards.append({"first_id": rows[0][0], "last_id": rows[-1][0], "count": len(rows),
                           "url": f"{origin}/data/{name}", "bytes": len(data), "sha256": _sha(data),
                           "gzip": {"url": f"{origin}/data/{name}.gz", "bytes": len(compressed), "sha256": _sha(compressed)}})
            rows, size = [], 0

        for record in records:
            line = _json(record) + b"\n"
            if len(line) > MAX_BYTES:
                raise ValueError(f"Dataset row exceeds 10 MiB: {record['path']}")
            if rows and (len(rows) >= MAX_ROWS or size + len(line) > MAX_BYTES):
                flush()
            rows.append((record["path"], line))
            size += len(line)
        flush()
        datasets[group] = {"count": len(records), "schema_url": f"{origin}/data/record.schema.json", "shards": shards}
    schema = json.loads((schema_dir() / "index.schema.json").read_text(encoding="utf-8"))["$defs"]["post"]
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["title"] = "OpenJob dataset record"
    schema["required"] = [key for key in schema["required"] if key not in ("share_text", "shares")]
    schema["properties"].pop("share_text", None)
    schema["properties"].pop("shares", None)
    schema["properties"]["kind"] = {"enum": ["job", "talent", "talent-ref"]}
    schema["properties"]["body_markdown"] = {"type": "string"}
    (out / "record.schema.json").write_bytes(_json(schema) + b"\n")
    manifest = {"schema_version": VERSION, "snapshot_id": snapshot, "generated": document["generated"],
                "source": document["source"], "indexed_notice": document.get("indexed_notice", INDEXED_NOTICE),
                "owner_license": "CC BY 4.0", "datasets": datasets}
    (out / "manifest.json").write_bytes(_json(manifest) + b"\n")
    for path in out.iterdir():
        if re.fullmatch(r"(?:jobs|talent)-[0-9a-f]{64}-[0-9]{5}\.jsonl(?:\.gz)?", path.name) and snapshot not in path.name:
            path.unlink()
    return manifest
