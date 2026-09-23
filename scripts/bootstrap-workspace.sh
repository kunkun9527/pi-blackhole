#!/usr/bin/env bash
# Rebuild the R: (RAM disk) maintenance workspace for pi-blackhole-local.
#
# R: is wiped on reboot. Durable state lives elsewhere:
#   - local patch history: GitHub fork $FORK_URL, branch main
#     (upstream dev + local patches; upstream is tracked via origin/dev)
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
  git clone -q -b dev "$UPSTREAM_URL" "$UP"
fi
git -C "$UP" remote get-url fork >/dev/null 2>&1 || git -C "$UP" remote add fork "$FORK_URL"
git -C "$UP" fetch -q fork
git -C "$UP" switch -q dev 2>/dev/null || git -C "$UP" switch -q -c dev --track origin/dev
git -C "$UP" merge -q --ff-only origin/dev
git -C "$UP" rev-parse --verify -q refs/remotes/fork/main >/dev/null ||
  { echo "ERROR: fork has no main branch; cannot rebuild local patches." >&2; exit 1; }
# Local code index stays out of git (applies to all worktrees).
EXCLUDE="$(git -C "$UP" rev-parse --path-format=absolute --git-path info/exclude)"
mkdir -p "$(dirname "$EXCLUDE")"
grep -qx '.codeindex/' "$EXCLUDE" 2>/dev/null || echo '.codeindex/' >> "$EXCLUDE"

step "2/5 main branch (= fork/main) and integration worktree: $INT"
# Local "main" is the fork's main (upstream + local patches), never upstream main.
# A clone may have created main tracking origin/main; repoint it when that loses nothing.
if git -C "$UP" rev-parse --verify -q refs/heads/main >/dev/null; then
  if [[ "$(git -C "$UP" rev-parse --abbrev-ref main@{upstream} 2>/dev/null)" != fork/main ]]; then
    if git -C "$UP" merge-base --is-ancestor main fork/main; then
      git -C "$UP" branch -q -f main fork/main
    else
      echo "ERROR: local main has commits not on fork/main and does not track it; resolve by hand." >&2; exit 1
    fi
  fi
else
  git -C "$UP" branch -q main fork/main
fi
git -C "$UP" branch -q --set-upstream-to=fork/main main
git -C "$UP" worktree prune
[[ -e "$INT/.git" ]] || git -C "$UP" worktree add -q "$INT" main
if [[ -z "$(git -C "$INT" status --porcelain)" ]] &&
   git -C "$INT" merge-base --is-ancestor HEAD fork/main; then
  git -C "$INT" merge -q --ff-only fork/main
fi
ahead="$(git -C "$INT" rev-list --count fork/main..HEAD)"
[[ "$ahead" == 0 ]] || echo "WARNING: $ahead local commit(s) not on the fork; run: git -C $INT push"

step "3/5 dependencies"
if [[ ! -e "$INT/node_modules" ]]; then
  # Junction to the installed package: same linked pi host, no second install.
  pwsh -NoProfile -Command "New-Item -ItemType Junction -Path '$INT/node_modules' -Target '$INSTALLED/node_modules' | Out-Null"
fi
if [[ $SKIP_DEPS -eq 0 && ! -d "$UP/node_modules/vitest" ]]; then
  # vitest.upstream.config.mjs loads vitest from the upstream clone. --ignore-scripts:
  # upstream's prepare script installs its own git hooks (lint/typecheck on commit/push),
  # which would block commits and pushes of main to the fork.
  (cd "$UP" && pnpm install --frozen-lockfile --ignore-scripts) ||
    echo "WARNING: pnpm install failed; the upstream suite is unavailable until fixed."
fi
# Hooks are shared by all worktrees; point them at an empty dir so upstream hooks never run.
HOOKS="$(git -C "$UP" rev-parse --path-format=absolute --git-common-dir)/no-hooks"
mkdir -p "$HOOKS"
git -C "$UP" config core.hooksPath "$HOOKS"
mkdir -p R:/Temp

step "4/5 state"
deployed="$(python -c "import json,sys;print(json.load(open(sys.argv[1],encoding='utf-8'))['integrationCommit'])" "$INSTALLED/deployment-manifest.json")"
echo "upstream dev:         $(git -C "$UP" log -1 --format='%h %s' dev)"
echo "integration main:     $(git -C "$INT" log -1 --format='%h %s')"
echo "installed manifest:   $deployed"
echo "upstream commits not yet merged: $(git -C "$INT" rev-list --count HEAD..origin/dev)"

step "5/5 verify"
git -C "$INT" cat-file -e "$deployed^{commit}" 2>/dev/null ||
  { echo "ERROR: deployed commit $deployed is not in main history." >&2; exit 1; }
if [[ -n "$(git -C "$INT" diff --name-only "$deployed" HEAD -- src index.ts tests scripts docs)" ]]; then
  echo "NOTE: main has changes not yet deployed (python scripts/deploy-local.py --base $deployed)."
fi
echo "workspace ready"
