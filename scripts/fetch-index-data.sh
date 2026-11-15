#!/usr/bin/env bash
# Copy the tip of origin/index-data into a directory for the Pages build.
#
# Depth 1 is enough: this step reads the tree and does not push. A missing
# branch is the first deploy, before any index has been published. Any other
# fetch error fails the build, so a later deploy cannot quietly drop the
# indexed jobs and still publish the site.
#
# Do not clear http.extraheader here. actions/checkout already stored Basic
# auth in this repo's config, and a public fetch also works without it.

set -euo pipefail
export GIT_TERMINAL_PROMPT=0
export LC_ALL=C

dest=${1:-index-data}
err=$(mktemp)
if git fetch --depth=1 origin index-data >"$err" 2>&1; then
  mkdir -p "$dest"
  git archive FETCH_HEAD | tar -x -C "$dest"
  echo "Fetched index-data into ${dest}."
elif grep -q -e "couldn't find remote ref" \
  -e "Could not find remote ref" \
  -e "Remote branch index-data not found" "$err"; then
  mkdir -p "$dest"
  echo "index-data does not exist yet. The site will build from owner posts only."
else
  cat "$err" >&2
  rm -f "$err"
  exit 1
fi
rm -f "$err"
