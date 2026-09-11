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

/**
 * 不回显取值的环境变量断言 (两个 helper 共同的理由)。
 *
 * 直接写 `expect(process.env[key]).toBe(value)` / `.toBeUndefined()` 在失败时,
 * vitest 会把 received 侧 —— 也就是**宿主机上那个变量的真实取值** —— 打进断言
 * diff, 进而进终端、会话记录和 CI job 日志。而本文件断言的这批变量里就有
 * `NEXUS_API_TOKEN`。眼下它没被打出来只是因为 `UNIT_ENV_BASELINE` 的插入顺序
 * 让循环先在 `NEXUS_API_URL` 上抛出 —— 那是偶然的顺序遮蔽, 不是设计: 只要有人
 * 调整基线字段顺序, 或宿主 `NEXUS_API_URL` 恰好等于基线值, token 就会被打出来。
 *
 * 所以比较在断言之外做完, 送进 `expect` 的只有 true/false; 断言消息带 key 名,
 * 定位能力不减。同 nexus 本仓 CLAUDE.md §Settings 凭据字段一律 SecretStr 那条
 * ("一个普通断言失败就会把凭据打进 CI 日志") 的 TS 版本。
 */
function expectEnvEquals(key: string, expected: string): void {
  expect(process.env[key] === expected, `基线变量 ${key} 缺失或被改写`).toBe(true);
}

function expectEnvUnset(key: string): void {
  expect(process.env[key] === undefined, `${key} 未被清理 (宿主环境泄漏进单测进程)`).toBe(true);
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
      expectEnvEquals(key, value);
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
    expectEnvUnset('NEXUS_DEFAULT_USER_ID');
  });

  it('其余会改变行为的可选变量同样为空 (默认分支才是被测分支)', () => {
    expectEnvUnset('NEXUS_METRICS_PORT');
    expectEnvUnset('NEXUS_MCP_TRANSPORT');
    expectEnvUnset('NEXUS_MCP_HTTP_PORT');
    expectEnvUnset('NEXUS_MCP_CLIENT_NAME');
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

/**
 * 扫描面的后缀白名单。
 *
 * 不能只收 `.ts`: `src/` 下一旦出现 `.mjs` / `.js` 之类的辅助文件, **整个文件**
 * 都不进扫描面, 里面的环境变量读取点就静默逃出本组断言 —— 与"黑名单必然过期"
 * 同一个失效模式, 只是发生在文件粒度而不是变量粒度。
 */
const SOURCE_SUFFIXES: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/** 递归收集 `dir` 下全部源码文件。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) out.push(full);
  }
  return out;
}

/**
 * 从源码里抽出环境变量名。三条正则互补, 缺一会漏:
 *
 *   ACCESS  —— `process.env.X` / `process.env['X']` / `env.X` / `env['X']`
 *              (auth.ts / metrics.ts 把 `env: NodeJS.ProcessEnv` 作参数传,
 *              所以不能只认 `process.` 前缀)。抓得到 `NEXUS_METRICS_PORT`
 *              这类**直接**读取点。
 *
 *   LITERAL —— 源码里任何 UPPER_SNAKE 形状的字符串字面量。这条是为了抓
 *              `REQUIRED_ENV_VARS = ['NEXUS_API_URL', ...]` 这种**通过名字
 *              数组间接读取**的变量 —— 它在源码里长成 `env[key]`, key 是运行
 *              期变量, ACCESS 正则根本看不见。同 nexus 本仓 "动态 getattr
 *              取凭据既逃静态检查也逃字面 grep" 那条教训的 TS 版本。
 *
 *              注意口径必须是**全部** UPPER_SNAKE 而不能只收 `NEXUS_*` /
 *              `MCP_*`: 只收受控前缀的话, 抓到的每一个按定义都已被覆盖,
 *              这条正则就退化成纯装饰, 挡不住有人往那个数组里塞一个别的
 *              前缀的名字。
 *
 *   DESTRUCTURE —— 解构读取: `const { X, Y: alias, Z = '预设' } = process.env`,
 *              以及同形的裸参数版 (auth.ts / metrics.ts 收 NodeJS.ProcessEnv
 *              作参数)。这种写法既不长成属性访问, 也不产生字符串字面量, 前两条
 *              正则**同时**看不见它 —— 而它在 TS 里完全惯用。
 *
 *              审查实证 (2026-09-07): 往 `src/metrics.ts` 注入一条解构形态的
 *              新读取点后本组断言仍然全绿 (此刻 src/ 确实存在一个不被策略覆盖
 *              的读取点, 锁却没响); 同一个变量换成直接读取形态则正确变红。
 *
 *              等号后只接受 `process.` 前缀或裸标识符两种形态, 所以 `= myenv`
 *              / `= someObj.env` 不会误命中 (等号与标识符之间只允许空白)。
 *              已知局限: 大括号内含逗号的默认值 (`{ X = f(a, b) }`) 与嵌套解构
 *              不在覆盖内 —— 环境变量的值只可能是字符串, 这两种形态在环境对象
 *              上不成立。
 */
const ACCESS_PATTERN =
  /(?:process\.)?env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g;
const LITERAL_PATTERN = /['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g;
const DESTRUCTURE_PATTERN = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:process\.)?env\b/g;

/** 从解构的大括号内容里取出被读的变量名 (`X` / `X: alias` / `X = 预设`)。 */
function parseDestructuredNames(inner: string): string[] {
  const out: string[] = [];
  for (const part of inner.split(',')) {
    const matched = /^\s*([A-Z][A-Z0-9_]*)\s*(?::|=|$)/.exec(part);
    if (matched?.[1] !== undefined) out.push(matched[1]);
  }
  return out;
}

/**
 * LITERAL 口径放宽到全部 UPPER_SNAKE 之后, 会顺带抓到不是环境变量的常量。
 * 这里逐个豁免, **要求写清它是什么** —— 往这个表里加一行应该是一次有意识的
 * 判断 ("这真的不是环境变量吗"), 而不是为了让红变绿的顺手操作。
 *
 * 截至 2026-09-07, 全 `src/` 的 UPPER_SNAKE 字面量只有 5 个, 其中 4 个是
 * `REQUIRED_ENV_VARS` / `NEXUS_DEFAULT_USER_ID` 那批真环境变量。
 */
const NON_ENV_LITERALS: ReadonlySet<string> = new Set([
  // axios 的网络错误码, 出现在 src/errors.ts 里 `AxiosLikeError.code` 字段的行尾注释
  'ERR_NETWORK',
]);

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
      if (name !== undefined && !NON_ENV_LITERALS.has(name)) names.add(name);
    }
    for (const match of source.matchAll(DESTRUCTURE_PATTERN)) {
      const inner = match[1];
      if (inner !== undefined) {
        for (const name of parseDestructuredNames(inner)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

describe('Case 4 — src/ 的环境变量读取点全部被隔离策略覆盖', () => {
  const srcEnvVars = scanEnvVarNames(collectSourceFiles(SRC_DIR));

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
