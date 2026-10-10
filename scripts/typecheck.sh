#!/usr/bin/env bash
# Type-check extensions/ against the installed Pi's type declarations.
#
#   bash scripts/typecheck.sh                     # uses the global npm install of pi
#   PI_PKG=/path/to/pi-coding-agent bash scripts/typecheck.sh
#
# Works on a copy in a temporary directory. A node_modules inside this package
# would sit next to the extensions Pi loads and bypass Pi's module mapping for
# its own packages, so none is ever created here.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_PKG="${PI_PKG:-$(npm root -g)/@earendil-works/pi-coding-agent}"
[[ -f "$PI_PKG/dist/index.d.ts" ]] || { echo "error: no Pi type declarations at $PI_PKG (set PI_PKG)" >&2; exit 2; }

if command -v tsc >/dev/null 2>&1; then TSC=(tsc); else TSC=(npx --yes -p typescript tsc); fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Pi's dependencies, plus Pi itself, as the extensions' node_modules.
mkdir -p "$work/node_modules/@earendil-works"
for dep in "$PI_PKG"/node_modules/*; do
	[[ "$(basename "$dep")" == "@earendil-works" ]] || ln -s "$dep" "$work/node_modules/$(basename "$dep")"
done
for dep in "$PI_PKG"/node_modules/@earendil-works/*; do
	ln -s "$dep" "$work/node_modules/@earendil-works/$(basename "$dep")"
done
ln -s "$PI_PKG" "$work/node_modules/@earendil-works/pi-coding-agent"

cp -r "$ROOT/extensions" "$work/extensions"
printf '{ "type": "module" }\n' > "$work/package.json"
cat > "$work/tsconfig.json" <<'EOF'
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noUnusedLocals": true,
    "types": ["node"]
  },
  "include": ["extensions/**/*.ts"]
}
EOF

(cd "$work" && "${TSC[@]}" -p tsconfig.json)
echo "typecheck ok ($(node -p "require('$PI_PKG/package.json').version") declarations)"
