// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details.
// You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// cpx → insight 发现契约（多人服务器：每用户一个实例、各自固定端口）：
//   CANNBOT_CPX_INSIGHT_BASE env（显式指定/IT mock，最高优先）
//   → 用户级端口登记文件（insight start.sh 服务就绪后写入；持久保留不随
//     退出删除，防「实例未运行」窗口期跨用户导入污染）
//   → localhost:21025 兜底（单人本机默认端口）
// 登记目录锚定与写侧（start.sh / npm 启动器）严格一致：dirname of
// CANNBOT_PROXY_DIR → CANNBOT_INSIGHT_HOME → ~/.cannbot-insight
// （'.cannbot-insight' 字面量是 insight pack-context 品牌翻转点，与
// src/lib/lake/server-config.ts 同口径）。
// 契约细节见 insight docs/design/multi-user/design.md。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_INSIGHT_PORT = 21025;

function registryPort(): number | null {
  try {
    const root = path.dirname(
      process.env.CANNBOT_PROXY_DIR ?? path.join(
        process.env.CANNBOT_INSIGHT_HOME ?? path.join(os.homedir(), '.cannbot-insight'),
        'proxy',
      ),
    );
    const raw = fs.readFileSync(path.join(root, 'insight-port'), 'utf-8').trim();
    const port = Number.parseInt(raw, 10);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    return null;
  } catch {
    return null;
  }
}

export function resolveInsightBase(): string {
  if (process.env.CANNBOT_CPX_INSIGHT_BASE) return process.env.CANNBOT_CPX_INSIGHT_BASE;
  const port = registryPort();
  if (port) return `http://localhost:${port}`;
  return `http://localhost:${DEFAULT_INSIGHT_PORT}`;
}
