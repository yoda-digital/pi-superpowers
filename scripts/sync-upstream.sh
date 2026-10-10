#!/usr/bin/env bash
# Vendor the Superpowers skills from obra/superpowers at a pinned ref, then
# apply this package's Pi overlay.
#
#   bash scripts/sync-upstream.sh            # re-sync the ref in UPSTREAM.json
#   bash scripts/sync-upstream.sh v7.1.0     # move to another tag/branch/commit
#   SUPERPOWERS_SRC=~/src/superpowers bash scripts/sync-upstream.sh v7.0.0
#                                            # use a local clone instead of GitHub
#
# skills/ is upstream's text, byte for byte. Pi-specific material never edits a
# skill: references/*.md (the Pi tool mapping and the Pi session guide) are
# copied into skills/using-superpowers/references/ over the vendored tree, so
# the next sync is one command with no merge.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_URL="https://github.com/obra/superpowers.git"

ref="${1:-}"
if [[ -z "$ref" ]]; then
	ref="$(node -e 'process.stdout.write(require(process.argv[1]).ref)' "$ROOT/UPSTREAM.json")"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ -n "${SUPERPOWERS_SRC:-}" ]]; then
	git -C "$SUPERPOWERS_SRC" archive --format=tar "$ref" skills | tar -x -C "$work"
	commit="$(git -C "$SUPERPOWERS_SRC" rev-parse "$ref^{commit}")"
else
	git clone --quiet --filter=blob:none --no-checkout "$REPO_URL" "$work/repo"
	git -C "$work/repo" archive --format=tar "$ref" skills | tar -x -C "$work"
	commit="$(git -C "$work/repo" rev-parse "$ref^{commit}")"
fi

[[ -f "$work/skills/using-superpowers/SKILL.md" ]] || { echo "error: $ref has no skills/using-superpowers" >&2; exit 1; }

rm -rf "$ROOT/skills"
mv "$work/skills" "$ROOT/skills"

# Overlay: Pi references replace upstream's pi-tools.md and add pi-sessions.md.
cp "$ROOT"/references/*.md "$ROOT/skills/using-superpowers/references/"

cat > "$ROOT/UPSTREAM.json" <<EOF
{
  "repo": "obra/superpowers",
  "ref": "$ref",
  "commit": "$commit"
}
EOF

count="$(find "$ROOT/skills" -name SKILL.md | wc -l | tr -d ' ')"
echo "Synced $count skills from obra/superpowers $ref ($commit)"
