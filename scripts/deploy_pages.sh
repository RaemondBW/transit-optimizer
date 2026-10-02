#!/usr/bin/env bash
# Publish the dashboard (web/ + its generated data) to GitHub Pages.
#
# The site lives on an orphan `gh-pages` branch holding a single commit that is
# replaced on every deploy, so the ~65 MB of generated data never accumulates in
# the repo's history. Point Pages at that branch once:
#   Settings -> Pages -> Build and deployment -> Deploy from a branch -> gh-pages / (root)
# or: gh api -X POST repos/OWNER/REPO/pages -f "source[branch]=gh-pages" -f "source[path]=/"
#
# Note: a Pages site is public on the internet, even when the repository is private.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f web/data/network.json ] || { echo "web/data is missing; run the pipeline first (make all / make live)"; exit 1; }
remote=$(git remote get-url origin)
stamp=$(date -u +%Y-%m-%dT%H:%MZ)
src=$(git rev-parse --short HEAD)

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
rsync -a --exclude '_*' --exclude '.DS_Store' web/ "$tmp/"
touch "$tmp/.nojekyll"   # serve files as-is (no Jekyll processing)

# cache-bust the app files so a new deploy is picked up immediately
sed -i.bak -E "s#(style\.css|app\.js)\?v=[0-9]+#\1?v=$(date +%s)#g" "$tmp/index.html" && rm "$tmp/index.html.bak"

git -C "$tmp" init -q -b gh-pages
git -C "$tmp" add -A
git -C "$tmp" -c user.name="$(git config user.name)" -c user.email="$(git config user.email)" \
  commit -q -m "Deploy dashboard ($stamp, from $src)"
git -C "$tmp" push -q --force "$remote" gh-pages
echo "Deployed $(du -sh "$tmp" | cut -f1) to gh-pages ($stamp, from $src)"
