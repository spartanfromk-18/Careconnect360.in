# PRD: CareConnect360.in — Audit Remediation

## Overview
Fix every finding in `audit_report.md` (2026-07-23 security audit), in severity order.
This is a live payment/booking system handling real patient data — nothing here is optional polish.

**Do not batch tasks.** Complete exactly ONE task per iteration, verify it, commit it, then stop.
Rules of engagement for every task are in `PROMPT.md` — read that file every iteration, not just this one.

**Never touch, under any circumstances:** Supabase project dashboard/settings, Vercel environment variables or project settings, Razorpay dashboard, or anything outside this git repository. All changes happen as file edits + git commits in this repo only.

Legend: `[ ]` = not started, `[~]` = in progress (should never persist across iterations — if you see this, the previous run crashed mid-task; check `progress.txt` before resuming), `[x]` = done and verified.

---

## PHASE 0 — CRITICAL BLOCKERS
> Data loss / security breach / financial loss risk. Nothing below this phase starts until Phase 0 is 100% complete.

### [ ] TASK-001: Logout does not revoke the admin JWT
**Files:** `admin.html:109-112`, `public/admin.html:109-112`
**Problem:** Logout only clears `sessionStorage`; it never calls `POST /api/admin-logout`, so the JWT stays valid for up to 12 hours after "logout."
**Fix:** Make the logout handler `async`, capture the token before removing it from storage, `POST` it to `/api/admin-logout` with `Authorization: Bearer <token>` inside a try/catch (best-effort — still redirect on failure), then redirect to `/login.html`.
**Apply to BOTH copies** (`admin.html` and `public/admin.html`) — they are byte-identical, keep them that way for this fix.
**Acceptance criteria:**
- Both files updated identically.
- Manually or via test: logging out issues a network call to `/api/admin-logout` with the bearer token, and the token is rejected by `/api/admin-verify` immediately after.
- CodeRabbit review clean (see PROMPT.md gate).

---

### [ ] TASK-002: Wildcard CORS on `api/submit.js` (and `api/admin-login.js`)
**Files:** `api/submit.js:50-52`, `api/admin-login.js:30`
**Problem:** CORS check accepts any origin containing `localhost` or ending in `.vercel.app` — anyone can host a free `*.vercel.app` page and POST to the booking/payment endpoint.
**Fix:** Replace the suffix/substring match with an exact match against `process.env.ALLOWED_ORIGIN`, plus an explicit `ALLOWED_PREVIEW_ORIGINS` env var (comma-separated exact origins) for staging. No suffix matching on shared CDN apexes, ever.
**Acceptance criteria:**
- `api/submit.js` and `api/admin-login.js` both use exact-match origin checks.
- Add `ALLOWED_PREVIEW_ORIGINS` to `.env.example` (create if missing) with a comment explaining it's a comma-separated exact allowlist.
- Confirm `api/create-order.js` is untouched (it's already correct — don't refactor it into matching this pattern unless it shares the helper).
- CodeRabbit review clean.

---

### [ ] TASK-003: No server-side Razorpay signature verification before booking write
**Files:** `api/submit.js:104, 132-157`
**Problem:** Only `payment_id` is read from the client and verified via `razorpay.payments.fetch()`. The client already sends `razorpay_order_id` and `razorpay_signature` (see `index.html:3037-3038`) but they're never checked. This allows replay of a captured `payment_id` within the 24h Redis TTL window.
**Fix:** Read `razorpay_order_id` and `razorpay_signature` from the body. Compute `HMAC-SHA256(order_id + "|" + payment_id, RAZORPAY_KEY_SECRET)` and compare with `crypto.timingSafeEqual` **before** the Redis `NX` claim and before `razorpay.payments.fetch`. Reject with 402 on missing fields or signature mismatch.
**Acceptance criteria:**
- Signature check runs first, before any Redis or DB write.
- `timingSafeEqual` used (not `===`) for the comparison, with equal-length buffers guarded (wrap in try/catch or length-check before calling it — mismatched lengths throw).
- Existing Redis replay-lock + `payments.fetch` status/amount check still run afterward, unchanged.
- CodeRabbit review clean — flag this task for extra scrutiny given it's a payment-integrity fix.

---

### [ ] TASK-004: Missing RLS write policies on `bookings`; no policies at all on `payments`
**Files:** `supabase/migrations/`
**Problem:** `bookings` has SELECT policies only — any authenticated user with the anon key can `INSERT` directly via the Supabase SDK, bypassing `submit.js` and the payment check entirely. `payments` has RLS enabled with zero policies (currently fails safe for anon, but is an undocumented trap).
**Fix:** Add a new migration file with explicit deny-all policies for non-service-role INSERT/UPDATE/DELETE on `bookings`, and an explicit deny-all-anon policy on `payments` (service_role bypasses RLS by default, so the webhook keeps working). Use the exact SQL from the audit report's "Fixed code" block for this finding.
**Acceptance criteria:**
- New migration file created (do not edit old migrations — additive only), named with a timestamp prefix consistent with the existing migration naming convention in `supabase/migrations/`.
- Confirm via `supabase db diff` or a local test that anon-key INSERT into `bookings` now fails.
- CodeRabbit review clean.

---

