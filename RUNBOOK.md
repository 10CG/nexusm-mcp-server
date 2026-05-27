# nexusm-mcp-server RUNBOOK

> **Status**: in place at `packages/nexusm-mcp-server/RUNBOOK.md`; moved into this submodule at Wave 0 close (2026-05-21).
> **Owner**: 10CG Backend / DevOps
> **Created**: 2026-05-09 (US-037 Phase B Wave 0)
> **Last revised**: 2026-05-27 (§0 RELEASE PROCEDURE added — captures all v0.1.0 + v0.1.1 landmines as a single sequential checklist)
> **Related**: [proposal.md §C-5](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/openspec/changes/us-037-mcp-server-exposure/proposal.md) + [detailed-tasks.yaml TASK-002 / TASK-008](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/openspec/changes/us-037-mcp-server-exposure/detailed-tasks.yaml)

---

## 0. RELEASE PROCEDURE (canonical — follow in order)

> **Why this section exists**: v0.1.0 and v0.1.1 each took 4+ iterations to publish because separate landmines surfaced sequentially. This section consolidates the full procedure with all known landmines inline, so v0.1.2+ is a 5-minute exercise.
>
> **Architecture context**: npm publish runs from **a developer's local machine, not from Aether CI runner**. Aether `docs/guides/forgejo-ci-internal-mirror.md` (Aether #137) explicit design goal is "CI 热路径不再有任何跨境请求"; publishing to npmjs.com is cross-border and intentionally not supported on Aether runners. Future: when this package gets mirrored to `github.com/10CG/nexusm-mcp-server`, `.github/workflows/publish.yml` will automate this; until then, follow this manual procedure.

### 0.1 Pre-flight (1 minute)

```bash
cd /home/dev/nexus/packages/nexusm-mcp-server

# (a) On correct branch + latest main
git status                         # clean working tree expected
git log --oneline -1               # match expected release commit

# (b) Version matches intended release
node -p "require('./package.json').version"   # e.g. 0.1.2

# (c) npm authenticated as `10cg` (NOT a personal account, NOT empty)
npm whoami                         # MUST return: 10cg

# (d) Node version sane
node --version                     # ≥ 18 (engines.node in package.json)
```

**Stop here if any of (a)-(d) fails.** See landmines §0.5.

### 0.2 Install deps + build (60-90s on warm machine)

```bash
npm ci                             # installs devDeps from lockfile
                                   # ← required if running from a fresh
                                   #   checkout / different machine (Landmine D)

npm run build                      # tsc + chmod +x dist/index.js
ls -la dist/index.js               # MUST show -rwxr-xr-x (execute bit set)
                                   # ← without +x, npx exec fails on
                                   #   downstream users (Landmine F)
ls dist/index.d.ts                 # MUST exist (TS type declarations)
```

### 0.3 Local publish (interactive, ~30s plus 2FA web auth)

```bash
npm publish
```

**Expected output**:

```
npm notice 📦  @nexusm/mcp-server@<X.Y.Z>
npm notice ... (tarball with 44+ files including dist/**)
npm notice total files: 44                  ← MUST be 40+ not 4
                                            ← if 4, dist/ wasn't built — re-do §0.2
Authenticate your account at:
https://www.npmjs.com/auth/cli/<uuid>
Press ENTER to open in the browser...       ← first-publish or expired session
+ @nexusm/mcp-server@<X.Y.Z>
```

If browser-auth prompt appears:
1. Press ENTER (browser opens)
2. Bitwarden auto-fills passkey
3. Click "Sign in" → "Allow"
4. Terminal completes publish

### 0.4 Verify (30s)

```bash
# Registry visibility (HTTP 200 means published)
curl -sI --max-time 8 "https://registry.npmjs.org/@nexusm/mcp-server/<X.Y.Z>" | head -1

# Latest tag pointer (should match what you just published)
curl -s --max-time 8 "https://registry.npmjs.org/@nexusm/mcp-server/latest" \
  | python3 -c "import sys,json;print('latest:',json.load(sys.stdin).get('version'))"

# End-to-end smoke: npx must launch the server (catches Landmine F regressions)
npx -y @nexusm/mcp-server@<X.Y.Z> --version 2>&1 || \
  npx -y @nexusm/mcp-server@<X.Y.Z> < /dev/null   # stdio server, exit immediately
                                                  # MUST NOT show
                                                  # `sh: nexusm-mcp-server: not found`
```

