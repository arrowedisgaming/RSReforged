#!/usr/bin/env bash
# Regenerate docs/foundry-listing.html from README.md.
#
# Foundry's package listing description field accepts HTML
# (https://foundryvtt.com/article/packaging-guide/) but there is no public
# API for updating it — the listing gallery and description are hand-edited
# via the form at https://foundryvtt.com/packages/rsreforged (Edit mode).
#
# This script keeps a paste-ready HTML artifact under version control so the
# listing can be updated by copy-pasting docs/foundry-listing.html instead
# of hand-converting Markdown each release.
#
# Three transforms are applied on top of the raw marked output:
#   1. Strip the <h1>RSReforged</h1> — Foundry shows the package name above
#      the description already.
#   2. Strip the shields.io badges paragraph — Foundry surfaces version,
#      compatibility, and license through its own UI.
#   3. Rewrite the #setting-up-pre-defined-bonuses in-page anchor to an
#      absolute github.com link, since marked does not emit id= attributes
#      on headings and the anchor would otherwise be dead on Foundry's page.
#
# Dependencies: npx (Node.js). marked is pulled on demand via `npx --yes`
# so there is no local install to maintain.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

out=docs/foundry-listing.html

{
  cat <<'EOF'
<!--
  GENERATED FROM README.md by scripts/generate-foundry-listing.sh.
  Do not edit by hand. Edit README.md and rerun the script.
  Paste this file's contents into the Description field at
  https://foundryvtt.com/packages/rsreforged (Edit mode).
-->
EOF
  npx --yes marked --gfm -i README.md \
    | sed '/^<h1>RSReforged<\/h1>$/d' \
    | awk '
        BEGIN { skip = 0 }
        /^<p><img src="https:\/\/img\.shields\.io/ { skip = 1; next }
        skip == 1 && /<\/p>/ { skip = 0; next }
        skip == 0 { print }
      ' \
    | sed 's|href="#setting-up-pre-defined-bonuses"|href="https://github.com/arrowedisgaming/RSReforged#setting-up-pre-defined-bonuses"|g'
} > "$out"

line_count=$(wc -l < "$out" | tr -d ' ')
echo "Wrote $out ($line_count lines)."
