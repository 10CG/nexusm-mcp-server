/**
 * 集成测试 setup 入口 (issue #34) —— 由 `vitest.integration.config.ts` 的
 * `setupFiles` 加载。
 *
 * 与单测的两点差别:
 *
 * 1. **保留 `NEXUS_TEST_*`**。它们是这一档测试故意的输入 (CI 里由 Forgejo
 *    secret 注入), 决定 `mcp_protocol.test.ts` 的 E2E 套件是真跑还是
 *    `describe.skipIf` 跳过。清掉就等于把 E2E 永久静默跳过。
 *
 * 2. **不装 auth 基线**。`cross_substory.test.ts` 在模块顶层设自己的 sentinel;
 *    `mcp_protocol.test.ts` 从 `NEXUS_TEST_*` 显式构造子进程的三件套。这里再
 *    塞一份假的 `NEXUS_API_URL` 只会让"没配置"看起来像"配置了"。
 *
 * 顺带修掉的一个真实暴露面 (mcp_protocol.test.ts 的 spawn):
 *   E2E 用 `{ ...process.env, <显式覆盖> }` 构造子进程环境, 显式覆盖只有
 *   `NEXUS_API_URL` / `NEXUS_API_TOKEN` / `NEXUS_TENANT_ID` 三项。宿主上的
 *   `NEXUS_DEFAULT_USER_ID` 会顺着 spread 漏进被 spawn 的 server, 把每次调用
 *   的 `user_id` 钉成开发机上那个值, 而用例断言用的是 `e2e-test-user-001`
 *   —— 与本 issue 完全同一类 bug, 只是被 E2E 的 skip 门挡着还没爆。
 *   setup 跑在测试文件之前, `process.env` 到 spread 那一刻已经是干净的,
 *   所以子进程一并被治。
 */

import { INTEGRATION_PRESERVED_PREFIXES, scrubEnv } from './env-isolation.js';

scrubEnv(process.env, { preservePrefixes: INTEGRATION_PRESERVED_PREFIXES });
