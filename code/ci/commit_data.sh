#!/usr/bin/env bash
# Commit whatever changed in the data-branch folder and push it to the `data` branch.
set -euo pipefail
DIR="${1:-data-branch}"
MSG="${2:-data update}"
cd "$DIR"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A
if git diff --cached --quiet; then
  echo "nothing to commit"
  exit 0
fi
git commit --quiet -m "$MSG"
for i in 1 2 3; do
  git pull --quiet --rebase origin data 2>/dev/null || true
  if git push --quiet origin HEAD:data; then
    echo "pushed to data branch"
    exit 0
  fi
  sleep 5
done
echo "push failed after 3 tries"
exit 1
