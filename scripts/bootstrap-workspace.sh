#!/usr/bin/env bash
# Rebuild the R: (RAM disk) maintenance workspace for pi-blackhole-local.
#
# R: is wiped on reboot. Durable state lives elsewhere:
#   - local patch history: GitHub fork $FORK_URL, branch local/zh
#   - deployed code:       $INSTALLED (+ deployment-manifest.json)
# Idempotent: creates what is missing, fast-forwards what exists, never
# overwrites unpushed local work.
#
# Usage (Git Bash):
#   bash C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local/scripts/bootstrap-workspace.sh [--skip-upstream-deps]
set -euo pipefail

UPSTREAM_URL="https://github.com/k0valik/pi-blackhole.git"
FORK_URL="${BH_FORK_URL:-https://github.com/kunkun9527/pi-blackhole.git}"
UP="${BH_UPSTREAM_DIR:-R:/pi-blackhole-upstream}"
INT="${BH_INTEGRATION_DIR:-R:/pi-blackhole-integration}"
INSTALLED="${BH_INSTALLED_DIR:-C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local}"
SKIP_DEPS=0
[[ "${1:-}" == "--skip-upstream-deps" ]] && SKIP_DEPS=1

step() { printf '\n== %s\n' "$*"; }

step "1/5 upstream clone: $UP (origin = upstream, fork = $FORK_URL)"
if [[ -d "$UP/.git" ]]; then
  git -C "$UP" fetch -q --all --tags --prune
else
  git clone -q "$UPSTREAM_URL" "$UP"
fi
git -C "$UP" remote get-url fork >/dev/null 2>&1 || git -C "$UP" remote add fork "$FORK_URL"
git -C "$UP" fetch -q fork
git -C "$UP" switch -q dev 2>/dev/null || git -C "$UP" switch -q -c dev --track origin/dev
git -C "$UP" merge -q --ff-only origin/dev
git -C "$UP" rev-parse --verify -q refs/remotes/fork/local/zh >/dev/null ||
  { echo "ERROR: fork has no local/zh branch; cannot rebuild local patches." >&2; exit 1; }
# Local code index stays out of git (applies to all worktrees).
EXCLUDE="$(git -C "$UP" rev-parse --path-format=absolute --git-path info/exclude)"
mkdir -p "$(dirname "$EXCLUDE")"
grep -qx '.codeindex/' "$EXCLUDE" 2>/dev/null || echo '.codeindex/' >> "$EXCLUDE"

step "2/5 local/zh branch and integration worktree: $INT"
if ! git -C "$UP" rev-parse --verify -q refs/heads/local/zh >/dev/null; then
  git -C "$UP" branch -q --track local/zh fork/local/zh
fi
git -C "$UP" worktree prune
[[ -e "$INT/.git" ]] || git -C "$UP" worktree add -q "$INT" local/zh
git -C "$INT" branch -q --set-upstream-to=fork/local/zh local/zh
if [[ -z "$(git -C "$INT" status --porcelain)" ]] &&
   git -C "$INT" merge-base --is-ancestor HEAD fork/local/zh; then
  git -C "$INT" merge -q --ff-only fork/local/zh
fi
ahead="$(git -C "$INT" rev-list --count fork/local/zh..HEAD)"
[[ "$ahead" == 0 ]] || echo "WARNING: $ahead local commit(s) not on the fork; run: git -C $INT push"

step "3/5 dependencies"
if [[ ! -e "$INT/node_modules" ]]; then
  # Junction to the installed package: same linked pi host, no second install.
  pwsh -NoProfile -Command "New-Item -ItemType Junction -Path '$INT/node_modules' -Target '$INSTALLED/node_modules' | Out-Null"
fi
if [[ $SKIP_DEPS -eq 0 && ! -d "$UP/node_modules/vitest" ]]; then
  # vitest.upstream.config.mjs loads vitest from the upstream clone.
  (cd "$UP" && pnpm install --frozen-lockfile) ||
    echo "WARNING: pnpm install failed; the upstream suite is unavailable until fixed."
fi
mkdir -p R:/Temp

step "4/5 state"
deployed="$(python -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['integrationCommit'])" "$INSTALLED/deployment-manifest.json")"
echo "upstream dev:         $(git -C "$UP" log -1 --format='%h %s' dev)"
echo "integration local/zh: $(git -C "$INT" log -1 --format='%h %s')"
echo "installed manifest:   $deployed"
echo "upstream commits not yet merged: $(git -C "$INT" rev-list --count HEAD..origin/dev)"

step "5/5 verify"
git -C "$INT" cat-file -e "$deployed^{commit}" 2>/dev/null ||
  { echo "ERROR: deployed commit $deployed is not in local/zh history." >&2; exit 1; }
if [[ -n "$(git -C "$INT" diff --name-only "$deployed" HEAD -- src index.ts tests scripts docs)" ]]; then
  echo "NOTE: local/zh has changes not yet deployed (python scripts/deploy-local.py --base $deployed)."
fi
echo "workspace ready"
