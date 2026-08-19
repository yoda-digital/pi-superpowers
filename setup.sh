#!/bin/sh
# pi-superpowers setup script
# POSIX-compatible, idempotent — safe to re-run.
set -e

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { printf '  \033[1;34m▸\033[0m %s\n' "$1"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$1"; }
fail()  { printf '  \033[1;31m✗\033[0m %s\n' "$1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_SRC="$SCRIPT_DIR/agents"
AGENTS_DST="$HOME/.pi/agents"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"

# ── Step 1: Verify Pi is installed ───────────────────────────────────────────

printf '\n\033[1mpi-superpowers setup\033[0m\n\n'

if command -v pi >/dev/null 2>&1; then
    PI_VERSION="$(pi --version 2>/dev/null || echo 'unknown')"
    ok "Pi found: $PI_VERSION"
else
    fail "Pi is not installed. Install it first: https://github.com/earendil-works/pi"
fi

# ── Step 2: Install the package via pi install ───────────────────────────────

info "Installing pi-superpowers package..."
if pi install "$SCRIPT_DIR"; then
    ok "Package installed"
else
    fail "pi install failed. Check the output above."
fi

# ── Step 3: Copy agent definitions to ~/.pi/agents/ ─────────────────────────

info "Installing agent definitions..."

if [ ! -d "$AGENTS_SRC" ]; then
    fail "Agent source directory not found: $AGENTS_SRC"
fi

mkdir -p "$AGENTS_DST"

for agent_file in "$AGENTS_SRC"/*.md; do
    [ -f "$agent_file" ] || continue
    agent_name="$(basename "$agent_file")"
    dest_file="$AGENTS_DST/$agent_name"

    if [ -f "$dest_file" ]; then
        # Back up existing file if it differs
        if ! cmp -s "$agent_file" "$dest_file"; then
            backup="$dest_file.backup-$TIMESTAMP"
            cp "$dest_file" "$backup"
            warn "Backed up existing $agent_name -> $(basename "$backup")"
        fi
    fi

    cp "$agent_file" "$dest_file"
    ok "Installed agent: $agent_name"
done

# ── Step 4: Verify installation ─────────────────────────────────────────────

info "Verifying installation..."
ERRORS=0

# Check that the extensions resolve (pi install would have failed, but double-check)
for ext in extensions/superpowers.ts extensions/subagent/index.ts extensions/todo.ts; do
    if [ -f "$SCRIPT_DIR/$ext" ]; then
        ok "Extension found: $ext"
    else
        warn "Extension missing: $ext"
        ERRORS=$((ERRORS + 1))
    fi
done

# Check that the skills directory exists (via upstream-superpowers)
SKILLS_DIR="$SCRIPT_DIR/upstream-superpowers/skills"
if [ -d "$SKILLS_DIR" ]; then
    SKILL_COUNT="$(find "$SKILLS_DIR" -name 'SKILL.md' | wc -l | tr -d ' ')"
    ok "Skills directory found: $SKILL_COUNT skills"
else
    warn "Skills directory not found: $SKILLS_DIR"
    ERRORS=$((ERRORS + 1))
fi

# Check that agent files landed
AGENT_COUNT=0
for f in "$AGENTS_DST"/*.md; do
    [ -f "$f" ] && AGENT_COUNT=$((AGENT_COUNT + 1))
done
if [ "$AGENT_COUNT" -gt 0 ]; then
    ok "Agent definitions installed: $AGENT_COUNT agents in $AGENTS_DST"
else
    warn "No agent definitions found in $AGENTS_DST"
    ERRORS=$((ERRORS + 1))
fi

# Check references
if [ -f "$SCRIPT_DIR/references/pi-tools.md" ]; then
    ok "Tool mapping reference found"
else
    warn "Tool mapping reference missing (will use inline fallback)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

printf '\n\033[1m── Summary ──\033[0m\n\n'

if [ "$ERRORS" -eq 0 ]; then
    ok "pi-superpowers installed successfully"
else
    warn "$ERRORS verification warning(s) — see above"
fi

printf '\n  Installed components:\n'
printf '    Extensions:  superpowers.ts, subagent/index.ts, todo.ts\n'
printf '    Agents:      planner, implementer, reviewer, debugger, scout\n'
printf '    Skills:      %s superpowers skills (upstream)\n' "$SKILL_COUNT"
printf '    References:  pi-tools.md (tool mapping)\n'
printf '\n  Agent definitions:  %s\n' "$AGENTS_DST"
printf '\n  To verify, start Pi and send:\n'
printf '    Let'\''s make a react todo list\n'
printf '\n  The brainstorming skill should auto-trigger before any code is written.\n\n'
