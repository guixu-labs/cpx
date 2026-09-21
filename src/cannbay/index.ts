// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx 直传编排（与 insight uploadCannbay2Session 的 cpx-源路径同构，但零 DB
// 依赖——staging 直接从捕获目录取 cpx 原生产物）：
//   staging：cpx-<sid>.jsonl(.7z|.gz|.jsonl) → 统一转 7z → sessions/<sid>/<sid>.jsonl.7z、
//            cpx-<sid>.meta.json → <sid>.meta.json（opGen 标注入）、
//            <sid>/subagents/ 白名单拷贝（同样转 7z——存量 gz 上传时迁移到新格式）
//   网关：提交人（description 首行协议）+ 范式目录（默认仓动态白名单，
//         与 insight validateCategory 同规则）
//   上传：governStagedSession → uploadFolder（commit message 与 insight
//         同构：description + 空行 body 的「范式: <dir>（baseline）」行）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCannbayRemote, type CannbayRemote } from './remote';
import { listParadigmDirs, uploadFolder } from './mirror';
import { governStagedSession, GovernanceError } from './govern';
import { ensureLfsBinaryAvailable, type LfsSetupDeps } from '../lfs-setup';
import { ensure7z } from '../compression';

export { GovernanceError } from './govern';

export function extractSubmitter(description: string | undefined): { submitter: string; error: string | null } {
  const m = (description ?? '').match(/提交人[ \t]*[:：][ \t]*(.*)/);
  const submitter = m ? m[1].trim() : '';
  if (!submitter) {
    return { submitter: '', error: '提交人不能为空：请在提交信息中填写「提交人: <姓名>」（如「提交人: 张三」），不能使用默认值' };
  }
  return { submitter, error: null };
}

/** 范式目录网关（与 insight validateCategory 同规则）：默认仓必填且必须是
 * 数据仓现存顶层目录（动态白名单，防 typo 凭空造目录）。 */
export function validateCategory(remote: CannbayRemote, category?: string): string {
  const value = category?.trim() || '';
  if (!value) {
    throw new Error('范式目录必填：请选择上传目标范式目录（数据仓顶层目录，新增范式请先在数据仓建目录）');
  }
  if (!/^[\w.-]+$/.test(value)) throw new Error(`Invalid paradigm dir: "${value.slice(0, 40)}"`);
  if (value === remote.rootDir) throw new Error(`"${value}" 是存量会话区，不能作为范式目录`);
  if (!listParadigmDirs(remote).includes(value)) {
    // agent 自纠闭环：错误信息附完整白名单，执行方（agent/脚本）一次重试即可选对
    throw new Error(`范式目录 "${value}" 在数据仓中不存在：请从下列可选目录中重选：${listParadigmDirs(remote).join(', ')}（新增范式请先在数据仓建目录）`);
  }
  return value;
}

function annotateOpGen(stagingDir: string, sid: string, opGen?: 'success' | 'failure'): void {
  if (opGen !== 'success' && opGen !== 'failure') return;
  const metaPath = path.join(stagingDir, 'sessions', sid, `${sid}.meta.json`);
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const xb = meta?.x_cannbay;
    if (xb?.schema === 'cc-session-meta' && xb.data && typeof xb.data === 'object') {
      xb.data.opGen = opGen;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    }
  } catch { /* meta 缺失/畸形：跳过标注，不阻断上传 */ }
}

export interface UploadCaptureOptions {
  sid: string;
  /** 捕获主文件（cpx-<sid>.jsonl 或 .jsonl.gz） */
  captureFile: string;
  description: string;
  category?: string;
  baseline?: boolean;
  opGen?: 'success' | 'failure';
  remote?: CannbayRemote;
  /** git-lfs 自举依赖注入（测试用；缺省真下载） */
  lfsDeps?: LfsSetupDeps;
}

export interface UploadCaptureResult {
  sid: string;
  folder: string;
  unchanged: boolean;
  gitattributesFixed: boolean;
}

