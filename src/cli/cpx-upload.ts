// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// cpx upload —— CANNBay 直传编排（零 insight 依赖：staging/治理/git push 在
// 本包 cannbay/ 内完成，insight 仅作可选增强——在跑则预填 query/model 并顺带
// 导入）。必选信息双轨不变：提交人（description 首行协议）+ 范式目录（默认仓
// 动态白名单，直连镜像拉取后编号选择）；TTY 向导 / 非交互 flag。
// governance 拒绝与 git 错误原样呈现，捕获保留本地零丢失。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import zlib from 'node:zlib';
import { uploadCaptureSession, listCannbayDirs, GovernanceError } from '../cannbay';
import { redactRemoteSecrets } from '../cannbay/remote';

const INSIGHT_PORT = 21025;
// 与 cpx-cli 同源：环境可覆写（IT 用 mock insight 走完整链路）
const DEFAULT_INSIGHT_BASE = process.env.CANNBOT_CPX_INSIGHT_BASE ?? `http://localhost:${INSIGHT_PORT}`;

function captureDir(): string {
  return process.env.CANNBOT_PROXY_DIR ?? path.join(os.homedir(), '.cannbot-insight', 'proxy');
}

export function parseUploadArgs(argv: string[]): { flags: UploadFlags } | { error: string } {
  const flags: UploadFlags = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--submitter' || a === '--desc' || a === '--category') {
      const v = argv[++i];
      if (!v) return { error: `${a} 需要一个值` };
      if (a === '--submitter') flags.submitter = v;
      else if (a === '--desc') flags.desc = v;
      else flags.category = v;
    } else if (a === '--opgen') {
      const v = argv[++i];
      if (v !== 'success' && v !== 'failure') return { error: `--opgen 仅接受 success|failure，收到 "${v}"` };
      flags.opgen = v;
    } else if (a === '--baseline') {
      flags.baseline = true;
    } else if (a.startsWith('--')) {
      return { error: `未知参数: ${a}` };
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return { error: `只接受一个位置参数（sid），收到 ${positional.length} 个` };
  if (positional[0]) flags.sid = positional[0];
  return { flags };
}

/** 提交人预填：git config user.name（与 git 提交人语义同源）→ $USER 兜底。 */
export function defaultSubmitter(env: NodeJS.ProcessEnv = process.env): string {
  try {
    const g = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8', timeout: 5000 });
    const name = g.status === 0 ? (g.stdout ?? '').trim() : '';
    if (name) return name;
  } catch { /* git 不存在时走 env 兜底 */ }
  return env.USER ?? env.LOGNAME ?? '';
}

export interface CaptureTarget {
  sid: string;
  file: string;
  mtimeMs: number;
}

type FetchLike = typeof fetch;

export interface UploadFlags {
  sid?: string;
  submitter?: string;
  desc?: string;
  category?: string;
  opgen?: 'success' | 'failure';
  baseline?: boolean;
}

/**
 * sid（容忍 cpx- 前缀）→ 捕获文件（明文/压缩双形态互认）；无 sid 时取最新
 * 非空捕获（补传最常见目标就是"刚才那个会话"）。
 */
export function resolveCaptureTarget(sid: string | undefined, dir: string): CaptureTarget | { error: string } {
  if (sid) {
    const stem = sid.replace(/^cpx-/, '');
    const candidates = [
      path.join(dir, `cpx-${stem}.jsonl.gz`), path.join(dir, `${stem}.jsonl.gz`),
      path.join(dir, `cpx-${stem}.jsonl`), path.join(dir, `${stem}.jsonl`),
    ];
    const file = candidates.find(f => fs.existsSync(f) && fs.statSync(f).size > 0);
    if (!file) return { error: `capture not found: ${candidates.join(', ')}（cpx list 查看已有捕获）` };
    return { sid: stem, file, mtimeMs: fs.statSync(file).mtimeMs };
  }
  let best: CaptureTarget | null = null;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const e of entries) {
    const m = e.name.match(/^(?:cpx-)?([\w.-]+)\.jsonl(\.gz)?$/);
    if (!m || !e.isFile()) continue;
    const file = path.join(dir, e.name);
    const st = fs.statSync(file);
    if (st.size === 0) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { sid: m[1], file, mtimeMs: st.mtimeMs };
  }
  if (!best) return { error: `无捕获会话（目录 ${dir} 为空；cpx list 查看）` };
  return best;
}

