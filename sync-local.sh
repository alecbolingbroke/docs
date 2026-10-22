#!/usr/bin/env bash
# Weekly FieldRoutes spec sync, run on a host you control (launchd). The spec endpoint needs
# tenant credentials, which never go into this public repo or its CI.
# Clones fresh, runs sync-spec.js, and opens or updates a PR on spec-sync/upstream when
# anything changed. Needs only bash, git, curl and node: no gh.
#
# $FR_DOCS_ENV (default ~/.config/fieldroutes-docs/env) holds:
#   FR_HOST, FR_AUTH_KEY, FR_AUTH_TOKEN   tenant credentials for /api/documentation/swagger
#   GITHUB_TOKEN                          fine-grained PAT, this repo only, Contents + Pull requests: write
#   SLACK_CHANNEL                         optional: where failures are posted
# SLACK_BOT_TOKEN is read from $SLACK_ENV (an env file) when set, so it isn't copied around.
# Secrets stay unexported: they reach only the command that needs them, never argv or npm.
set -Eeuo pipefail
export GIT_TERMINAL_PROMPT=0

ENV_FILE="${FR_DOCS_ENV:-$HOME/.config/fieldroutes-docs/env}"
REPO=alecbolingbroke/docs
BRANCH=spec-sync/upstream
API="https://api.github.com/repos/$REPO"

# Read KEY=value lines without sourcing (the files hold more than we want in scope).
envval() { sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1; }

fail() {
  trap - ERR
  [ "$BASH_SUBSHELL" -eq 0 ] || exit 1  # inside $(…): let the parent report it, once
  echo "❌ $1" >&2
  local tok; tok=$([ -n "${SLACK_ENV:-}" ] && envval "$SLACK_ENV" SLACK_BOT_TOKEN || true)
  local ch; ch=$(envval "$ENV_FILE" SLACK_CHANNEL || true)
  if [ -n "$tok" ] && [ -n "$ch" ]; then
    curl -sS -o /dev/null -H @<(printf 'Authorization: Bearer %s' "$tok") -H 'Content-Type: application/json' \
      -d "{\"channel\":\"$ch\",\"text\":\":warning: FieldRoutes docs spec sync failed: $1 (log: ~/Library/Logs/fieldroutes-docs-sync.log)\"}" \
      https://slack.com/api/chat.postMessage || true
  fi
  exit 1
}
trap 'fail "line $LINENO"' ERR

[ -r "$ENV_FILE" ] || fail "missing $ENV_FILE"
for v in FR_HOST FR_AUTH_KEY FR_AUTH_TOKEN GITHUB_TOKEN; do
  declare "$v=$(envval "$ENV_FILE" "$v")"
  [ -n "${!v}" ] || fail "$v not set in $ENV_FILE"
done
gh_api() { curl -fsS -H @<(printf 'Authorization: Bearer %s' "$GITHUB_TOKEN") -H 'Accept: application/vnd.github+json' "$@"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone -q --depth 1 "https://github.com/$REPO.git" "$work"
cd "$work"
npm ci --silent --ignore-scripts
FR_HOST="$FR_HOST" FR_AUTH_KEY="$FR_AUTH_KEY" FR_AUTH_TOKEN="$FR_AUTH_TOKEN" node sync-spec.js

if [ -z "$(git status --porcelain fieldroutes)" ]; then echo "✅ no changes upstream"; exit 0; fi

git switch -qc "$BRANCH"
git add -A fieldroutes
git -c user.name="FieldRoutes spec sync" -c user.email="spec-sync@users.noreply.github.com" \
  commit -qm "chore: sync FieldRoutes spec from /api/documentation/swagger"
# Token goes in as an env-scoped header for this one push; never saved in the clone.
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
  GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')" \
  git push -qf "https://github.com/$REPO.git" "HEAD:refs/heads/$BRANCH"

prs=$(gh_api "$API/pulls?state=open&head=${REPO%%/*}:$BRANCH")
# GitHub pretty-prints an empty list as "[\n\n]", so look for a PR rather than compare to "[]".
if ! grep -q '"number"' <<<"$prs"; then
  body='Automated weekly sync from FieldRoutes'"'"' `/api/documentation/swagger` endpoint, run by `sync-local.sh`.\n\nFR additions (new endpoints / params / definitions) are merged into the canonical spec and the site files are regenerated. The merge is additive-only, so nothing already documented here is removed.\n\n**Review** the additions in the spec-file diffs. If FR introduced a new doc *error*, add a fix to `corrections.yaml`.\n\n`fieldroutes/upstream-pages/*.txt` are plain-text snapshots of the FieldRoutes Knowledge Base API overview, release notes and Swagger page. A diff there means FieldRoutes changed its prose: limits, behavior changes, release notes. If it matters, mirror it into the overview in `corrections.yaml` (`info.description`).\n\nThis branch is force-pushed by every weekly run, so commit fixes to `main`, not here.'
  gh_api -o /dev/null -X POST "$API/pulls" \
    -d "{\"title\":\"Sync: FieldRoutes spec changed upstream\",\"head\":\"$BRANCH\",\"base\":\"main\",\"body\":\"$body\"}"
  echo "✅ opened PR from $BRANCH"
else
  echo "✅ updated the open PR on $BRANCH"
fi
