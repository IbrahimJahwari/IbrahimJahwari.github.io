#!/usr/bin/env bash
# Check out the `data` branch into a folder, or start it if it does not exist yet.
# Needs REMOTE_URL (set by the workflow, includes the Actions token).
set -euo pipefail
: "${REMOTE_URL:?REMOTE_URL is not set}"
DIR="${1:-data-branch}"
rm -rf "$DIR"
if git ls-remote --exit-code --heads "$REMOTE_URL" data >/dev/null 2>&1; then
  git clone --quiet --depth 1 --branch data "$REMOTE_URL" "$DIR"
  echo "checked out existing data branch"
else
  git init --quiet -b data "$DIR"
  git -C "$DIR" remote add origin "$REMOTE_URL"
  echo "started a new, empty data branch"
fi
