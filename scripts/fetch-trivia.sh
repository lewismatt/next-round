#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Fetch the Trivia game module (@next-round/game-trivia) into games/trivia.
# Trivia lives in its own repository (lewismatt/next-round-trivia) and is
# bundled into this deployment as a workspace package: its dependencies are
# the platform's unpublished workspace packages (@next-round/contracts,
# game-sdk, game-client), so it can only be consumed where those resolve —
# inside this workspace, which also builds it (its repo carries no dist/).
# Mirrors scripts/fetch-cipher.sh. The fetched tree is gitignored; this
# script is the pin.
set -eu
TRIVIA_REF="${TRIVIA_REF:-8637d3281b43ad96c447d0319699c9eb738881be}"
TRIVIA_URL="${TRIVIA_URL:-https://github.com/lewismatt/next-round-trivia.git}"
cd "$(dirname "$0")/.."
if [ ! -d games/trivia/.git ]; then
  rm -rf games/trivia
  git clone --quiet "$TRIVIA_URL" games/trivia
fi
git -C games/trivia fetch --quiet origin "$TRIVIA_REF" 2>/dev/null || git -C games/trivia fetch --quiet origin
git -C games/trivia checkout --quiet "$TRIVIA_REF"
echo "trivia pinned at $(git -C games/trivia rev-parse HEAD)"
