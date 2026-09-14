#!/bin/bash
# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software: you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
#
# install.sh — standalone cpx installer. Two equivalent entry points:
#   ./proxy/install.sh     standalone: capture works WITHOUT cannbot-insight
#   ./start.sh             insight install delegates here (integrated path)
# Idempotent; re-run safe. CPX_BINDIR overrides the wrapper target dir
# (expert/tests: skips PATH/.bashrc modification).
set -e
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
cd "$SCRIPT_DIR"

# Node.js version check (>= 20.0.0; tsx and the proxy server require it).
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 20 ]; then
  NODE_VERSION=$(node -v 2>/dev/null || echo "unknown")
  echo "[cpx-install] Node.js $NODE_VERSION is not supported. Requires >= 20.0.0." >&2
  # Try auto-switch via nvm if available (same behavior as insight start.sh)
  if command -v nvm &>/dev/null || [ -s "$HOME/.nvm/nvm.sh" ]; then
    [ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
    NVM_LTS=$(nvm ls-remote --lts=20 2>/dev/null | tail -1 | awk '{print $1}')
    if [ -n "$NVM_LTS" ]; then
      echo "[cpx-install] Found nvm — installing Node.js $NVM_LTS..."
      nvm install "$NVM_LTS" && nvm use "$NVM_LTS"
      NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
      if [ "$NODE_MAJOR" -ge 20 ]; then
        echo "[cpx-install] Switched to Node.js $(node -v) ✓"
      else
        echo "[cpx-install] nvm install failed, please run: nvm install 20 && nvm use 20" >&2
        exit 1
      fi
    else
      echo "[cpx-install] nvm found but no Node 20 LTS available. Run: nvm install 20" >&2
      exit 1
    fi
  else
    echo "[cpx-install] No nvm detected. Install Node 20+: https://nodejs.org" >&2
    exit 1
  fi
fi

UPDATE=false
while getopts "u" opt; do
  case $opt in
    u) UPDATE=true ;;
    *) echo "Usage: $0 [-u]  (-u: force dependency update)" >&2; exit 1 ;;
  esac
done

# 1) Dependencies (tsx/fzstd/undici in proxy/node_modules — standalone, the
#    cpx runtime never requires the insight root node_modules).
# Install when missing as well as on explicit updates: covers existing
# checkouts whose node_modules predates a package.json change.
PROXY_DEPS_READY=false
if [ -d node_modules ] && npm ls --omit=dev --depth=0 >/dev/null 2>&1; then
  PROXY_DEPS_READY=true
fi
if [ "$UPDATE" = true ] || [ "$PROXY_DEPS_READY" = false ]; then
  echo "[cpx-install] Installing proxy dependencies..."
  if npm install --silent; then
    echo "[cpx-install] proxy deps installed ✓"
  else
    echo "[cpx-install] proxy npm install failed (wrapper still installed; cpx falls back to \`npx tsx\` at runtime)"
  fi
fi

# 2) Wrapper on PATH: symlink to the in-repo proxy/cpx-cli wrapper, which
#    resolves its own location and prefers proxy/node_modules/.bin/tsx
#    (falls back to repo root tsx, then npx) — runs with or without insight.
BINDIR="${CPX_BINDIR:-}"
if [ -z "$BINDIR" ]; then
  for d in /usr/local/bin "$HOME/.local/bin" "$HOME/bin"; do
    [ -d "$d" ] && [ -w "$d" ] && BINDIR="$d" && break
  done
  if [ -z "$BINDIR" ]; then
    BINDIR="$HOME/.local/bin"
    mkdir -p "$BINDIR"
  fi
  case ":$PATH:" in
    *":$BINDIR:"*) ;;
    *)
      if [ -f "$HOME/.bashrc" ]; then
        grep -q "$BINDIR" "$HOME/.bashrc" 2>/dev/null || echo "export PATH=\"$BINDIR:\$PATH\"" >> "$HOME/.bashrc"
        echo "[cpx-install] added $BINDIR to PATH via ~/.bashrc — open a new terminal or: source ~/.bashrc"
      fi
      ;;
  esac
else
  mkdir -p "$BINDIR"
fi

# Replace any previous artifact (old generated script or stale symlink).
# ln -sfn never follows an existing symlink, so the tracked repo file
# cpx-cli is never clobbered (the hazard the old `cat >` had).
chmod +x "$SCRIPT_DIR/cpx-cli"
rm -f "$BINDIR/cpx"
ln -sfn "$SCRIPT_DIR/cpx-cli" "$BINDIR/cpx"
echo "[cpx-install] cpx installed → $BINDIR/cpx ✓"

# 3) Tab 补全开箱即用（best-effort，绝不阻断安装）：与 npm 安装共用同一
#    postinstall —— bash 写用户级 bash-completion 自动加载目录，zsh 用户
#    装配 ~/.zfunc + fpath。
if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/scripts/postinstall.mjs" ]; then
  node "$SCRIPT_DIR/scripts/postinstall.mjs" || true
fi
echo '[cpx-install] 捕获无需 insight；`cpx list` 查看捕获清单，导入走 insight Web UI「Import Session → JSONL」（insight 在运行时捕获退出即自动导入）'