/** cpx 捕获会话直传 CANNBay（零 DB / 零 insight 依赖）。 */
export async function uploadCaptureSession(opts: UploadCaptureOptions): Promise<UploadCaptureResult> {
  const { sid: rawSid } = opts;
  const sid = rawSid.replace(/^cpx-/, '');
  if (!/^[\w.-]+$/.test(sid)) throw new Error(`Invalid session id: "${sid}"`);
  const { error: submitterError } = extractSubmitter(opts.description);
  if (submitterError) throw new Error(submitterError);
  const remote = opts.remote ?? resolveCannbayRemote();
  // LFS 模式 git-lfs 自举（系统件 > 私有件 > 自动下载，staging/治理/镜像操作
  // 之前；全部失败抛指引错误——ensureLfsReady 仍兜底）
  if (remote.lfs) await ensureLfsBinaryAvailable(opts.lfsDeps);
  if (opts.baseline && !opts.category?.trim()) {
    throw new Error('baseline 上传仅在默认仓且选中范式目录时可用');
  }
  const categoryValue = validateCategory(remote, opts.category);

  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `cpx-cannbay-staging-${sid}-`));
  try {
    const sessionDir = path.join(stagingDir, 'sessions', sid);
    fs.mkdirSync(sessionDir, { recursive: true });
    // 三形态候选：调用方传已解析路径（必在）；裸 stem 兜底 .7z > .gz。
    // staging 统一 ensure7z 出仓（存量 gz 上传时借此迁移到新格式——湖内同
    // sid 重传整体替换语义）
    let src = opts.captureFile;
    if (!fs.existsSync(src)) {
      src = [`${opts.captureFile}.7z`, `${opts.captureFile}.gz`].find(f => fs.existsSync(f)) ?? src;
    }
    if (!fs.existsSync(src)) throw new Error(`capture not found: ${opts.captureFile}(.7z/.gz)`);
    const srcExt = src.endsWith('.7z') ? '.7z' : src.endsWith('.gz') ? '.gz' : '';
    const stagedMain = path.join(sessionDir, `${sid}.jsonl${srcExt}`);
    fs.copyFileSync(src, stagedMain);
    ensure7z(stagedMain);

    // 伴生 meta：writer 现代际 cpx-<sid>.meta.json / 旧代际 <sid>.meta.json 双候选
    const capDir = path.dirname(src);
    const metaCandidates = [path.join(capDir, `cpx-${sid}.meta.json`), path.join(capDir, `${sid}.meta.json`)];
    const siblingMeta = metaCandidates.find(m => fs.existsSync(m));
    if (siblingMeta) {
      fs.copyFileSync(siblingMeta, path.join(sessionDir, `${sid}.meta.json`));
    } else {
      throw new Error(`session meta missing for "${sid}"（cpx 捕获必带 cc-session-meta）`);
    }

    // subagents 随行（白名单拷贝：杂散文件不清洗也不该出公开仓）；拷入后
    // 同样 ensure7z —— 湖内出仓形态统一为新格式
    const subagentsDir = path.join(capDir, sid, 'subagents');
    if (fs.existsSync(subagentsDir)) {
      const dest = path.join(sessionDir, 'subagents');
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(subagentsDir, { withFileTypes: true })) {
        if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.gz') || entry.name.endsWith('.jsonl.7z') || entry.name.endsWith('.json'))) {
          fs.copyFileSync(path.join(subagentsDir, entry.name), path.join(dest, entry.name));
          if (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.gz')) {
            ensure7z(path.join(dest, entry.name));
          }
        }
      }
    }

    annotateOpGen(stagingDir, sid, opts.opGen);
    governStagedSession(stagingDir, sid);
    // 范式行必须放 body（git %s 会把 subject 折叠成单行，混进 subject 会
    // 污染提交人/描述提取）——与 insight commit message 同构
    const commitMessage = opts.description.trim() + (categoryValue ? `\n\n范式: ${categoryValue}${opts.baseline ? '（baseline）' : ''}` : '');
    const result = await uploadFolder(stagingDir, sid, commitMessage, remote, categoryValue, opts.baseline);
    return { sid, ...result };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function listCannbayDirs(remote: CannbayRemote = resolveCannbayRemote()): string[] {
  return listParadigmDirs(remote);
}
