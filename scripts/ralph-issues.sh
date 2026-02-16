#!/bin/bash
# Ralph Loop runner for issues #5, #6, #7
# Run from repo root: bash scripts/ralph-issues.sh
#
# Each issue runs as an independent claude -p invocation.
# Prompts are stored in scripts/prompts/ to avoid shell quoting issues.

set -euo pipefail
cd "$(dirname "$0")/.."

SCRIPTS_DIR="$(pwd)/scripts/prompts"

echo "═══════════════════════════════════════════════════════════"
echo "Ralph Loop: TMM Issues #5, #6, #7"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Make sure dev server is running on localhost (npx vite)"
echo "Starting in 3 seconds..."
sleep 3

# ─────────────────────────────────────────────
# Issue #5: Pre-select kid from Dashboard
# ─────────────────────────────────────────────
echo ""
echo "▶ Issue #5: Pre-select kid from Dashboard navigation"

claude -p "$(cat "$SCRIPTS_DIR/issue-5.txt")" --max-turns 30 --permission-mode acceptEdits

echo "✓ Issue #5 done"

# ─────────────────────────────────────────────
# Issue #6: Hide/show test kids toggle
# ─────────────────────────────────────────────
echo ""
echo "▶ Issue #6: Hide/show TestKid toggle in Settings"

claude -p "$(cat "$SCRIPTS_DIR/issue-6.txt")" --max-turns 30 --permission-mode acceptEdits

echo "✓ Issue #6 done"

# ─────────────────────────────────────────────
# Issue #7: Show APY under CD durations
# ─────────────────────────────────────────────
echo ""
echo "▶ Issue #7: Show APY under CD duration options on Invest page"

claude -p "$(cat "$SCRIPTS_DIR/issue-7.txt")" --max-turns 30 --permission-mode acceptEdits

echo "✓ Issue #7 done"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "All 3 issues complete!"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Start dev server: npx vite"
echo "  2. Log in as test user and verify each change visually"
echo "  3. git log --oneline -3  (check the commits)"
echo "  4. Create PR(s) if satisfied"