/**
 * env 会话工牌换算（CPX_SESSION_ID → 捕获目标）：工牌是 cpx 的 pinned sid，
 * claude 等框架的真实捕获按 request header 的真实 sid 落盘——经
 * `<pinned>.sids` 清单映射后取 mtime 最新的真实会话；generic 等场景工牌
 * 即真实 sid，直接命中。env 未命中时调用方回落"最新"。
 */
export function resolveSessionByEnv(envSid: string, dir: string): CaptureTarget | null {
  const stem = envSid.replace(/^cpx-/, '');
  const direct = resolveCaptureTarget(stem, dir);
  if ('sid' in direct) return direct;
  const sidsFile = path.join(dir, `cpx-${stem}.sids`);
  try {
    const realSids = fs.readFileSync(sidsFile, 'utf-8').split('\n').map(x => x.trim()).filter(Boolean);
    let best: CaptureTarget | null = null;
    for (const s of realSids) {
      const t = resolveCaptureTarget(s, dir);
      if ('sid' in t && (!best || t.mtimeMs > best.mtimeMs)) best = t;
    }
    return best;
  } catch {
    return null;
  }
}

/** 上传 sidecar（cpx-<sid>.upload.json）：agent 收尾上传的记忆——退出路径
 * autoupload 与手动补传据此免交互复用；捕获无新增则静默跳过。 */
export interface UploadStash {
  category: string;
  submitter: string;
  opGen?: 'success' | 'failure';
  desc?: string;
  capturedBytes: number;
  at: string;
}

function stashPathFor(captureFile: string): string {
  return captureFile.replace(/\.jsonl(\.gz)?$/, '.upload.json');
}

export function readUploadStash(captureFile: string): UploadStash | null {
  try {
    const raw = JSON.parse(fs.readFileSync(stashPathFor(captureFile), 'utf8')) as UploadStash;
    return typeof raw.category === 'string' && typeof raw.submitter === 'string' && typeof raw.capturedBytes === 'number' ? raw : null;
  } catch {
    return null;
  }
}

export function writeUploadStash(captureFile: string, stash: UploadStash): void {
  try {
    fs.writeFileSync(stashPathFor(captureFile), JSON.stringify(stash, null, 2) + '\n');
  } catch { /* 记忆失败不阻断上传结果 */ }
}

/** 会话当前逻辑字节量（主捕获 + subagents，统一解压后计——快照时明文、
 * 退出后压缩，raw 字节天然不等，逻辑字节才可比）：sidecar 增量判定基准。 */
export function captureBytes(target: CaptureTarget): number {
  let total = 0;
  const add = (file: string) => {
    try {
      const buf = fs.readFileSync(file);
      total += (file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).length;
    } catch { /* 竞态删除忽略 */ }
  };
  add(target.file);
  const subDir = path.join(path.dirname(target.file), target.sid, 'subagents');
  try {
    for (const e of fs.readdirSync(subDir, { withFileTypes: true })) {
      if (e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.gz'))) {
        add(path.join(subDir, e.name));
      }
    }
  } catch { /* 无 subagents */ }
  return total;
}

export interface SessionInfo {
  framework: string | null;
  model: string | null;
  startTime: string | null;
  endTime: string | null;
  firstQuery: string | null;
}

