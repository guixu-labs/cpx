// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ordered-dispatch 单测：emit 按「请求到达序」而非「响应完成序」。
// 真机竞态（20 分钟长会话 wire 证实）：codex 从流中渐次完成的 tool_use
// 提前拉起子代理，子代理首轮响应可先于派发轮的长流式响应完成——完成序
// emit 会把子代理首轮排到派发登记之前，误路由进主线程文件。

import { describe, it, expect } from 'vitest';
import { OrderedDispatcher } from '../../src/ordered-dispatch.ts';

describe('OrderedDispatcher: 到达序落盘', () => {
  it('完成序乱序时按到达序 emit（子代理首轮先于派发轮完成）', () => {
    const order: number[] = [];
    const d = new OrderedDispatcher((rec) => { order.push((rec as { seq: number }).seq); });
    d.submit(1, { seq: 1 } as never);
    // 真机竞态形态：seq2（派发轮，流式长）完成晚于 seq3/seq4（子代理首轮）
    d.submit(3, { seq: 3 } as never);
    d.submit(4, { seq: 4 } as never);
    expect(order).toEqual([1]); // seq2 未到，3/4 滞留缓冲
    d.submit(2, { seq: 2 } as never); // 派发轮到达 → 按序冲刷
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('墓碑（null）推进序列：502/无 body 请求不产生记录但不阻塞后继', () => {
    const order: number[] = [];
    const d = new OrderedDispatcher((rec) => { order.push((rec as { seq: number }).seq); });
    d.submit(1, { seq: 1 } as never);
    d.submit(2, null);
    d.submit(3, { seq: 3 } as never);
    expect(order).toEqual([1, 3]);
  });

  it('单条 emit 抛错不阻塞序列（后续记录继续落盘）', () => {
    const order: number[] = [];
    const d = new OrderedDispatcher((rec) => {
      const s = (rec as { seq: number }).seq;
      if (s === 2) throw new Error('ENOSPC');
      order.push(s);
    });
    d.submit(1, { seq: 1 } as never);
    d.submit(2, { seq: 2 } as never);
    d.submit(3, { seq: 3 } as never);
    expect(order).toEqual([1, 3]);
  });

  it('迟到/重复 submit 已过序号被忽略（防御 double-submit）', () => {
    const order: number[] = [];
    const d = new OrderedDispatcher((rec) => { order.push((rec as { seq: number }).seq); });
    d.submit(1, { seq: 1 } as never);
    d.submit(2, { seq: 2 } as never);
    d.submit(2, { seq: 2 } as never);
    d.submit(1, { seq: 1 } as never);
    expect(order).toEqual([1, 2]);
  });
});
