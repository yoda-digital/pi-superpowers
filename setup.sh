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
USER_AGENTS="$HOME/.pi/agent/agents"

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

# ── Step 3: Retire stale agent copies ───────────────────────────────────────
# Agents ship with the package and are loaded from it directly. Copies in
# ~/.pi/agent/agents/ with the same name override the package version, so an
# unchanged copy would only block future updates: remove those. Copies that
# differ may be customisations: keep them and say what they override.

info "Checking $USER_AGENTS for copies of package agents..."

for agent_file in "$AGENTS_SRC"/*.md; do
    [ -f "$agent_file" ] || continue
    agent_name="$(basename "$agent_file")"
    user_file="$USER_AGENTS/$agent_name"
    [ -f "$user_file" ] || continue
    if cmp -s "$agent_file" "$user_file"; then
        rm "$user_file"
        ok "Removed identical copy $user_file (the package version is used)"
    else
        warn "$user_file differs from the package version and overrides it; delete it to get package updates"
    fi
done

# ── Step 4: Verify installation ─────────────────────────────────────────────

info "Verifying installation..."
ERRORS=0

# Check that the extensions resolve (pi install would have failed, but double-check)
for ext in extensions/superpowers.ts extensions/subagent/index.ts extensions/todo.ts extensions/ask.ts extensions/web.ts; do
    if [ -f "$SCRIPT_DIR/$ext" ]; then
        ok "Extension found: $ext"
    else
        warn "Extension missing: $ext"
        ERRORS=$((ERRORS + 1))
    fi
done

# Check that the skills directory exists
SKILLS_DIR="$SCRIPT_DIR/skills"
if [ -d "$SKILLS_DIR" ]; then
    SKILL_COUNT="$(find "$SKILLS_DIR" -name 'SKILL.md' | wc -l | tr -d ' ')"
    ok "Skills directory found: $SKILL_COUNT skills"
else
    warn "Skills directory not found: $SKILLS_DIR"
    ERRORS=$((ERRORS + 1))
fi

# Check the package's agent definitions
AGENT_COUNT=0
for f in "$AGENTS_SRC"/*.md; do
    [ -f "$f" ] && AGENT_COUNT=$((AGENT_COUNT + 1))
done
if [ "$AGENT_COUNT" -gt 0 ]; then
    ok "Package agents found: $AGENT_COUNT in $AGENTS_SRC"
else
    warn "No agent definitions found in $AGENTS_SRC"
    ERRORS=$((ERRORS + 1))
fi

# Check references
if [ -f "$SCRIPT_DIR/references/pi-tools.md" ]; then
    ok "Tool mapping reference found"
else
    warn "Tool mapping reference missing: the bootstrap will not map Superpowers actions to Pi tools"
    ERRORS=$((ERRORS + 1))
fi

# ── Summary ──────────────────────────────────────────────────────────────────

printf '\n\033[1m── Summary ──\033[0m\n\n'

if [ "$ERRORS" -eq 0 ]; then
    ok "pi-superpowers installed successfully"
else
    warn "$ERRORS verification warning(s) — see above"
fi

printf '\n  Installed components:\n'
printf '    Extensions:  superpowers.ts, subagent/index.ts, todo.ts, ask.ts, web.ts\n'
printf '    Agents:      %s, loaded from the package (override in %s)\n' "$AGENT_COUNT" "$USER_AGENTS"
printf '    Skills:      %s superpowers skills (upstream %s)\n' "$SKILL_COUNT" "$(sed -n 's/.*"ref": *"\([^"]*\)".*/\1/p' "$SCRIPT_DIR/UPSTREAM.json" 2>/dev/null)"
printf '    References:  pi-tools.md (tool mapping), pi-sessions.md (transcripts)\n'
printf '\n  Web tools need a Tavily key: run /web-key in Pi.\n'
printf '  Map subagent model tiers (cheap, mid, top): run /subagent-models in Pi.\n'
printf '\n  To verify, start Pi and send:\n'
printf '    Let'\''s make a react todo list\n'
printf '\n  The brainstorming skill should auto-trigger before any code is written.\n\n'