### 0.5 Landmines (recognized so far — each has ≥ 1 prior victim)

| # | Symptom | Root cause | Fix | Memory |
|---|---------|-----------|-----|--------|
| **A** | `E402 Payment Required - You must sign up for private packages` | First publish of new scoped package without `--access public` | Add `publishConfig.access=public` to `package.json` (already done); or pass `--access public` on CLI | [[feedback_npm_granular_token_org_scope]] |
| **B** | `E403 Forbidden - Two-factor authentication ... required to publish packages` | Account has no 2FA configured | Set up account 2FA via Bitwarden passkey on npmjs.com → Settings → Two-Factor Auth | [[feedback_npm_granular_token_org_scope]] |
| **C** | `E404 Not Found - PUT registry.npmjs.org/@nexusm%2f<pkg>` + `npm whoami` returns expected user | Session token from a different package's web-auth lacks first-publish rights on new package | `npm logout && npm login` to mint fresh session | [[feedback_npm_first_publish_session_token]] |
| **D** | `Tarball Details: total files: 4`, only LICENSE/README/RUNBOOK/package.json | `npm ci` not run on this machine → tsup/tsc missing → `prepublishOnly` `npm run build` silently fails → empty dist | Run `npm ci` first; verify `ls dist/index.js` before re-publishing | 本 RUNBOOK §0.2 |
| **E** | `code ENEEDAUTH` after tarball assembly | Local `~/.npmrc` has no `_authToken` (fresh machine) | `npm login` on this machine; or copy `~/.npmrc` from previously-logged-in machine | 本 RUNBOOK §0.3 |
| **F** | After publish, `npx -y @nexusm/mcp-server@<ver>` fails with `sh: nexusm-mcp-server: not found` | `dist/index.js` published without execute bit (`-rw-r--r--` instead of `-rwxr-xr-x`) | `package.json` `"build": "tsc && chmod +x dist/index.js"` (already done); verify `ls -la dist/index.js` shows `-rwxr-xr-x` before publish | 本 RUNBOOK §0.2 |
| **G** | `ENEEDAUTH against http://192.168.69.206:4873` (Aether Verdaccio) | Tried to publish from Aether runner — wrong fit | Publish from local dev machine, NOT Aether runner. See top of §0 for architecture context | [[feedback_align_with_platform_arch_not_workaround]] |
| **H** | `EIDLETIMEOUT for host registry.npmjs.org` during `npm ci` | Tried to do `npm ci` from Aether runner — cross-border outbound unoptimized | Same as G: do this from local dev, not Aether | [[feedback_align_with_platform_arch_not_workaround]] |
| **I** | `ERESOLVE` on eslint peer dep | Lockfile drift between package.json and lockfile, OR peer dep mismatch (eslint@9 with `@typescript-eslint/parser@^7`) | Sync versions in package.json; re-run `npm install` to regenerate lockfile; commit lockfile | 本 RUNBOOK §0.2 |

### 0.6 Quarterly re-verification (every 90 days)

NPM_TOKEN rotation per §2 below. After rotation, run §0.1-§0.4 once on a small patch release (e.g. metadata-only bump) to confirm the new token works end-to-end. **Do NOT defer this verification to a real release** — fresh tokens have caught rejection at publish time before, and an emergency release is the wrong moment to debug auth.

### 0.7 Future automation

When `nexusm-mcp-server` gets mirrored to `github.com/10CG/nexusm-mcp-server` (tracked as FU-MCP-SERVER-GITHUB-MIRROR in nexus phase-d-archive-checklist.md §12.B), `.github/workflows/publish.yml` on the mirror will automate §0.2-§0.4 on tag push. Until then, this section is the canonical path.

---

## 1. npm publish Failure Modes

### 1.1 Rate Limited (HTTP 429)

**Symptom**: `npm publish` fails with `429 Too Many Requests`.

**Cause**: npm registry has anti-abuse rate limits per token.

**Recovery**:
1. Wait 5-10 min before retry.
2. If persistent (> 30 min), check npm status page: https://status.npmjs.org/
3. Workaround: use `--registry https://registry.npmjs.org/` (force public, sometimes mirrors lag).

**Avoid**: Don't retry in tight loop — will trigger longer ban.

