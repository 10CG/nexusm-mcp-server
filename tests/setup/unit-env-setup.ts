/**
 * 单测 setup 入口 (issue #34) —— 由 `vitest.unit.config.ts` 的 `setupFiles` 加载。
 *
 * vitest 在**每个测试文件的模块代码之前**跑一遍 setupFiles, 所以:
 *   1. 宿主环境在任何被测模块 import 之前就已经被清干净;
 *   2. 测试文件自己在模块顶层写的 `process.env.X = ...` 仍然生效 (它跑在后面),
 *      现有 `memory_search.test.ts` / `memory_feedback.test.ts` 的写法不用改;
 *   3. 上一个测试文件泄漏出来的环境变量, 到下一个文件开头会被再清一次。
 *
 * 具体策略见 `./env-isolation.ts` 的模块注释。
 */

import { scrubEnv, UNIT_ENV_BASELINE } from './env-isolation.js';

scrubEnv(process.env, { baseline: UNIT_ENV_BASELINE });