### [ ] TASK-005: Unhandled `JSON.parse` on Razorpay webhook body
**Files:** `api/webhook-razorpay.js:90`
**Problem:** A malformed body after a *valid* HMAC signature throws uncaught, causing a 500 → Razorpay retries → potential duplicate side effects / retry storm.
**Fix:** Wrap `JSON.parse` in try/catch. On failure, log at ERROR level and return `400 { error: 'Invalid JSON payload' }` (not 500 — a 400 tells Razorpay not to retry).
**Acceptance criteria:**
- Try/catch in place exactly as in the audit's fixed code.
- Confirm this still runs *after* HMAC verification (don't reorder — signature check must stay first).
- CodeRabbit review clean.

---

## PHASE 1 — SECURITY HARDENING
> Not actively broken, but below the bar for a live payment system. Start only after Phase 0 is fully `[x]`.

### [ ] TASK-006: `validateCurrency` references non-existent `CONFIG.DEFAULT_CURRENCY`
**File:** `api/security-utils.js:32` — replace the undefined reference with the literal `'INR'` default.

### [ ] TASK-007: IPv6 addresses always fail IP validation
**File:** `api/security-utils.js:15-19` — extend the regex to accept IPv6 alongside the existing IPv4 pattern, per the audit's fixed code.

### [ ] TASK-008: Redis blocklist check fails OPEN on Upstash outage
**File:** `lib/redis-blocklist.js:21-29` — flip to fail-closed (`return true` / treat as blocked) on any error during the blocklist check, since this guards admin auth over patient PII.

### [ ] TASK-009: Admin IP allowlist bypassable via `x-forwarded-for` header injection
**Files:** `api/admin-login.js:14-15`, `api/admin-verify.js:19`, `api/admin-logout.js:8` — read the **last** entry in `x-forwarded-for` (Vercel-appended, trustworthy), not the first. Same fix in all three files.

### [ ] TASK-010: CSP allows `'unsafe-inline'` for `script-src`
**File:** `vercel.json:46` — this is the hardest one in the list. Do not attempt a partial hack. Either (a) move every inline `<script>` block in every HTML page to external `.js` files and drop `'unsafe-inline'`, or (b) generate per-script hashes and pin them in the CSP. **If this requires restructuring more than ~5 files or touching build tooling, stop, mark this task `[~]` with a note in `progress.txt` explaining the blocker, and surface it to the human rather than guessing.** This is the one task in this PRD where an incomplete/incorrect attempt is worse than asking for help.

### [ ] TASK-011: `nurses` table has RLS enabled but no direct SELECT policy
**File:** `supabase/migrations/` — add `CREATE POLICY "nurses view own record" ON public.nurses FOR SELECT USING (profile_id = auth.uid());` in a new additive migration.

### [ ] TASK-012: XSS sink via `innerHTML` with `err.message` in admin error rendering
**Files:** `admin.html:245`, `public/admin.html:245` — replace the template-literal `innerHTML` assignment with `createElement` + `textContent`, in both files identically.

### [ ] TASK-013: No startup guard for missing `SUPABASE_ANON_KEY` / `SUPABASE_URL`
**File:** `api/bookings.js` — add an explicit check at handler startup that throws/returns a clear 500 config error if either env var is undefined, consistent with guards in other handlers.

---

## PHASE 2 — PERFORMANCE OPTIMIZATIONS
> Start only after Phase 1 is fully `[x]`.

### [ ] TASK-014: `admin_dashboard_data` RPC does `SELECT *` on all four tables
**File:** `hardening.sql:51-68` — enumerate only the ~7-11 columns the admin dashboard actually renders, per the audit's fixed SQL, instead of `select *`.

### [ ] TASK-015: New `Ratelimit` instance constructed per-request
**File:** `api/create-order.js:30-31, 61` — hoist `Ratelimit` construction to module scope so it's built once per warm Lambda instance, not per request.

### [ ] TASK-016: Invoice write always sets `customer_id: null`; sequential awaits that could parallelize
**File:** `api/webhook-razorpay.js:52-60` — fetch the booking's `customer_id` first, then run the status-update and invoice-existence-check in `Promise.all`, and populate `customer_id` on insert so the existing `"customers view own invoices"` RLS policy can ever match.

---

## PHASE 3 — MAINTAINABILITY
> Lowest priority. Only start after Phases 0-2 are fully `[x]`.

### [ ] TASK-017: Duplicate root/ vs public/ HTML tree
**Files:** `index.html`, `admin.html`, `login.html` and their `public/` twins — consolidate to a single source tree, using Vercel `rewrites`/`cleanUrls` to serve routes. **High blast radius — do this task last, on its own branch, and note in `progress.txt` exactly which routes were repointed** so a human can spot-check before merge.

### [ ] TASK-018: Duplicated `hashPII` implementation
**Files:** `api/submit.js:41` vs `api/security-utils.js:9` — delete the local copy in `submit.js`, import from `security-utils.js` instead.

### [ ] TASK-019: Duplicated IP-extraction logic bypasses shared validation
**File:** `api/submit.js:86` — replace the inline `x-forwarded-for` parsing with a call to `SecurityUtils.extractIP(req.headers)`.

### [ ] TASK-020: `getEmailTemplate` only handles `refund.processed`, not `refund.created`
**File:** `api/webhook-razorpay.js:112` — either add a template branch for `refund.created`, or add a one-line comment confirming the gap is intentional (product decision — if unsure, add the comment and flag for human confirmation rather than guessing intent).

### [ ] TASK-021: `invoices.payment_id` FK is never populated
**File:** `api/webhook-razorpay.js:58` (invoice creation) — set `payment_id` to the corresponding `payments.id` (uuid) when creating the invoice, so the FK isn't permanently null.

---

## Definition of Done (applies to every task above)
A task is only `[x]` when **all** of the following are true — see `PROMPT.md` for the exact command sequence:
1. The fix matches (or improves on, with justification noted in `progress.txt`) the audit's suggested fix.
2. Any existing lint/build/test command in this repo passes.
3. `coderabbit review` on the uncommitted diff comes back clean (no unresolved actionable comments).
4. The change is committed with a message referencing the task ID (e.g. `fix(TASK-003): verify Razorpay HMAC signature before booking write`).
5. `progress.txt` has a new entry (never delete or rewrite prior entries).
