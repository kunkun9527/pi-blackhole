#!/usr/bin/env bash
# Rebuild the R: (RAM disk) maintenance workspace for pi-blackhole-local.
#
# R: is wiped on reboot. Durable state lives on C::
#   - local patch history: bare repo $DURABLE (branch local/zh)
#   - deployed code:       $INSTALLED (+ deployment-manifest.json)
# This script is idempotent: it creates what is missing and updates what exists.
#
# Usage (Git Bash):
#   bash C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local/scripts/bootstrap-workspace.sh [--skip-upstream-deps]
set -euo pipefail

UPSTREAM_URL="https://github.com/k0valik/pi-blackhole.git"
UP="${BH_UPSTREAM_DIR:-R:/pi-blackhole-upstream}"
INT="${BH_INTEGRATION_DIR:-R:/pi-blackhole-integration}"
DURABLE="${BH_DURABLE_REPO:-C:/Users/Su/.pi/agent/repos/pi-blackhole-local.git}"
INSTALLED="${BH_INSTALLED_DIR:-C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local}"
SKIP_DEPS=0
[[ "${1:-}" == "--skip-upstream-deps" ]] && SKIP_DEPS=1

step() { printf '\n== %s\n' "$*"; }

step "1/6 durable repo: $DURABLE"
git -C "$DURABLE" rev-parse --verify -q refs/heads/local/zh >/dev/null ||
  { echo "ERROR: $DURABLE has no local/zh branch; cannot rebuild local patches." >&2; exit 1; }

step "2/6 upstream clone: $UP"
if [[ -d "$UP/.git" ]]; then
  git -C "$UP" fetch --all --tags --prune
else
  git clone "$UPSTREAM_URL" "$UP"
fi
git -C "$UP" switch -q dev 2>/dev/null || git -C "$UP" switch -q -c dev --track origin/dev
git -C "$UP" merge -q --ff-only origin/dev
git -C "$UP" remote get-url durable >/dev/null 2>&1 || git -C "$UP" remote add durable "$DURABLE"
git -C "$UP" fetch -q durable
# Keep the integration index local to this machine.
EXCLUDE="$(git -C "$UP" rev-parse --git-path info/exclude)"
[[ "$EXCLUDE" = /* || "$EXCLUDE" =~ ^[A-Za-z]: ]] || EXCLUDE="$UP/$EXCLUDE"
mkdir -p "$(dirname "$EXCLUDE")"
grep -qx '.codeindex/' "$EXCLUDE" 2>/dev/null || echo '.codeindex/' >> "$EXCLUDE"

step "3/6 local/zh branch"
if git -C "$UP" rev-parse --verify -q refs/heads/local/zh >/dev/null; then
  if ! git -C "$UP" merge-base --is-ancestor local/zh durable/local/zh; then
    echo "WARNING: local/zh has commits not in durable; push them: git -C $UP push durable local/zh"
  fi
else
  git -C "$UP" branch -q local/zh durable/local/zh
fi

step "4/6 integration worktree: $INT"
git -C "$UP" worktree prune
if [[ ! -e "$INT/.git" ]]; then
  git -C "$UP" worktree add -q "$INT" local/zh
fi
if git -C "$INT" merge-base --is-ancestor local/zh durable/local/zh 2>/dev/null &&
   [[ -z "$(git -C "$INT" status --porcelain)" ]]; then
  git -C "$INT" merge -q --ff-only durable/local/zh
fi
git -C "$INT" branch -q --set-upstream-to=durable/local/zh local/zh

step "5/6 node_modules"
if [[ ! -e "$INT/node_modules" ]]; then
  # Junction to the installed package: same pi host links, no second install.
  pwsh -NoProfile -Command "New-Item -ItemType Junction -Path '$INT/node_modules' -Target '$INSTALLED/node_modules' | Out-Null"
fi
if [[ $SKIP_DEPS -eq 0 && ! -d "$UP/node_modules/vitest" ]]; then
  # Upstream vitest runs the upstream suite (vitest.upstream.config.mjs imports it from here).
  (cd "$UP" && pnpm install --frozen-lockfile) ||
    echo "WARNING: pnpm install failed; upstream suite unavailable until fixed."
fi
mkdir -p R:/Temp

step "6/6 verify"
deployed="$(python -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['integrationCommit'])" "$INSTALLED/deployment-manifest.json")"
echo "upstream dev:        $(git -C "$UP" log -1 --format='%h %s' dev)"
echo "integration local/zh: $(git -C "$INT" log -1 --format='%h %s')"
echo "installed manifest:  $deployed"
git -C "$INT" cat-file -e "$deployed^{commit}" ||
  { echo "ERROR: deployed commit $deployed not in local/zh history." >&2; exit 1; }
if [[ -n "$(git -C "$INT" diff --name-only "$deployed" HEAD -- src index.ts tests)" ]]; then
  echo "NOTE: local/zh has code changes not yet deployed (deploy with --base $deployed)."
fi
echo "workspace ready"
