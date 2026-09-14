// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE,
// See LICENSE in the root of the software repository for the full text of the License.

// 受控双实现 parity 锁（cpx cannbay ↔ insight cannbay2）——漂移即红：
//   ① 治理文本：同脏语料 → cpx governText 与 insight governText 输出/残留
//      逐字节一致（cpx 慢路径复用自家 redactor 单一真身，行为必须与 insight
//      治理等价）
//   ② LFS 免疫常量：cpx mirror 的 per-command 中和串与 insight mirror 源码
//      中的串逐字一致（读源码文件正则抽取，防两边各自演化）
//   ③ 提交人提取：extractSubmitter 行为一致（首行协议同一网关语义）
//   ④ push URL 内置凭据同源（密文常量解码一致）

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { governText } from '../src/cannbay/govern';
import { extractSubmitter } from '../src/cannbay';
import { LFS_NEUTRALIZE } from '../src/cannbay/mirror';
import { envPushUrl } from '../src/cannbay/remote';
import { governText as insightGovernText } from '../../insight/src/lib/cannbay2/governance';

const INSIGHT_MIRROR = path.resolve(__dirname, '../../insight/src/lib/cannbay2/mirror.ts');
const INSIGHT_INDEX = path.resolve(__dirname, '../../insight/src/lib/cannbay2/index.ts');

const DIRTY_CORPUS = [
  JSON.stringify({ type: 'user', message: { content: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.auth.sig" https://x.io' } }),
  JSON.stringify({ env: 'ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890abcdef' }),
  JSON.stringify({ settings: { api_key: "sk-proj-0123456789abcdefghijklmnop", note: 'keep' } }),
  JSON.stringify({ url: 'https://example.com/v1?access_token=ya29.a0ARrdaM-token-value-1234567890&x=1' }),
  JSON.stringify({ keys: ['gsk_abcdefghijklmnopqrst', 'LTAI5tAbCdEfGhIjKlMnOpQr', 'GL-abcdefghijklmnopqrstuvwxyz123456', 'xai-abcdefghijklmnopqrstuvwx'] }),
  JSON.stringify({ keep: ['max_tokens', 'input_tokens', 'tool_use_id', 'session_id'] }),
  'plain text line without any secret',
  JSON.stringify({ auth: 'Bearer abcdefghijklmnop' }),
];

describe('cannbay 受控双实现 parity（cpx ↔ insight）', () => {
  it('① 治理文本：同脏语料输出与残留逐字节一致', () => {
    for (const line of DIRTY_CORPUS) {
      const mine = governText(line);
      const theirs = insightGovernText(line);
      expect(mine.output).toBe(theirs.output);
      expect(mine.residue).toEqual(theirs.residue);
    }
    const full = DIRTY_CORPUS.join('\n');
    const mineFull = governText(full);
    const theirsFull = insightGovernText(full);
    expect(mineFull.output).toBe(theirsFull.output);
    expect(mineFull.residue).toEqual(theirsFull.residue);
    // 清洗确实发生了（掩码形态出现），且复检零残留
    expect(mineFull.output).toContain('…');
    expect(mineFull.residue).toEqual([]);
  });

  it('② LFS 免疫常量与 insight mirror 源码逐字一致', () => {
    const src = fs.readFileSync(INSIGHT_MIRROR, 'utf8');
    const m = src.match(/const LFS_NEUTRALIZE = '([^']+)'/);
    expect(m, 'insight mirror.ts 未找到 LFS_NEUTRALIZE 常量（改名/重构须同步本测试）').toBeTruthy();
    expect(LFS_NEUTRALIZE).toBe(m![1]);
  });

  it('③ 提交人提取：与 insight 源码行为一致（源码级锁，import 会牵入 @/ 别名依赖）', () => {
    // insight index.ts 的 extractSubmitter 函数体（去空白归一）与本仓实现同构
    const body = (file: string) => {
      const src = fs.readFileSync(file, 'utf8');
      const m = src.match(/export function extractSubmitter[\s\S]*?\n}/);
      expect(m, `${file} 未找到 extractSubmitter`).toBeTruthy();
      return m![0].replace(/\s+/g, ' ');
    };
    expect(body(path.resolve(__dirname, '../src/cannbay/index.ts'))).toBe(body(INSIGHT_INDEX));
    // 行为冒烟
    expect(extractSubmitter('提交人: 张三 内容描述: x').submitter).toBe('张三 内容描述: x'); // 同 insight：regex 吃到行尾，描述剥离在 parseCommitSubject 层
    expect(extractSubmitter('无标记').error).toContain('提交人不能为空');
  });

  it('④ 内置 push 凭据同源（密文常量解码一致）', () => {
    const insightSrc = fs.readFileSync(
      path.resolve(__dirname, '../../insight/src/lib/cannbay2/remote.ts'), 'utf8',
    );
    const m = insightSrc.match(/CANNBAY2_PUSH_URL_ENCODED = '([A-Za-z0-9+/=]+)'/);
    expect(m).toBeTruthy();
    expect(envPushUrl()).toBe(Buffer.from(m![1], 'base64').toString());
  });
});
