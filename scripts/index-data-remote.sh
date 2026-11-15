#!/usr/bin/env bash
# Prepare and push the index-data branch.
#
# Git over HTTPS does not treat "Authorization: Bearer <token>" as a
# credential. On the git 2.56 runner that asked for a username and the push
# exited 128. actions/checkout sends Basic instead: base64 of
# "x-access-token:<token>" on http.https://github.com/.extraheader.
# Actions masks github.token, not that base64, so register the mask before
# the value is written into git config. The header is removed after the
# push, including when the push fails.
#
# The fetch is the full branch. A depth-1 fetch leaves this repo shallow,
# and the push then sends a shallow packet. GitHub rejects that with
# "shallow update not allowed". One commit per publish is the audit trail.

set -euo pipefail
export GIT_TERMINAL_PROMPT=0
export LC_ALL=C

AUTH_KEY="http.https://github.com/.extraheader"

usage() {
  echo "usage: index-data-remote.sh prepare <data-dir> <remote-url>" >&2
  echo "       index-data-remote.sh publish <data-dir>" >&2
  exit 2
}

configure_auth() {
  local data=$1
  local b64
  b64=$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')
  printf '::add-mask::%s\n' "$b64"
  git -C "$data" config --local "$AUTH_KEY" "AUTHORIZATION: basic ${b64}"
}

clear_auth() {
  local data=$1
  if [ -e "$data/.git" ]; then
    git -C "$data" config --local --unset-all "$AUTH_KEY" || true
  fi
}

require_token() {
  if [ -z "${TOKEN:-}" ]; then
    echo "TOKEN is required to authenticate the index-data remote." >&2
    exit 1
  fi
}

missing_ref() {
  grep -q -e "couldn't find remote ref" \
    -e "Could not find remote ref" \
    -e "Remote branch index-data not found" "$1"
}

prepare() {
  local data=$1
  local remote=$2
  require_token
  git init -b index-data "$data"
  git -C "$data" config user.email "github-actions[bot]@users.noreply.github.com"
  git -C "$data" config user.name "github-actions[bot]"
  git -C "$data" remote add origin "$remote"
  # Expand the path now. An EXIT trap runs after this function's locals are gone.
  trap "clear_auth $(printf '%q' "$data")" EXIT
  configure_auth "$data"
  local err
  err=$(mktemp)
  # No --depth. See the file header. credential.helper is empty so a global
  # helper cannot prompt; the URL-scoped header above is the credential.
  if git -C "$data" -c credential.helper= fetch origin index-data >"$err" 2>&1; then
    git -C "$data" checkout --detach FETCH_HEAD
    echo "Checked out index-data."
  elif missing_ref "$err"; then
    git -C "$data" commit --allow-empty -m "Start the index data branch."
    echo "index-data does not exist yet. Starting it."
  else
    cat "$err" >&2
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"
  clear_auth "$data"
}

publish() {
  local data=$1
  trap "clear_auth $(printf '%q' "$data")" EXIT
  git -C "$data" add shards report.json
  if git -C "$data" diff --cached --quiet; then
    echo "No index changes."
    exit 0
  fi
  require_token
  git -C "$data" commit -m "Index public jobs."
  configure_auth "$data"
  # The token stays in git config, not on this command line.
  git -C "$data" -c credential.helper= push origin HEAD:index-data
  clear_auth "$data"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    prepare)
      [ $# -eq 3 ] || usage
      prepare "$2" "$3"
      ;;
    publish)
      [ $# -eq 2 ] || usage
      publish "$2"
      ;;
    *)
      usage
      ;;
  esac
fi
