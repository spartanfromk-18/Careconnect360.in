#!/usr/bin/env bash
# Manual/CI mirror of the Ralph Loop verification gate (see PROMPT.md).
# Run this yourself any time to check what the loop will require before it commits.
set -uo pipefail

FAIL=0

echo "== Lint =="
if npm run | grep -q " lint"; then
  npm run lint || FAIL=1
else
  echo "(no lint script found — skipping)"
fi

echo "== Build =="
if npm run | grep -q " build"; then
  npm run build || FAIL=1
else
  echo "(no build script found — skipping)"
fi

echo "== Tests =="
if npm run | grep -q " test"; then
  npm test || FAIL=1
else
  echo "(no test script found — skipping)"
fi

echo "== CodeRabbit review (uncommitted changes) =="
if command -v coderabbit >/dev/null 2>&1; then
  coderabbit review --prompt-only --type uncommitted || FAIL=1
else
  echo "coderabbit CLI not found. Install with:"
  echo "  curl -fsSL https://cli.coderabbit.ai/install.sh | sh"
  echo "  coderabbit auth login"
  FAIL=1
fi

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "VERIFY FAILED — do not commit until the above is resolved."
  exit 1
fi

echo ""
echo "All checks passed — safe to commit."
