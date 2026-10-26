#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Fetch the Crossword game module (@next-round/game-crossword) into games/crossword.
# Crossword lives in its own repository (lewismatt/next-round-crossword) and is
# bundled into this deployment as a workspace package: its dependencies are
# the platform's unpublished workspace packages (@next-round/contracts,
# game-sdk, game-client), so it can only be consumed where those resolve —
# inside this workspace, which also builds it (its repo carries no dist/).
# Mirrors scripts/fetch-cipher.sh. The fetched tree is gitignored; this
# script is the pin.
set -eu
CROSSWORD_REF="${CROSSWORD_REF:-fe7b3282d031d2229a0f27df4635a99d46013be9}"
CROSSWORD_URL="${CROSSWORD_URL:-https://github.com/lewismatt/next-round-crossword.git}"
cd "$(dirname "$0")/.."
if [ ! -d games/crossword/.git ]; then
  rm -rf games/crossword
  git clone --quiet "$CROSSWORD_URL" games/crossword
fi
git -C games/crossword fetch --quiet origin "$CROSSWORD_REF" 2>/dev/null || git -C games/crossword fetch --quiet origin
git -C games/crossword checkout --quiet "$CROSSWORD_REF"
echo "crossword pinned at $(git -C games/crossword rev-parse HEAD)"
