#!/usr/bin/env bash
set -euo pipefail
# Vite+ owns the workspace and the pinned pnpm runtime. Vercel cannot infer
# this toolchain from the packageManager field alone.
curl -fsSL https://vite.plus | VP_VERSION=1.1.0 VP_NODE_MANAGER=no bash
export PATH="$HOME/.vite-plus/bin:$PATH"
NODE_ENV=development vp install --frozen-lockfile
# Available to the following Vercel build process too.
mkdir -p node_modules/.bin
ln -sf "$HOME/.vite-plus/bin/vp" node_modules/.bin/vp