---

### 1.2 Token Expired / Unauthorized (HTTP 401)

**Symptom**: `npm publish` fails with `401 Unauthorized` or `EAUTHIP`.

**Cause**: `NPM_TOKEN` granular access token expired (max 90-day lifetime since 2025 npm policy) or revoked.

**Recovery**:
1. Login to npmjs.com with org account.
2. Profile → Access Tokens → Granular Access Tokens → "Generate New Token". Configure:
   - Bypass 2FA: ✅ (required for CI automation)
   - Organizations → `nexusm` → Read and write
   - Expiration: 90 days (max)
3. Update Forgejo repo secret (note: `PUT` method + `/actions/secrets/` path):
   ```bash
   forgejo PUT /repos/10CG/nexusm-mcp-server/actions/secrets/NPM_TOKEN -d '{"data":"<new-token>"}'
   ```
4. Re-run failed CI workflow (Forgejo Actions → re-run).

**Rotation cadence**: Quarterly (Jan / Apr / Jul / Oct, 1st Monday) — required because npm granular tokens cap at 90 days. Schedule in calendar.

---

### 1.3 Namespace Not Registered / Forbidden (HTTP 403)

**Symptom**: `npm publish` fails with `403 Forbidden — You do not have permission to publish "@nexusm/mcp-server"`.

**Cause**: `@nexusm` scoped namespace not registered to org account, or token doesn't have publish scope on this namespace.

**Recovery**:
1. Verify namespace ownership: `npm access ls-packages @nexusm`.
2. If namespace not owned, register via npmjs.com → "Add Organization" → name: `nexusm`, type: Free Open Source.
3. Re-link granular access token to org: Profile → Access Tokens → edit token → Organizations → `nexusm` → Read and write.
4. Retry publish.

**Long-term safeguard**: `@nexusm` scope is owned by 10CG since 2026-05-21 (Wave 0 closure). The original A2-D-1 unscoped fallback (`nexus-mcp-server`) is no longer available — that name is taken on npm by an unrelated party. If `@nexusm` is ever lost, immediately reclaim via npmjs.com support; do NOT fall back to unscoped.

---

### 1.4 Disaster Recovery: Bad Version Published

**Symptom**: Critical bug shipped in `0.x.y`, users hitting it.

**Recovery options** (in priority order):

1. **Hotfix `0.x.(y+1)`** (preferred): bump patch, fix bug, publish. Existing users get update via npm update.
2. **`npm deprecate @nexusm/mcp-server@0.x.y "reason"`**: marks version as deprecated; users see warning on install but version stays available.
3. **`npm unpublish @nexusm/mcp-server@0.x.y --force`**: removes from registry. **DANGEROUS** — only allowed within 72h of publish per npm policy. Will break any user who has it pinned.

**Decision matrix**:
| Severity | Action |
|----------|--------|
| Cosmetic / non-functional bug | Hotfix `0.x.(y+1)` |
| Security vuln (CVE level) | Hotfix + deprecate `0.x.y` |
| Critical breakage (data loss / DoS) | Hotfix + deprecate; consider unpublish if < 24h |
| Wrong file shipped (e.g., secret in tarball) | Unpublish IMMEDIATELY (within 72h window) + rotate any leaked credentials |

**Reference**: https://docs.npmjs.com/policies/unpublish

---

## 2. NPM_TOKEN Rotation

### Schedule

- **Quarterly**: Jan / Apr / Jul / Oct (1st Monday) — required because npm granular tokens cap at 90 days
- **Ad-hoc**: when leak suspected, when team member leaves, when 90-day expiration ≤ 2 weeks away

### Procedure

1. Generate new granular access token (npmjs.com → Profile → Access Tokens → Granular Access Tokens → "Generate New Token"). Settings:
   - Bypass 2FA: ✅
   - Organizations → `nexusm` → Read and write
   - Expiration: 90 days
2. Test new token locally:
   ```bash
   NPM_TOKEN=<new> npm whoami --registry https://registry.npmjs.org/
   ```
3. Update Forgejo repo secret (PUT + `/actions/secrets/`):
   ```bash
   forgejo PUT /repos/10CG/nexusm-mcp-server/actions/secrets/NPM_TOKEN -d '{"data":"<new>"}'
   ```
