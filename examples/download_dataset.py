"""Stream an OpenJob dataset as JSON lines for agent-written analysis."""
import argparse
import gzip
import hashlib
import json
import sys
from urllib.request import urlopen


def read(url):
    with urlopen(url, timeout=60) as response:
        return response.read()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('kind', choices=('jobs', 'talent'))
    parser.add_argument('--manifest', default='https://openjob.softprobe.ai/data/manifest.json')
    args = parser.parse_args()
    manifest = json.loads(read(args.manifest))
    count = 0
    for shard in manifest['datasets'][args.kind]['shards']:
        raw = read(shard['gzip']['url'])
        if hashlib.sha256(raw).hexdigest() != shard['gzip']['sha256']:
            raise ValueError('Dataset checksum mismatch')
        data = gzip.decompress(raw)
        if hashlib.sha256(data).hexdigest() != shard['sha256']:
            raise ValueError('Uncompressed dataset checksum mismatch')
        for line in data.splitlines():
            record = json.loads(line)
            print(json.dumps(record, ensure_ascii=False))
            count += 1
    if count != manifest['datasets'][args.kind]['count']:
        raise ValueError('Dataset count mismatch')
    print(f"Read {count} records from snapshot {manifest['snapshot_id']}", file=sys.stderr)


if __name__ == '__main__':
    main()
