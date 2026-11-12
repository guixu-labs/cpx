#!/usr/bin/env bash
# cpx 测试入口（供仓顶 scripts/run-tests.sh 转调，也可单独执行）。
#   ./scripts/run-tests.sh        # ut 层（默认）：tests/ut
#   ./scripts/run-tests.sh e2e    # e2e 层：tests/e2e（真 CLI/发布流水线用例）
#   追加 --coverage / -c：ut 层附带覆盖率（与 e2e 同给也仅 ut 生效）
# COVERAGE=1：ut 层附带 --coverage（v8 provider，统计 src/ 全量，报告落
# coverage/）。provider 包 @vitest/coverage-v8 与 vitest 均为本包
# devDependency，缺失时自愈 npm install。
# 依赖自举（fresh clone / 流水线一条命令可跑）：
#   1) cpx 自己的 dependencies 任一缺失（node_modules 目录级校验，含
#      package.json 后加的新依赖——只查 .bin/tsx 探测不到）→ 本包 npm install
#      —— 用例 spawn 的 proxy server 顶层 import fzstd，祖先链解析够不到
#      insight 的 node_modules，缺了必挂（.bin/tsx 同时让 server 走本地
#      PROXY_TSX，不再退 npx 走网络）
#   2) vitest 缺失（本包 devDependency）→ 本包 npm install（npm run
#      test:e2e 同样转调本脚本——vitest 不在本包 .bin 时，npm script
#      直接裸调必 command not found）
# CONTEXT_TEST_SKIP_SLOW=1：ut 层跳过已知环境敏感 it 用例（skipIf 门控），
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

# MODE（ut|e2e）与 --coverage/-c 顺序不限，其余参数报用法错误
MODE=""
for a in "$@"; do
  case "$a" in
    --coverage|-c) COVERAGE=1 ;;
    ut|e2e) MODE="$a" ;;
    *) echo "Usage: $0 [ut|e2e] [--coverage|-c]" >&2; exit 2 ;;
  esac
done
MODE="${MODE:-ut}"
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
  else
    return 1
  fi
}

# vitest 是本包 devDependency（0.1.15 起收编——此前借兄弟仓 insight 的二进制，
# 两仓存在工具面耦合；现自有依赖，仓间零依赖）。缺失自愈 = 本包 npm install。
if ! resolve_vitest; then
  echo "==> [cpx] vitest missing (own devDependency), installing..."
  npm install --no-audit --no-fund || exit 1
  resolve_vitest || { echo "vitest still missing after npm install" >&2; exit 1; }
fi

# coverage provider 从本包目录解析，
# ut 层 COVERAGE=1 且缺失时自愈安装 devDependencies（e2e 不收覆盖率，
# 不做此检查——离线环境跑 e2e 不应先挂在装依赖上）
if [ "$MODE" = "ut" ] && [ "${COVERAGE:-0}" = "1" ] && ! node -e "require.resolve('@vitest/coverage-v8')" >/dev/null 2>&1; then
  echo "==> [cpx] coverage provider missing (@vitest/coverage-v8), installing"
  npm install --no-audit --no-fund || exit 1
fi

case "$MODE" in
  ut)
    RUN_ARGS=(tests/ut)
    [ "${COVERAGE:-0}" = "1" ] && RUN_ARGS+=(--coverage)
    CONTEXT_TEST_SKIP_SLOW=1 "$VITEST" run "${RUN_ARGS[@]}"
    rc=$?
    # vitest 默认失败 run 不产报告（reportOnFailure: false），提示行只在
    # 报告实际落盘后才打，避免指向不存在的文件
    [ "${COVERAGE:-0}" = "1" ] && [ -f coverage/lcov.info ] \
      && echo "==> [cpx] 覆盖率明细: packages/cpx/coverage/index.html（浏览器）/ lcov.info"
    exit "$rc" ;;
  e2e)
    "$VITEST" run tests/e2e
    rc=$?
    # 泄漏进程不变量（insight e2e teardown「端口回收 fail-fast」的同位物）：
    # 会话代理是 cpx-cli 的子进程——cpx-cli 被超时击杀时代理可能残留。套件
    # 跑完必须零存活（锚定本仓 server.ts 全路径，绝不误伤他人）；有残留即
    # 整层判负，防「用例全绿但机器上漏了一排僵尸代理」的静默劣化。
    if [ "$rc" -eq 0 ]; then
      leaked="$(pgrep -f "$PWD/src/server\.ts" || true)"
      if [ -n "$leaked" ]; then
        echo "==> [cpx] LEAK: session proxy survived the e2e suite (pids: $leaked) — failing" >&2
        rc=1
      fi
    fi
    exit "$rc" ;;
  *)
    echo "Usage: $0 [ut|e2e]" >&2
    exit 2
    ;;
esac
