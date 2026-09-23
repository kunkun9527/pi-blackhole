"""Deploy integration commits into the installed pi-blackhole-local package.

Usage (from anywhere, Git Bash or pwsh):
    python scripts/deploy-local.py --base <deployed-commit> [--head HEAD] [--apply]

--base is the integration commit the installed copy currently matches (see
`integrationCommit` in the installed deployment-manifest.json). Without --apply
the script only prints the plan and checks drift. With --apply it backs up the
installed package (excluding node_modules/dist), copies changed files as CRLF,
deletes removed files, verifies protected configs are untouched, and writes
deployment-manifest.json into both the package and the backup folder.
"""
import argparse
import datetime
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DST = Path("C:/Users/Su/.pi/agent/local-packages/pi-blackhole-local")
BACKUPS = Path("C:/Users/Su/.pi/agent/backups")
# Integration-only material: never deployed.
SKIP_PREFIX = (".github/", "upstream-tests/", "work_docs/", "AGENTS.md", "CONTRIBUTING.md",
               "vitest.upstream.config.mjs", "pnpm-lock.yaml", "pnpm-workspace.yaml",
               ".oxfmtrc.json", ".oxlintrc.json", ".simple-git-hooks.json", ".gitignore")
PROTECTED = [
    Path("C:/Users/Su/.pi/agent/settings.json"),
    Path("C:/Users/Su/.pi/agent/pi-blackhole/pi-blackhole-config.json"),
]


def git(*args: str) -> bytes:
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True).stdout


def norm(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n")


def sha(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    head = git("rev-parse", "--short", args.head).decode().strip()

    changes = []
    for line in git("diff", "--name-status", "--no-renames", args.base, head).decode().splitlines():
        status, name = line.split("\t", 1)
        # Upstream vitest files colocated under src/ stay in the integration tree only.
        colocated_upstream_test = name.endswith(".test.ts") and not name.startswith("tests/")
        if not name.startswith(SKIP_PREFIX) and not colocated_upstream_test:
            changes.append((status, name))

    drift = []
    for status, name in changes:
        target = DST / name
        if status == "A":
            if target.exists():
                drift.append(f"exists-before-add {name}")
            continue
        base = norm(git("show", f"{args.base}:{name}"))
        if not target.exists():
            drift.append(f"missing {name}")
        elif norm(target.read_bytes()) != base:
            drift.append(f"differs-from-base {name}")

    for status, name in changes:
        print(status, name)
    print("drift:", drift or "none")
    if drift:
        print("Installed copy differs from --base; reconcile before deploying.")
        return 1
    if not args.apply:
        return 0

    protected_before = {str(p): sha(p) for p in PROTECTED}
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = BACKUPS / f"blackhole-deploy-{head}-{stamp}" / "package"
    shutil.copytree(DST, backup, ignore=shutil.ignore_patterns("node_modules", "dist"))
    print("backup:", backup)

    records = []
    for status, name in changes:
        target = DST / name
        before = sha(target)
        if status == "D":
            target.unlink()
            records.append({"path": name, "deleted": True, "before": before})
            continue
        data = norm(git("show", f"{head}:{name}")).replace(b"\n", b"\r\n")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        records.append({"path": name, "new": status == "A", "before": before, "after": sha(target)})

    protected_after = {str(p): sha(p) for p in PROTECTED}
    if protected_before != protected_after:
        print("ERROR: protected config changed during deploy!")
        return 2
    pkg = json.loads((DST / "package.json").read_text(encoding="utf-8"))
    manifest = {
        "version": pkg["version"],
        "upstreamCommit": pkg["blackholeUpstream"]["commit"],
        "integrationCommit": head,
        "previousIntegrationCommit": args.base,
        "deployedAt": datetime.datetime.now().isoformat(),
        "backup": str(backup),
        "protectedConfigHashes": protected_after,
        "files": records,
    }
    text = json.dumps(manifest, ensure_ascii=False, indent=2)
    (DST / "deployment-manifest.json").write_text(text, encoding="utf-8")
    (backup.parent / "deployment-manifest.json").write_text(text, encoding="utf-8")
    print(f"deployed {len(records)} files; now run `bun run check` in {DST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
