/**
 * 测试进程的宿主环境隔离 (issue #34).
 *
 * 问题
 * ====
 * 在配置过 nexus MCP 插件的开发机上, 宿主 shell 导出了 `NEXUS_API_URL` /
 * `NEXUS_API_TOKEN` / `NEXUS_TENANT_ID` / `NEXUS_DEFAULT_USER_ID`。vitest 的
 * worker 继承宿主环境变量, 于是被测代码读到的是**开发机的运行配置**而不是
 * 用例自己准备的固定值 —— 用例在本机红、在 CI (干净 runner) 绿。
 *
 * 实测 (2026-09-07, 同一台机器, `npm run test:unit`):
 *   - 继承宿主环境                   → 2 failed / 129 passed
 *   - `env -u NEXUS_DEFAULT_USER_ID` → 131 passed
 * 红的两条是 `memory_search.test.ts` 的 mode forwarding 用例: `resolveUserId`
 * 看到 pin 之后无条件返回 pin, 覆盖了用例传入的 `user_id`。
 *
 * 修法: 结构性而不是逐变量
 * ========================
 * 逐个变量列黑名单必然过期 —— 下一个人往 `src/` 加一个新的 `NEXUS_*` 读取点,
 * 黑名单不会自己长出那一行, bug 原样复发。所以这里按**前缀**清理:
 * 任何以 `SCRUBBED_PREFIXES` 开头的 key 在每个测试文件加载前一律删除,
 * 新变量天然被覆盖。
 *
 * 清完再按需装一份**受控基线** (`UNIT_ENV_BASELINE`): 必填三件套要在, 否则
 * `loadAuthConfig()` 会走 `process.exit(1)`; 而所有影响行为的可选变量
 * (`NEXUS_DEFAULT_USER_ID` / `NEXUS_METRICS_PORT` / `NEXUS_MCP_*`) 一律留空,
 * 让用例跑在默认分支上, 要测非默认分支就在用例里自己设。
 *
 * 这个隔离由 `tests/unit/env_isolation.test.ts` 锁住 (元测试), 包括对
 * `src/**` 的扫描: 只要有人加了一个不被本策略覆盖的环境变量读取点, 元测试就红。
 */

/**
 * 需要清理的环境变量前缀。
 *
 * `NEXUS_` 覆盖服务端全部配置项; `MCP_` 覆盖 `tests/e2e/lib/mcp-call.mjs` 那类
 * 外部脚本用的开关 (它们不该影响 vitest 进程内的被测代码)。
 */
export const SCRUBBED_PREFIXES: readonly string[] = ['NEXUS_', 'MCP_'];

/**
 * 集成测试保留的前缀。
 *
 * `NEXUS_TEST_*` 是集成测试**故意的输入** (CI 里由 Forgejo secret 注入,
 * 见 `.forgejo/workflows/ci.yml` 的 integration-matrix job):
 * `NEXUS_TEST_API_URL` / `NEXUS_TEST_API_TOKEN` / `NEXUS_TEST_TENANT_ID`
 * 决定 E2E 套件是真跑还是 `describe.skipIf` 跳过。清掉它们等于把 E2E 永久
 * 静默跳过 —— 那是把"绿"变成"没跑", 比原 bug 更坏。
 */
export const INTEGRATION_PRESERVED_PREFIXES: readonly string[] = ['NEXUS_TEST_'];

/**
 * 单测的受控基线。
 *
 * 只放 `loadAuthConfig()` 的必填三件套, 值全部是显眼的假值:
 * `.invalid` 是 RFC 2606 保留 TLD, DNS 必然解析失败 —— 万一哪天有用例漏掉
 * mock 真发了请求, 它会立刻失败, 而不是打到某台真机器上。
 *
 * 注意: 用例**仍然应该**自己设置它断言的那些值 (现有
 * `memory_search.test.ts` / `memory_feedback.test.ts` 就是这么做的)。
 * 这份基线是兜底, 不是让用例依赖隐式全局状态的许可。
 */
export const UNIT_ENV_BASELINE: Readonly<Record<string, string>> = Object.freeze({
  NEXUS_API_URL: 'http://unit-test.invalid/v1',
  NEXUS_API_TOKEN: 'unit-test-token-DO-NOT-USE',
  NEXUS_TENANT_ID: 'unit-test-tenant',
});

/** `scrubEnv` 的可选行为。 */
export interface ScrubOptions {
  /** 命中这些前缀的 key 不被删除 (在 `SCRUBBED_PREFIXES` 之上做豁免)。 */
  readonly preservePrefixes?: readonly string[];
  /** 清理完成后写入的受控基线。 */
  readonly baseline?: Readonly<Record<string, string>>;
}

/** key 是否命中前缀表中的任意一条。 */
function hasAnyPrefix(key: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => key.startsWith(prefix));
}

/**
 * 就地清理 `target`: 删掉全部受控前缀的 key (豁免项除外), 再写入基线。
 *
 * 传入的对象被就地改写, 返回**被删掉的 key 名**(已排序), 便于元测试直接断言,
 * 也便于需要时打印诊断。
 *
 * 只返回 key 名, 从不返回 / 打印取值: 被清理的里面就有 `NEXUS_API_TOKEN`,
 * 打印它等于把开发机的凭据写进测试日志。
 */
export function scrubEnv(target: NodeJS.ProcessEnv, options: ScrubOptions = {}): string[] {
  const preserve = options.preservePrefixes ?? [];
  const removed: string[] = [];

  for (const key of Object.keys(target)) {
    if (!hasAnyPrefix(key, SCRUBBED_PREFIXES)) continue;
    if (hasAnyPrefix(key, preserve)) continue;
    delete target[key];
    removed.push(key);
  }

  for (const [key, value] of Object.entries(options.baseline ?? {})) {
    target[key] = value;
  }

  return removed.sort();
}
