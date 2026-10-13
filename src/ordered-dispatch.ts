// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// ordered-dispatch: emit proxy records in REQUEST-ARRIVAL order, not
// response-completion order.
//
// Why (wire-verified on a real 20-minute codex session): codex spawns
// subagents from tool_use items that complete MID-STREAM — a subagent's
// first request can arrive, and its (short) response complete, BEFORE the
// spawning round's long streaming response finishes. Emitting in completion
// order then processes the subagent's first record before the spawn's
// dispatch registration exists, mis-routing it into the MAIN thread's file
// (observed: seq 0003/0004 — two subagent first rounds — landed in main
// ahead of the spawn round seq 0002 that should have registered them).
//
// Arrival order is causally safe for every emitter dependency:
//   - dispatch registration: the spawning request always arrives before any
//     request it created (creation implies prior arrival)
//   - per-thread round order: a thread sends its next request only after
//     its previous response completed, so arrival order preserves it
//   - spawn-output enrichment: the meta rewrite is order-independent
//
// Records buffer here only while an earlier request is still in flight
// (bounded by client concurrency). Abandoned requests (upstream 502, empty
// body, error paths) submit null to keep the sequence advancing — a missing
// submit would stall every later record.

import type { ProxyRecord } from './types';

export class OrderedDispatcher {
  private next = 1;
  private readonly pending = new Map<number, ProxyRecord | null>();

  constructor(private readonly emit: (record: ProxyRecord) => void) {}

  /**
   * @param seq monotonic 1-based arrival number assigned when the request
   *            entered the proxy
   * @param record the built capture record, or null for an abandoned
   *               request (advances the sequence without emitting)
   */
  submit(seq: number, record: ProxyRecord | null): void {
    if (seq < this.next) return; // late/duplicate submit for a passed seq
    this.pending.set(seq, record);
    while (this.pending.has(this.next)) {
      const rec = this.pending.get(this.next)!;
      this.pending.delete(this.next);
      this.next++;
      if (rec == null) continue;
      try {
        this.emit(rec);
      } catch (e) {
        // 单条 emit 失败不阻塞序列推进（与 server 侧落盘失败语义一致）
        console.error('[proxy] emit failed (capture may be incomplete):', e instanceof Error ? e.message : e);
      }
    }
  }
}
