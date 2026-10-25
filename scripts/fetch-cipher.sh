#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Fetch the Cipher game module (@next-round/game-cipher) into games/cipher.
# Cipher lives in its own repository (lewismatt/next-round-cipher) and is
# bundled into this deployment as a workspace package: its dependencies are
# the platform's unpublished workspace packages (@next-round/contracts,
# game-sdk, game-client), so it can only be consumed where those resolve —
# inside this workspace, which also builds it (its repo carries no dist/).
# Mirrors scripts/fetch-core.sh in the cipher repository, inverted.
# The fetched tree is gitignored; this script is the pin.
set -eu
CIPHER_REF="${CIPHER_REF:-4fbbfee1655a5f5c87456534f868c7bd9b0fac51}"
CIPHER_URL="${CIPHER_URL:-https://github.com/lewismatt/next-round-cipher.git}"
cd "$(dirname "$0")/.."
if [ ! -d games/cipher/.git ]; then
  rm -rf games/cipher
  git clone --quiet "$CIPHER_URL" games/cipher
fi
git -C games/cipher fetch --quiet origin "$CIPHER_REF" 2>/dev/null || git -C games/cipher fetch --quiet origin
git -C games/cipher checkout --quiet "$CIPHER_REF"
echo "cipher pinned at $(git -C games/cipher rev-parse HEAD)"
