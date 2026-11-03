#!/usr/bin/env bash
# Combine this version's changelog with GitHub-generated PR notes.

set -euo pipefail

version="${1:?Usage: $0 <version> [changelog-file]}"
changelog="${2:-CHANGELOG.md}"
tag="v$version"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"

{
  echo "## Changelog"
  echo
  bash "$(dirname "$0")/extract-changelog.sh" "$version" "$changelog"
  echo
  gh api "repos/$repo/releases/generate-notes" \
    -f tag_name="$tag" --jq '.body' |
    sed "s/^## What's Changed/## PRs/"
}
