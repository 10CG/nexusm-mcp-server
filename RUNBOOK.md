# nexusm-mcp-server RUNBOOK

> **Status**: in place at `packages/nexusm-mcp-server/RUNBOOK.md`; moved into this submodule at Wave 0 close (2026-05-21).
> **Owner**: 10CG Backend / DevOps
> **Created**: 2026-05-09 (US-037 Phase B Wave 0)
> **Last revised**: 2026-05-22 (Wave 1 R1 audit amendments — removed `description-clean` row from §5 until Wave 2 CI matrix expansion)
> **Related**: [proposal.md §C-5](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/openspec/changes/us-037-mcp-server-exposure/proposal.md) + [detailed-tasks.yaml TASK-002 / TASK-008](https://forgejo.10cg.pub/10CG/nexus/src/branch/main/openspec/changes/us-037-mcp-server-exposure/detailed-tasks.yaml)

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
