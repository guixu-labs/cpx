#!/usr/bin/env bash
# cpx 测试入口（供仓顶 scripts/run-tests.sh 转调，也可单独执行）。
#   ./scripts/run-tests.sh        # ut 层（默认）：tests/ut
#   ./scripts/run-tests.sh e2e    # e2e 层：tests/e2e（真 CLI/发布流水线用例）
# 依赖自举（fresh clone / 流水线一条命令可跑）：
#   1) cpx 自己的 dependencies 任一缺失（node_modules 目录级校验，含
#      package.json 后加的新依赖——只查 .bin/tsx 探测不到）→ 本包 npm install
#      —— 用例 spawn 的 proxy server 顶层 import fzstd，祖先链解析够不到
#      insight 的 node_modules，缺了必挂（.bin/tsx 同时让 server 走本地
#      PROXY_TSX，不再退 npx 走网络）
#   2) vitest 仍缺（cpx 未声明该依赖）→ 借同仓 insight 的，必要时替它装好
#      （npm run test:e2e 同样转调本脚本——vitest 不在本包 .bin，npm script
#      直接裸调必 command not found）
# CANNBOT_TEST_SKIP_SLOW=1：ut 层跳过已知环境敏感 it 用例（skipIf 门控），
# 避免流水线误红；e2e 层不设，透传环境由调用方控制。
#
# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software, you can redistribute it and/or modify it under the terms and conditions of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.
set -u

MODE="${1:-ut}"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

deps_complete() {
  node -e '
    const fs = require("fs"), path = require("path");
    const deps = Object.keys(JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies || {});
    const missing = deps.filter((d) => !fs.existsSync(path.join("node_modules", d)));
    if (missing.length) { console.error("missing deps: " + missing.join(" ")); process.exit(1); }
  '
}

if [ ! -x node_modules/.bin/tsx ] || ! deps_complete; then
  echo "==> [cpx] deps missing/incomplete, running npm install"
  npm install --no-audit --no-fund || exit 1
  { [ -x node_modules/.bin/tsx ] && deps_complete; } \
    || { echo "deps still incomplete after npm install" >&2; exit 1; }
fi

resolve_vitest() {
  if [ -x node_modules/.bin/vitest ]; then
    VITEST="node_modules/.bin/vitest"
  elif [ -x ../insight/node_modules/.bin/vitest ]; then
    VITEST="../insight/node_modules/.bin/vitest"
  else
    return 1
  fi
}

if ! resolve_vitest; then
  echo "==> [cpx] insight deps missing (cpx borrows its vitest), installing..."
  (cd ../insight && npm install --no-audit --no-fund) || exit 1
  resolve_vitest || { echo "vitest still missing after npm install" >&2; exit 1; }
fi

case "$MODE" in
  ut) CANNBOT_TEST_SKIP_SLOW=1 "$VITEST" run tests/ut ;;
  e2e) "$VITEST" run tests/e2e ;;
  *)
    echo "Usage: $0 [ut|e2e]" >&2
    exit 2
    ;;
esac
