// Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
// This program is free software, you can redistribute it and/or modify it under the terms and conditions of
// CANN Open Software License Agreement Version 2.0 (the "License).
// Please refer to the License for details. You should not use this file except in compliance with the License.
// THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
// INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE.
// See LICENSE in the root of the software repository for the full text of the License.

// tests 分层（与 insight 同构）：ut/ 默认跑（run-tests.sh / npm test）；
// e2e/（真 wrapper + mock insight + 浏览器副作用）显式跑：npm run test:e2e。
// 不 import 'vitest/config'：vitest 由 CLI 直接读取本文件，纯对象导出即可
// （历史上 vitest 借自兄弟仓 insight 时本包解析不到类型包；现为自有
// devDependency，保持纯对象零额外解析依赖）。

export default {
  test: {
    // 输出降噪：dot 只留进度点与末尾汇总；passed-only 静默通过用例的
    // console/stderr（git-lfs 自举提示等），失败用例的照常输出定位
    reporters: ['dot'],
    silent: 'passed-only',
    include: ['tests/ut/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    // COVERAGE=1（run-tests.sh → --coverage）：v8 provider 统计 src/ 全量；
    // 终端只打 text-summary 摘要，逐文件明细看 lcov/html；
    // provider 包 @vitest/coverage-v8 与 vitest 均为本包 devDependency
    // （provider 模块从本包目录解析，须本包自带）
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'lcov', 'html'],
    },
  },
};
