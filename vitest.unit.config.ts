/**
 * Vitest config for the unit-only test pass (Wave 2 mid_audit qa-engineer
 * I-4 + C-1 amendments, 2026-05-22).
 *
 * 本 config 排除 `tests/unit/schema_sync.test.ts`: 它在运行时 import
 * `@nexusm/sdk` 的 Zod schema, 当年 Gate-1 未发包时会让全部 vi.mock 单测被一个
 * 无关的安装失败连坐。它的深版替代品是 `tests/integration/schema_sync.test.ts`
 * (Wave 2B TASK-016, 逐字段 delta 报告), 由 `test:integration` 跑, 覆盖面是这个
 * 浅版的严格超集 —— 所以排除它不损失校验。
 *
 * `npm test` = `test:unit && test:integration` (2026-09-07, 见 package.json):
 * **不再**是裸 `vitest run`。改的原因是裸跑拿不到本 config 的 `setupFiles`,
 * 而 `tests/unit/env_isolation.test.ts` 硬断言隔离已生效, 于是 `npm test` 在
 * 干净环境下也必红; 顺带治住裸跑用默认 include 把 `.claude/worktrees/<id>/`
 * 下的工作树副本当成真用例收进来 (每条测试跑两遍)。
 *
 * 代价写在明处: `tests/unit/schema_sync.test.ts` 现在不被任何 npm script 收集。
 * 这不是本次改动造成的覆盖回归 —— CI 一直只跑 `test:unit` + `test:integration`,
 * 从未跑过它; 之前只有裸 `vitest run` 会跑, 而那条路径本身已经是红的。要单跑它:
 * `npx vitest run tests/unit/schema_sync.test.ts`。
 *
 * `setupFiles` (issue #34, 2026-09-07): 单测必须跑在受控环境里。配置过 nexus
 * MCP 插件的开发机会导出 `NEXUS_*`, vitest worker 继承之后被测代码读到的是
 * 开发机配置而不是用例的固定值 —— 表现为本机红、CI (干净 runner) 绿。setup
 * 在每个测试文件之前按前缀清掉宿主变量并装一份受控基线; 策略与理由见
 * `tests/setup/env-isolation.ts`, 由 `tests/unit/env_isolation.test.ts` 锁住。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/unit/schema_sync.test.ts', 'node_modules/**', 'dist/**'],
    setupFiles: ['./tests/setup/unit-env-setup.ts'],
  },
});
