// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software; you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License").
// Please refer to the License for details. You may not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

export const ENVELOPE_KEY = 'x_lake';
export const LEGACY_ENVELOPE_KEY = 'x_cannbay';

export interface Envelope {
  schema: string;
  version: number;
  data: Record<string, unknown>;
}

function asEnvelope(v: unknown): Envelope | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const e = v as Partial<Envelope>;
  if (typeof e.schema !== 'string' || typeof e.version !== 'number' || !e.data || typeof e.data !== 'object') {
    return undefined;
  }
  return e as Envelope;
}

export function readEnvelope(holder: unknown): Envelope | undefined {
  if (!holder || typeof holder !== 'object') return undefined;
  const h = holder as Record<string, unknown>;
  return asEnvelope(h[ENVELOPE_KEY]);
}

export function readEnvelopeWithLegacy(holder: unknown): Envelope | undefined {
  if (!holder || typeof holder !== 'object') return undefined;
  const h = holder as Record<string, unknown>;
  return asEnvelope(h[ENVELOPE_KEY]) ?? asEnvelope(h[LEGACY_ENVELOPE_KEY]);
}
