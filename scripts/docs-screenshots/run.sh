#!/usr/bin/env bash
# Makes the screenshots of the user guide (docs/images/) again.
# See .github/skills/docs-screenshots/SKILL.md.

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tool="$repo/scripts/docs-screenshots"
work="$repo/.tmp/docs-screenshots"
images="$repo/docs/images"

repeatability=false
if [[ $# -eq 1 && "$1" == --check-repeatability ]]; then
    repeatability=true
elif [[ $# -ne 0 ]]; then
    echo "Usage: npm run docs:screenshots -- [--check-repeatability]" >&2
    exit 2
fi

for cmd in bwrap xvfb-run pngquant curl tar sha256sum git node npm; do
    if ! command -v "$cmd" >/dev/null; then
        echo "$cmd is needed, but it is not installed." >&2
        exit 1
    fi
done
if [[ ! -d "$repo/node_modules/playwright-core" ]]; then
    echo "Run 'npm ci' first." >&2
    exit 1
fi
mkdir -p "$work"

# VS Code: the latest stable build, kept in $work, unless VSCODE_BIN names its executable.
if [[ -z "${VSCODE_BIN:-}" ]]; then
    info="$(curl -fsSL "https://update.code.visualstudio.com/api/update/linux-x64/stable/latest")"
    read -r version url sha256 < <(node -e '
        const info = JSON.parse(require("fs").readFileSync(0, "utf8"));
        console.log(info.productVersion, info.url, info.sha256hash);' <<<"$info")
    VSCODE_BIN="$work/vscode-$version/code"
    if [[ ! -x "$VSCODE_BIN" ]]; then
        echo "Downloading VS Code $version..."
        curl -fL --progress-bar -o "$work/vscode.tar.gz" "$url"
        echo "$sha256  $work/vscode.tar.gz" | sha256sum --check --quiet
        rm -rf "$work/vscode-$version.partial"
        mkdir "$work/vscode-$version.partial"
        tar -xzf "$work/vscode.tar.gz" -C "$work/vscode-$version.partial" --strip-components=1
        mv "$work/vscode-$version.partial" "$work/vscode-$version"
        rm "$work/vscode.tar.gz"
        # A build is about 1 GB, and an older one is not used again.
        find "$work" -mindepth 1 -maxdepth 1 -type d -name 'vscode-*' ! -name "vscode-$version" -exec rm -rf {} +
    fi
fi

# The pictures show the extension as it is in the working tree.
(cd "$repo" && npm run --silent compile)

rm -rf "${work:?}/before"
mkdir -p "$work/before"
# The pictures of the last commit, to tell which ones change.
git -C "$repo" archive HEAD docs/images 2>/dev/null | tar -x -C "$work/before" --strip-components=2 2>/dev/null || true

# The sandbox hides /home and /tmp and has no network, so that a picture cannot
# show a path or a host name of this machine, and so that port 1534 is the
# stand-in agent and never a real one. What the capture needs from /home is kept.
keep=()
for dir in "$repo" "$(dirname "$VSCODE_BIN")" "$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"; do
    if [[ "$dir" == /home/* ]]; then
        keep+=(--bind "$dir" "$dir")
    fi
done

capture() {
    local first_capture="${1:-}"
    rm -rf "${work:?}/workspace" "${work:?}/home" "${work:?}/out"
    mkdir -p "$work/home" "$work/out"
    cp -r "$tool/workspace" "$work/workspace"
    bwrap --bind / / --dev-bind /dev /dev --proc /proc --tmpfs /tmp \
        --tmpfs /home --bind "$work/home" /home/user --bind "$work/workspace" /home/user/server \
        "${keep[@]}" \
        --unshare-net --unshare-pid --die-with-parent \
        --setenv HOME /home/user --setenv SHOTS_SANDBOX 1 --setenv VSCODE_BIN "$VSCODE_BIN" \
        --setenv SHOTS_WORKSPACE /home/user/server --setenv SHOTS_WORK "$work" \
        --setenv SHOTS_OUT "$work/out" --setenv SHOTS_BEFORE "$work/before" \
        --setenv SHOTS_FIRST_CAPTURE "$first_capture" \
        xvfb-run -a -s "-screen 0 2600x2000x24" node "$tool/capture.mjs" 2>&1 | tee "$work/capture.log"
}

capture
if "$repeatability"; then
    rm -rf "${work:?}/first-capture"
    mv "$work/out" "$work/first-capture"
    mv "$work/capture.log" "$work/first-capture.log"
    capture "$work/first-capture"
fi

# Pictures that changed go to docs/images.
echo
echo "Pictures in docs/images:"
mkdir -p "$images"
while IFS=$'\t' read -r name state note; do
    if [[ "$state" == unchanged ]]; then
        cp "$work/before/$name" "$images/$name"
    else
        cp "$work/out/$name" "$images/$name"
    fi
    printf '  %-28s %s\n' "$name" "$state${note:+ ($note)}"
done <"$work/out/changes.txt"
for old in "$images"/*.png; do
    if [[ ! -e "$work/out/$(basename "$old")" ]]; then
        printf '  %-28s %s\n' "$(basename "$old")" "not made by this run"
    fi
done
echo "Log: ${work#"$repo"/}/capture.log, pictures of the last commit: ${work#"$repo"/}/before/"
