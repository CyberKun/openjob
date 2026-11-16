#!/usr/bin/env bash
set -euo pipefail

datasets_dir="${1:?usage: upload-datasets-to-r2.sh DATASETS_DIRECTORY}"
bucket="${OPENJOB_R2_BUCKET:-openjob-datasets}"
cf_bin="${OPENJOB_CF_BIN:-worker/node_modules/.bin/cf}"

if [[ ! -f "$datasets_dir/manifest.json" ]]; then
  echo "Missing dataset manifest: $datasets_dir/manifest.json" >&2
  exit 1
fi
if [[ ! -x "$cf_bin" ]]; then
  echo "Cloudflare CLI not found: $cf_bin" >&2
  exit 1
fi

snapshot="$(python -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["snapshot_id"])' "$datasets_dir/manifest.json")"
if [[ ! "$snapshot" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid snapshot ID in manifest" >&2
  exit 1
fi

for file in "$datasets_dir"/*; do
  [[ -f "$file" ]] || continue
  name="$(basename "$file")"
  [[ "$name" == "manifest.json" ]] && continue
  case "$name" in
    *.json) content_type="application/json" ;;
    *.jsonl) continue ;;
    *.jsonl.gz) content_type="application/gzip" ;;
    *) echo "Unexpected dataset artifact: $name" >&2; exit 1 ;;
  esac
  "$cf_bin" r2 objects put "snapshots/$snapshot/$name" \
    --bucket-name "$bucket" --file "$file" --content-type "$content_type" --quiet
done

# Publish the pointer only after every immutable snapshot object is present.
"$cf_bin" r2 objects put manifest.json \
  --bucket-name "$bucket" --file "$datasets_dir/manifest.json" \
  --content-type application/json --quiet

echo "Published OpenJob dataset snapshot $snapshot to R2 bucket $bucket"
