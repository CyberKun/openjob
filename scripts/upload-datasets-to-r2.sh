#!/usr/bin/env bash
set -euo pipefail

datasets_dir="${1:?usage: upload-datasets-to-r2.sh DATASETS_DIRECTORY}"
bucket="${OPENJOB_R2_BUCKET:-openjob-datasets}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(dirname -- "$script_dir")"

if [[ ! -d "$datasets_dir" ]]; then
  echo "Dataset directory not found: $datasets_dir" >&2
  exit 1
fi
# Resolve the caller-relative path before the S3 uploader runs from the worker project.
datasets_dir="$(cd -- "$datasets_dir" && pwd)"

node "$repo_root/worker/scripts/upload-datasets-to-r2.mjs" "$datasets_dir" "$bucket"
