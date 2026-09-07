/**
 * 元测试: 锁住单测的宿主环境隔离 (issue #34).
 *
 * 这个文件不测业务逻辑, 它测的是"测试环境本身是否可信"。四组断言各挡一类回归:
 *
 *   Case 1 — 活的进程状态。setupFiles 真的跑了、真的清干净了。
 *            有人改坏 `vitest.unit.config.ts` 的 `setupFiles` 就在这里红。
 *
 *   Case 2 — `NEXUS_DEFAULT_USER_ID` 具名守卫。issue #34 的原始症状是
 *            `memory_search.test.ts` 两条 mode forwarding 用例被它顶掉。
 *            那两条用例红的时候看不出是环境污染 (报的是 user_id 不匹配),
 *            这条断言让同样的污染直接报出真正的原因。
 *
 *   Case 3 — `scrubEnv` 纯函数行为。前缀清理 / 豁免 / 基线三条契约。
 *
 *   Case 4 — 覆盖面扫描。扫 `src/**` 里全部环境变量读取点, 断言每一个都被
 *            隔离策略覆盖。**这条才是防"下次有人加新变量又复现"的锁** ——
 *            前三条只证明当前这批变量被清了, 第四条证明的是策略本身没漏。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  INTEGRATION_PRESERVED_PREFIXES,
  SCRUBBED_PREFIXES,
  scrubEnv,
  UNIT_ENV_BASELINE,
} from '../setup/env-isolation.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

/** 本进程里允许存在的受控前缀 key —— 就是单测基线那三个。 */
const ALLOWED_KEYS = new Set(Object.keys(UNIT_ENV_BASELINE));

