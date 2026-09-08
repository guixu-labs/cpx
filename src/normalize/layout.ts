// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software: you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// normalize 层的输出布局（已退役出默认链路：退出路径直读 verbatim 导入，
// 本模块仅 `cpx normalize` 兼容命令按需调用；存量 norm/ 件不迁移不删除）。
// 布局镜像 insight 原生 claude-jsonl 的 <parentDir>/<sessionId>/subagents/
// 子代理发现约定：
//
//   PROXY_DIR/
//   ├── cpx-<sid>.jsonl.gz           verbatim 捕获（gzip at rest；live 态明文）—— insight 直读导入
//   ├── <sid>/subagents/*.jsonl.gz   verbatim 子代理捕获
//   └── norm/                        （兼容产物，手动生成）
//       ├── <sid>.jsonl.gz           规范化主文件
//       └── <sid>/subagents/         规范化子代理 + meta.json 副本（meta 明文）
//
// 导入 norm/<sid>.jsonl.gz 时 sessionId 取文件名 stem = <sid>，子代理发现
// 解析为 dirname(norm/<sid>.jsonl.gz)/<sid>/subagents = norm/<sid>/subagents ✓。
// 压缩是传输编码（docs/COMPRESSION-DESIGN.md）：行流内容与明文形态逐字节
// 一致，insight parseJsonlLines 透明解压。

import path from 'node:path';
import { PROXY_DIR } from '../writer';

function dir(): string {
  return process.env.CANNBOT_PROXY_DIR ?? PROXY_DIR;
}

export function normDir(): string {
  return path.join(dir(), 'norm');
}

export function normMainFile(sid: string): string {
  return path.join(normDir(), `${sid}.jsonl`);
}

export function normMainMetaFile(sid: string): string {
  return path.join(normDir(), `${sid}.meta.json`);
}

export function normSubagentDir(sid: string): string {
  return path.join(normDir(), sid, 'subagents');
}

export function normSubagentFile(sid: string, subId: string): string {
  return path.join(normSubagentDir(sid), `${subId}.jsonl`);
}

export function captureSubagentDir(sid: string): string {
  return path.join(dir(), sid, 'subagents');
}

// 捕获文件名 stem 即 session id；顶层捕获带 cpx- 前缀（writer.captureStem，
// 防与原生 claude jsonl 归档混放时撞名），剥掉后 subagents 目录（无前缀，
// writer.subagentFilePath 的约定）才能对上。
export function sidOfCapture(captureFile: string): string {
  return path.basename(captureFile).replace(/\.jsonl(\.gz)?$/, '').replace(/^cpx-/, '');
}