4. Trigger a no-op CI run (push empty commit) to verify CI auth works with new token.
5. Revoke old token (npmjs.com → Access Tokens → Delete).
6. Update calendar reminder for next rotation (+3 months).

### Audit Trail

Log each rotation in `nexusm-mcp-server/CHANGELOG.md` under `## Operations`:
```
- 2026-04-XX: NPM_TOKEN rotated (rotated_by=<name>, old_token_revoked=2026-04-XX)
```

---

## 3. Disaster Recovery — Forgejo Repo Loss

### Scenario: `10CG/nexusm-mcp-server` Forgejo repo deleted / corrupted

**Recovery**:

1. **Local clones still have full history** — any team member with a local clone can restore.
2. Rebuild from local:
   ```bash
   # In team member's local clone:
   git remote rename origin forgejo-old   # save old remote ref just in case
   forgejo POST /orgs/10CG/repos -d '{"name":"nexusm-mcp-server",...}'
   git remote add origin ssh://forgejo@forgejo.10cg.pub/10CG/nexusm-mcp-server.git
   git push -u origin main --tags
   ```
3. Re-add Forgejo Actions secrets (NPM_TOKEN) per §2.
4. Update main nexus repo `.gitmodules` if URL changed.
5. Notify all submodule consumers to re-init: `git submodule update --init`.

### Scenario: GitHub mirror (`simonfishgit/nexus-claude-plugin`) lost

GitHub mirror is auto-synced from Forgejo via `.forgejo/workflows/mirror.yml` (TASK-024). If mirror disappears:

1. Recreate GitHub repo (any team member with PAT).
2. Re-add `GITHUB_PAT` secret in Forgejo `nexus-claude-plugin` repo.
3. Push current Forgejo HEAD: `git push github main`.

This is the Anthropic marketplace submission path (`plugin.json author=10CG`, mirror is just for discovery via simonfishgit).

---

## 4. Namespace Ownership

- npm: `@nexusm/*` scoped namespace owned by 10CG organization account on npmjs.com.
- Forgejo: `10CG/nexusm-mcp-server` repo, admin = 10CG org admins.
- GitHub mirror: `simonfishgit/nexus-claude-plugin` (personal account, bus factor mitigation via Forgejo Actions auto-sync per A2-D-3).

If 10CG npm org access lost (admin departure / account compromise):
1. Contact npm support (support@npmjs.com) with org admin proof.
2. Worst case: fallback to unscoped `nexusm-mcp-server` package, update all references (proposal A2-D-1 fallback).

---

## 5. CI Workflow Reference

`.forgejo/workflows/ci.yml` (TASK-008 / TASK-017 / TASK-025):

| Step | Trigger | Purpose | Failure → Action |
|------|---------|---------|-----------------|
| `lint` | push, PR | eslint + prettier | Fix code style; check `.eslintrc` |
| `tsc` | push, PR | TypeScript type-check | Fix type errors; SDK Zod schema drift may indicate need to bump @nexusm/sdk |
| `test:unit` | push, PR | vitest unit tests | Local repro: `npm test` |
| `test:integration` | push, PR | mcp-cli E2E (3 platform matrix Linux × Node 18/20 + macOS × Node 20) | Check matrix log; Aether runner Windows OOS Phase 1 |
| `schema_sync` | push, PR | MCP inputSchema vs @nexusm/sdk Zod schema | Update one or the other to match |
| `publish` | tag `v*` | npm publish + Forgejo release | Per §1 failure modes |

> **Wave 1 caveat (2026-05-22)**: Only `lint` + `tsc` (build) are currently implemented in `.forgejo/workflows/ci.yml`. `test:unit` / `test:integration` / `schema_sync` / `publish` are planned for Wave 2 TASK-014 (test matrix) and Wave 4 TASK-026 (publish). A `description-clean` step (grep `R[0-9]+|C-[0-9]+|M-[0-9]+` audit-marker leakage in `src/tools/*.ts` `description:` fields) was originally listed but deferred — for Wave 1 it is enforced via PR code review (R1 audit caught + fixed 2 leaks 2026-05-22).

---

## 6. Operations Log

(to be appended chronologically)

```
2026-XX-XX  Initial repo created by <ops>; NPM_TOKEN automation token configured
2026-XX-XX  Phase B Wave 1 first commit (TASK-003 MCP scaffold)
...
```
