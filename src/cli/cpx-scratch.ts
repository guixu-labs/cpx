// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// 会话 scratch 治理（cpx-<pinned>.jsonl 占位 + .sids 运行清单）：
//   · dropSessionScratch —— 信号路径（SIGINT/SIGTERM）退出前的清理。正常
//     退出路径本就清理（cpx-cli 收尾段），但信号 handler 此前直接
//     process.exit 跳过收尾——每次 Ctrl+C 泄漏一个 0 字节占位 + 孤儿清单
//     （实测 2026-09-20：~/.cannbot-insight/proxy 积压三个空壳）。
//   · sweepLeakedPlaceholders —— 启动期扫除历史积压（SIGKILL 残留等信号
//     清理也到不了的形态）。纯函数：目录 + 活 pinned sid 集注入，liveness
//     判定（findProxyProcs 的 /proc 扫描）由调用方负责。
// 占位安全判据：0 字节 + 无压缩孪生 + 无伴生 meta（真实会话必有）+ 非活
// 运行。有记录的 pinned 文件是会话本体（无 header 协议的捕获目标），只清
// 清单不动文件。

import fs from 'node:fs';
import path from 'node:path';

function placeholderPaths(dir: string, pinnedSid: string): { forms: string[]; manifest: string } {
  const jsonl = path.join(dir, `cpx-${pinnedSid}.jsonl`);
  return { forms: [jsonl, `${jsonl}.7z`, `${jsonl}.gz`], manifest: path.join(dir, `cpx-${pinnedSid}.sids`) };
}

/** 信号路径退出清理：逐形态只删空件（0 字节明文/压缩占位）+ 运行清单。
 *  有记录的形态是会话本体（无 header 协议的捕获目标 / 前次运行的压缩产物），
 *  绝不触碰——信号路径零数据损失。 */
export function dropSessionScratch(dir: string, pinnedSid: string): void {
  const { forms, manifest } = placeholderPaths(dir, pinnedSid);
  for (const f of forms) {
    try {
      if (fs.existsSync(f) && fs.statSync(f).size === 0) fs.rmSync(f);
    } catch { /* best-effort */ }
  }
  try {
    if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
  } catch { /* best-effort */ }
}

/** 扫除泄漏占位：0 字节 cpx-<sid>.jsonl、无压缩孪生、无伴生 meta、非活运行
 *  （livePinned）→ 删占位 + 伴生 .sids 清单。返回扫除数（仅用于日志）。 */
export function sweepLeakedPlaceholders(dir: string, livePinned: Set<string>): number {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let swept = 0;
  for (const name of names) {
    const m = name.match(/^(cpx-[\w.-]+)\.jsonl$/);
    if (!m) continue;
    const stem = m[1];
    const plain = path.join(dir, name);
    try {
      const st = fs.statSync(plain);
      if (st.size !== 0) continue;
      if (fs.existsSync(`${plain}.7z`) || fs.existsSync(`${plain}.gz`)) continue;
      const sid = stem.replace(/^cpx-/, '');
      if (livePinned.has(sid)) continue;
      // 伴生 meta（cpx-<sid>.meta.json，emitter 首次主发射即写）＝真实会话
      // 产物，绝不视为占位
      if (fs.existsSync(path.join(dir, `cpx-${sid}.meta.json`))) continue;
      fs.rmSync(plain);
      const manifest = path.join(dir, `cpx-${sid}.sids`);
      if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
      swept++;
    } catch { /* raced/deleted */ }
  }
  return swept;
}
