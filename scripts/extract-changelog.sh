#!/usr/bin/env bash
# Extract a version's section from CHANGELOG.md.

set -euo pipefail

version="${1:?Usage: $0 <version> [changelog-file]}"
changelog="${2:-CHANGELOG.md}"

awk -v ver="$version" '
  /^## \[/ { if (found) exit; if (index($0, "## [" ver "]")) found=1; next }
  found { print }
' "$changelog" | sed -e :a -e '/^$/{ $d; N; ba; }'