/** 伴生 meta.json（cc-session-meta）读 framework；失败仅降级为 null。 */
export function readMetaFramework(file: string): string | null {
  try {
    const metaFile = file.replace(/\.jsonl(\.gz)?$/, '.meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return meta?.x_cannbay?.data?.framework ?? null;
  } catch { return null; }
}

function fmtLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * description 行协议（与 Web UI 同构；后端网关从首行「提交人:」提取提交人）：
 *   提交人: <submitter>
 *   内容描述: <desc>            ← 可选，缺省省略整行
 *   日志路径: <capture file>
 *   备注: 框架 <fw>, 模型 <model>, 时间 <start → end / 文件 mtime>
 */
export function buildUploadDescription(
  target: CaptureTarget, info: SessionInfo, submitter: string, contentDesc: string,
): string {
  const descLine = contentDesc.trim() ? `内容描述: ${contentDesc.trim()}\n` : '';
  const time = info.startTime || info.endTime
    ? `${fmtLocal(Date.parse(info.startTime ?? info.endTime))} → ${fmtLocal(Date.parse(info.endTime ?? info.startTime))}`
    : fmtLocal(target.mtimeMs);
  const note = [
    `框架 ${info.framework ?? '-'}`,
    info.model ? `模型 ${info.model}` : null,
    `时间 ${time}`,
  ].filter(Boolean).join(', ');
  return `提交人: ${submitter.trim()}\n${descLine}日志路径: ${target.file}\n备注: ${note}`;
}

export interface WizardAnswers {
  submitter: string;
  desc: string;
  category: string;
  opgen: 'success' | 'failure' | undefined;
  baseline: boolean;
}

interface RlLike { question(q: string): Promise<string>; close(): void }

/**
 * TTY 向导：全项有默认（提交人=git 提交人、目录=第 1 个范式、opgen=跳过、
 * 描述=会话首问、baseline=N），连按回车即完成；提交人/目录为数据层硬必选，
 * 默认值为空或目录列表为空时循环追问。
 */
export async function promptUploadInfo(
  rl: RlLike, flags: UploadFlags, dirsRaw: string[], defaultSub: string, defaultDesc: string,
): Promise<WizardAnswers> {
  // sessions = 存量会话区（rootDir），不是范式目录；双保险过滤（API 侧已滤）
  const dirs = dirsRaw.filter(d => d !== 'sessions');
  let submitter = (flags.submitter ?? '').trim() || defaultSub.trim();
  while (true) {
    const ans = (await rl.question(`提交人（必填，真实姓名或账号${submitter ? `，回车 = ${submitter}` : ''}）: `)).trim();
    if (ans) submitter = ans;
    if (submitter) break;
  }

  let category = (flags.category ?? '').trim();
  if (!category) {
    if (dirs.length === 0) {
      while (!category) category = (await rl.question('范式目录（必填，数据仓暂无范式目录，手输数据仓已有顶层目录名）: ')).trim();
    } else {
      const list = dirs.map((d, i) => `  ${i + 1}) ${d}`).join('\n');
      const ans = (await rl.question(`范式目录（必填，编号或全名，回车 = 1）:\n${list}\n> `)).trim();
      const idx = Number(ans) - 1;
      category = ans === '' ? dirs[0] : (Number.isInteger(idx) && idx >= 0 && idx < dirs.length ? dirs[idx] : ans);
    }
  }

  const opgenAns = (await rl.question('算子生成结果 [s]成功 / [f]失败 / 回车=跳过: ')).trim().toLowerCase();
  const opgen = opgenAns === 's' || opgenAns === 'success' ? 'success'
    : opgenAns === 'f' || opgenAns === 'failure' ? 'failure' : undefined;

  const shownDesc = defaultDesc.length > 60 ? defaultDesc.slice(0, 60) + '…' : defaultDesc;
  let desc = (await rl.question(`内容描述（选填，回车 = 预填会话首问${shownDesc ? `：${shownDesc}` : '（无）'}）: `));
  if (!desc.trim()) desc = defaultDesc;

  let baseline = false;
  if (category) {
    const bAns = (await rl.question('baseline（范式基准会话，勾选即换）? [y/N]: ')).trim().toLowerCase();
    baseline = bAns === 'y' || bAns === 'yes';
  }
  return { submitter, desc, category, opgen, baseline };
}

export interface UploadDeps {
  insightBase?: string;
  fetchImpl?: FetchLike;
  isTTY?: boolean;
  rl?: RlLike;
  env?: NodeJS.ProcessEnv;
  defaultSubmitterImpl?: () => string;
  uploadImpl?: typeof uploadCaptureSession;
  proxyDir?: string;
  listDirsImpl?: () => string[];
  log?: (msg: string) => void;
  err?: (msg: string) => void;
}

/** 编排：确保导入 → 收集必选信息 → 上传。返回进程退出码。 */
export async function runUpload(argv: string[], deps: UploadDeps = {}): Promise<number> {
  const log = deps.err ?? ((m: string) => console.error(`[cpx-cli] ${m}`));
  const out = deps.log ?? ((m: string) => console.log(m));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const insightBase = deps.insightBase ?? DEFAULT_INSIGHT_BASE;
  const isTTY = deps.isTTY ?? !!(process.stdin.isTTY && process.stdout.isTTY);

  const parsed = parseUploadArgs(argv);
  if ('error' in parsed) { log(parsed.error); log('用法: cpx upload [sid] [--submitter 名字] [--category 范式] [--desc 描述] [--opgen success|failure] [--baseline]'); return 2; }
  const cliFlags = parsed.flags;

  // 会话定位链：显式 sid > env 工牌（CPX_SESSION_ID，agent 收尾裸跑场景，
  // pinned→真实 sid 经 .sids 清单换算）> mtime 最新
  const dir = deps.proxyDir ?? captureDir();
  const envSid = (deps.env ?? process.env).CPX_SESSION_ID;
  let target: CaptureTarget | { error: string };
  if (cliFlags.sid) target = resolveCaptureTarget(cliFlags.sid, dir);
  else if (envSid) target = resolveSessionByEnv(envSid, dir) ?? resolveCaptureTarget(undefined, dir);
  else target = resolveCaptureTarget(undefined, dir);
  if ('error' in target) { log(target.error); return 2; }
  log(`upload: ${target.sid} ← ${path.basename(target.file)}`);

  // sidecar 记忆：上次上传的信息（agent 收尾上传所写）——显式 flag 之外的
  // 缺省全部由此补齐；捕获字节量没变且未带新信息 = 已传过 → 静默跳过（退出
  // 路径 autoupload / 手动补传都不再弹向导问一遍；带了信息 flag 则重传替换）
  const stash = readUploadStash(target.file);
  const hasInfoFlags = !!(cliFlags.category || cliFlags.submitter || cliFlags.opgen || cliFlags.desc);
  if (stash && !hasInfoFlags && captureBytes(target) === stash.capturedBytes) {
    log(`已上传过（${stash.at}，提交人=${stash.submitter} 范式=${stash.category}）且捕获无新增 —— 跳过`);
    return 0;
  }
  const flags: UploadFlags = {
    ...cliFlags,
    submitter: cliFlags.submitter ?? stash?.submitter,
    category: cliFlags.category ?? stash?.category,
    desc: cliFlags.desc ?? stash?.desc,
    opgen: cliFlags.opgen ?? stash?.opGen,
  };

  // 直传模式（零 insight 依赖）：insight 仅作可选增强——在跑则 observe 直查
  // 取 query/model/时间做预填（顺带机会主义导入），不在跑完全不影响上传
  const info: SessionInfo = { framework: readMetaFramework(target.file), model: null, startTime: null, endTime: null, firstQuery: null };
  let insightUp = false;
  try {
    const probe = await fetchImpl(`${insightBase}/api/observe/data?pageSize=1`, { signal: AbortSignal.timeout(1500) });
    insightUp = probe.ok || probe.status < 500;
  } catch { /* insight 不在：直传照常 */ }
  if (insightUp) {
    try {
      const r = await fetchImpl(`${insightBase}/api/observe/session?sessionId=${encodeURIComponent(target.sid)}`, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const data = (await r.json()) as { sessions?: Array<{ query?: string | null; model?: string | null; framework?: string | null; startTime?: string | null; endTime?: string | null }> };
        const s = data.sessions?.[0];
        if (s) {
          info.firstQuery = s.query ?? null;
          info.model = s.model ?? null;
          info.startTime = s.startTime ?? null;
          info.endTime = s.endTime ?? null;
          if (s.framework) info.framework = s.framework;
        }
      }
    } catch { /* 预填失败不阻断 */ }
    if (!info.firstQuery) {
      try {
        const r = await fetchImpl(`${insightBase}/api/ingest/import-file`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: 'claude-jsonl', sessionId: target.sid, filePath: target.file }),
          signal: AbortSignal.timeout(120000),
        });
        if (r.ok) {
          const data = (await r.json()) as { imported?: boolean; query?: string | null };
          if (data.imported) log(`  imported → ${insightBase}/session/${target.sid}`);
          if (data.query) info.firstQuery = data.query;
        }
      } catch { /* 导入失败不影响直传 */ }
    }
  }

  // 范式目录动态白名单（默认仓必选）：直连数据仓镜像拉取；失败时向导降级手输
  let dirs: string[] = [];
  try {
    dirs = (deps.listDirsImpl ?? listCannbayDirs)();
  } catch (e) {
    log(`范式目录列表拉取失败（${e instanceof Error ? redactRemoteSecrets(e.message) : String(e)}）—— 向导手输兜底，网关最终把关`);
  }

  // 提交人解析：flag > stash（已并入 flags）> git user.name（agent 收尾/
  // 脚本场景的机器自动值，向导/非交互统一生效）——都空才算缺
  const effSubmitter = (flags.submitter ?? '').trim()
    || (deps.defaultSubmitterImpl ?? (() => defaultSubmitter(deps.env ?? process.env)))();
  if (effSubmitter) flags.submitter = effSubmitter;

  const flagsComplete = !!(flags.submitter ?? '').trim() && !!(flags.category ?? '').trim();
  const fromFlags = (): WizardAnswers => ({
    submitter: flags.submitter!.trim(),
    desc: ((flags.desc ?? '').trim() || info.firstQuery) ?? '',
    category: flags.category!.trim(),
    opgen: flags.opgen,
    baseline: flags.baseline === true,
  });
  let answers: WizardAnswers | null = null;
  if (flagsComplete) {
    answers = fromFlags();
  } else if (isTTY || deps.rl) {
    const rl = deps.rl ?? readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const defaultSub = (flags.submitter ?? '').trim() || (deps.defaultSubmitterImpl ?? (() => defaultSubmitter(deps.env)))();
      const defaultDesc = ((flags.desc ?? '').trim() || info.firstQuery) ?? '';
      answers = await promptUploadInfo(rl, flags, dirs, defaultSub, defaultDesc);
    } catch (e) {
      // 死 tty（SIGHUP 陪跑后的退出路径）readline 会 EIO：flag 齐已在上面直传，
      // 这里必缺 → 指路补传，绝不让向导崩掉收尾
      log(`向导不可用（${e instanceof Error ? e.message : String(e)}）—— 捕获保留本地，tty 恢复后 cpx upload ${target.sid} 补传`);
      return 1;
    } finally { rl.close(); }
  } else {
    const missing: string[] = [];
    if (!(flags.submitter ?? '').trim()) missing.push('--submitter（或用交互模式）');
    if (!(flags.category ?? '').trim()) missing.push('--category（范式目录，默认仓必选）');
    log(`非交互环境缺少必选信息: ${missing.join('、')}`);
    // agent 自纠闭环：缺目录时附白名单，执行方一次重试即可选对
    if (!(flags.category ?? '').trim() && dirs.length > 0) log(`可选范式目录: ${dirs.join(', ')}`);
    log('脚本/管道场景请用 flag 给齐；终端下直接 cpx upload 走向导向导');
    return 2;
  }
  const wizardAnswers = answers!;

  const description = buildUploadDescription(target, info, wizardAnswers.submitter, wizardAnswers.desc);
  log(`uploading: 提交人=${wizardAnswers.submitter} 范式=${wizardAnswers.category}${wizardAnswers.baseline ? '（baseline）' : ''}${wizardAnswers.opgen ? ` opgen=${wizardAnswers.opgen}` : ''} …`);
  try {
    const result = await (deps.uploadImpl ?? uploadCaptureSession)({
      sid: target.sid,
      captureFile: target.file,
      description,
      category: wizardAnswers.category,
      baseline: wizardAnswers.baseline || undefined,
      opGen: wizardAnswers.opgen,
    });
    out(`✅ uploaded → ${result.folder}${result.unchanged ? '（内容未变，跳过推送）' : ''}`);
    log('  cannbay : insight Web UI「CANNBay」列表可见（无需 insight 在运行）');
    // sidecar 记忆：记录本次上传信息与捕获字节量——后续 autoupload/补传
    // 据此免交互复用、无新增静默跳过
    writeUploadStash(target.file, {
      category: wizardAnswers.category,
      submitter: wizardAnswers.submitter,
      opGen: wizardAnswers.opgen,
      desc: wizardAnswers.desc,
      capturedBytes: captureBytes(target),
      at: new Date().toISOString(),
    });
    return 0;
  } catch (e) {
    if (e instanceof GovernanceError) {
      log(`governance 拒绝: ${e.message} —— 捕获保留本地，检查会话内容后重传`);
    } else {
      log(`upload failed: ${redactRemoteSecrets(e instanceof Error ? e.message : String(e))} —— 捕获保留本地零丢失，可重试 cpx upload ${target.sid}`);
    }
    return 1;
  }
}