function hasScrubbedPrefix(key: string): boolean {
  return SCRUBBED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Case 1 — 活的进程状态: setupFiles 生效, 宿主变量已被清理
// ---------------------------------------------------------------------------

describe('Case 1 — 测试进程内的环境变量受控 (setupFiles 生效)', () => {
  it('除受控基线外, 不存在任何 NEXUS_* / MCP_* 变量', () => {
    const leaked = Object.keys(process.env)
      .filter(hasScrubbedPrefix)
      .filter((key) => !ALLOWED_KEYS.has(key))
      .sort();

    // 只报 key 名, 不报取值 —— 泄漏进来的可能就是开发机的 NEXUS_API_TOKEN。
    expect(
      leaked,
      `宿主环境变量泄漏进单测进程: ${leaked.join(', ')}。` +
        '通常意味着 vitest.unit.config.ts 的 setupFiles 没有加载 ' +
        'tests/setup/unit-env-setup.ts。',
    ).toEqual([]);
  });

  it('受控基线三件套已装载, loadAuthConfig() 不会 process.exit(1)', () => {
    for (const [key, value] of Object.entries(UNIT_ENV_BASELINE)) {
      expect(process.env[key], `基线变量 ${key} 缺失或被改写`).toBe(value);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2 — issue #34 的具名回归守卫
// ---------------------------------------------------------------------------

describe('Case 2 — NEXUS_DEFAULT_USER_ID 具名守卫 (issue #34 原始症状)', () => {
  it('单测进程内 NEXUS_DEFAULT_USER_ID 必须为空', () => {
    // 非空 => resolveUserId 无条件返回该 pin, 覆盖用例传入的 user_id,
    // memory_search.test.ts 的 mode forwarding 用例会以"user_id 不匹配"红掉。
    expect(process.env.NEXUS_DEFAULT_USER_ID).toBeUndefined();
  });

  it('其余会改变行为的可选变量同样为空 (默认分支才是被测分支)', () => {
    expect(process.env.NEXUS_METRICS_PORT).toBeUndefined();
    expect(process.env.NEXUS_MCP_TRANSPORT).toBeUndefined();
    expect(process.env.NEXUS_MCP_HTTP_PORT).toBeUndefined();
    expect(process.env.NEXUS_MCP_CLIENT_NAME).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Case 3 — scrubEnv 纯函数契约
// ---------------------------------------------------------------------------

describe('Case 3 — scrubEnv 纯函数行为', () => {
  it('删除全部受控前缀的 key, 保留其它 key', () => {
    const env: NodeJS.ProcessEnv = {
      NEXUS_API_URL: 'http://host.example',
      NEXUS_DEFAULT_USER_ID: 'host-user',
      MCP_SERVER_SRC: 'published',
      PATH: '/usr/bin',
      HOME: '/home/dev',
    };

    const removed = scrubEnv(env);

    expect(removed).toEqual(['MCP_SERVER_SRC', 'NEXUS_API_URL', 'NEXUS_DEFAULT_USER_ID']);
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/dev' });
  });

  it('preservePrefixes 命中的 key 不删 (集成测试的 NEXUS_TEST_*)', () => {
    const env: NodeJS.ProcessEnv = {
      NEXUS_API_URL: 'http://host.example',
      NEXUS_TEST_API_URL: 'http://staging.example',
      NEXUS_TEST_TENANT_ID: 'staging-tenant',
    };

    const removed = scrubEnv(env, { preservePrefixes: INTEGRATION_PRESERVED_PREFIXES });

    expect(removed).toEqual(['NEXUS_API_URL']);
    expect(env.NEXUS_TEST_API_URL).toBe('http://staging.example');
    expect(env.NEXUS_TEST_TENANT_ID).toBe('staging-tenant');
  });

  it('baseline 在清理之后写入 (宿主同名变量不会残留)', () => {
    const env: NodeJS.ProcessEnv = { NEXUS_API_URL: 'http://host.example' };

    scrubEnv(env, { baseline: UNIT_ENV_BASELINE });

    expect(env).toEqual({ ...UNIT_ENV_BASELINE });
  });
});

// ---------------------------------------------------------------------------
// Case 4 — 覆盖面扫描: src/ 读的每一个环境变量都在策略覆盖内
// ---------------------------------------------------------------------------

/** 递归收集 `dir` 下全部 .ts 文件。 */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * 从源码里抽出环境变量名。两条正则互补, 缺一会漏:
 *
 *   ACCESS  —— `process.env.X` / `process.env['X']` / `env.X` / `env['X']`
 *              (auth.ts / metrics.ts 把 `env: NodeJS.ProcessEnv` 作参数传,
 *              所以不能只认 `process.` 前缀)。抓得到 `NEXUS_METRICS_PORT`
 *              这类直接读取点。
 *
 *   LITERAL —— 源码里任何被引号括起来的 `NEXUS_*` / `MCP_*` 字面量。抓得到
 *              `REQUIRED_ENV_VARS = ['NEXUS_API_URL', ...]` 这种**通过数组
 *              间接读取**的名字 —— 它在源码里长成 `env[key]`, ACCESS 正则
 *              看不见。这正是 CLAUDE.md 里"动态 getattr 取凭据既逃类型检查
 *              也逃字面 grep"那条教训的 TS 版本。
 *
 * LITERAL 会顺带抓到注释里提到的变量名 (如 auth.ts 注释里的 `NEXUS_USER_ID`)。
 * 这是有意的宽口径: 多抓不会漏判, 且它们本来就在受控前缀内。
 */
const ACCESS_PATTERN =
  /(?:process\.)?env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;
const LITERAL_PATTERN = /['"]((?:NEXUS|MCP)_[A-Z0-9_]+)['"]/g;

function scanEnvVarNames(files: string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(ACCESS_PATTERN)) {
      const name = match[1] ?? match[2];
      if (name !== undefined) names.add(name);
    }
    for (const match of source.matchAll(LITERAL_PATTERN)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return [...names].sort();
}

describe('Case 4 — src/ 的环境变量读取点全部被隔离策略覆盖', () => {
  const srcEnvVars = scanEnvVarNames(collectTsFiles(SRC_DIR));

  it('扫描确实抓到了东西 (正则失效会让本组断言变成空转)', () => {
    // 反 vacuous 守卫: 若哪天正则被改坏匹配不到任何东西, 下面那条
    // "全部被覆盖" 会因为集合为空而无条件通过。这条先把它钉死。
    expect(srcEnvVars.length).toBeGreaterThanOrEqual(8);
    expect(srcEnvVars).toContain('NEXUS_DEFAULT_USER_ID');
    expect(srcEnvVars).toContain('NEXUS_METRICS_PORT');
  });

  it('每一个都命中 SCRUBBED_PREFIXES', () => {
    const uncovered = srcEnvVars.filter((name) => !hasScrubbedPrefix(name));

    expect(
      uncovered,
      `src/ 读取了不被测试隔离覆盖的环境变量: ${uncovered.join(', ')}。` +
        '宿主机上设了同名变量时单测会静默改变行为 (issue #34 同类)。' +
        '修法: 把它的前缀加进 tests/setup/env-isolation.ts 的 SCRUBBED_PREFIXES。',
    ).toEqual([]);
  });
});
