# CareConnect360 — Architecture & Deployment

> **Version:** 1.0.0 | **Last updated:** 2026-07-25
> **Platform:** careconnect360.in | **Runtime:** Vercel Serverless + Supabase

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Built Architecture](#2-built-architecture)
   - 2.1 [Frontend](#21-frontend)
   - 2.2 [Serverless API Layer](#22-serverless-api-layer)
   - 2.3 [Database & RLS Policies](#23-database--rls-policies)
   - 2.4 [Security Headers & CSP](#24-security-headers--csp)
3. [Deployment & Infrastructure Pipeline](#3-deployment--infrastructure-pipeline)
   - 3.1 [Vercel Deployment](#31-vercel-deployment)
   - 3.2 [Supabase Integration](#32-supabase-integration)
   - 3.3 [Environment Secrets Management](#33-environment-secrets-management)
   - 3.4 [CI/CD Pipeline](#34-cicd-pipeline)
4. [Security Hardening Summary](#4-security-hardening-summary)
   - 4.1 [Phase 0 — Critical Blockers (TASK-001–005)](#41-phase-0--critical-blockers)
   - 4.2 [Phase 1 — Security Hardening (TASK-006–013)](#42-phase-1--security-hardening)
   - 4.3 [Phase 2 — Performance (TASK-014–016)](#43-phase-2--performance)
   - 4.4 [Phase 3 — Maintainability (TASK-017–021)](#44-phase-3--maintainability)
5. [Data Flow Diagrams](#5-data-flow-diagrams)
6. [File Map](#6-file-map)

---

## 1. System Overview

CareConnect360 is a healthcare booking and payment platform. Patients pay a ₹500 booking fee via Razorpay, request callbacks, or apply as nurses. Admins manage all data through a JWT-protected dashboard.

```
┌──────────────────────────────────────────────────────────────┐
│                        BROWSER (SPA)                         │
│  index.html │ login.html │ admin.html │ Contact/Privacy/etc  │
│         auth.js (Supabase client auth, Google OAuth)         │
└───────────────┬──────────────────────────────┬───────────────┘
                │ HTTPS                        │
┌───────────────▼──────────────────────────────▼───────────────┐
│                     VERCEL EDGE / CDN                         │
│  Security headers (CSP, HSTS, X-Frame-Options, …)           │
│  cleanUrls: /admin → admin.html, /login → login.html         │
└──────┬────────────┬────────────┬────────────┬───────────────┘
       │            │            │            │
  ┌────▼───┐  ┌────▼───┐  ┌────▼────┐  ┌───▼──────────┐
  │ submit │  │create- │  │ webhook │  │ admin-login / │
  │   .js  │  │order.js│  │razorpay │  │ verify / logout│
  │        │  │        │  │  .js    │  │    .js         │
  └───┬────┘  └───┬────┘  └───┬─────┘  └───┬──────────┘
      │           │            │             │
      └─────┬─────┘────────────┘─────────────┘
            │
┌───────────▼─────────────────────────────────────────────────┐
│               EXTERNAL SERVICES                             │
│  Supabase (DB + Auth)   Upstash Redis   Razorpay   Resend  │
│  Sentry (error monitoring)                                   │
└──────────────────────────────────────────────────────────────┘
```

**Runtime:** Node.js 18+, ESM modules (`"type": "module"`), 10 s max serverless function duration.

---

## 2. Built Architecture

### 2.1 Frontend

Seven static HTML files served from the project root (no build step):

| Route | File | Purpose |
|-------|------|---------|
| `/` | `index.html` | Landing page, booking form, callback form, nurse application form |
| `/login` | `login.html` | Google OAuth login via Supabase |
| `/admin` | `admin.html` | Admin dashboard (paginated data tables for bookings, callbacks, applications, payments) |
| `/Contact` | `Contact.html` | Contact information |
| `/PrivacyPolicy` | `PrivacyPolicy.html` | Privacy policy |
| `/Refund` | `Refund.html` | Refund policy |
| `/Terms-Conditions` | `Terms-Conditions.html` | Terms & conditions |

**Client auth (`auth.js`):**
- Supabase client initialized with `window.SUPABASE_URL` / `window.SUPABASE_ANON_KEY` (injected into HTML pages via `<script>` tags).
- `signInWithGoogle()` → Supabase OAuth → redirect to `/auth-callback.html`.
- `routeAfterLogin()` → reads `profiles.role` → routes to `/admin.html` (admin), `/nurse-portal.html` (nurse), or `/account.html` (customer).
- `requireAuth(expectedRole)` → session guard for protected pages.

**Inline JavaScript:** All `<script>` blocks are inline. The CSP uses SHA-256 hashes (not `'unsafe-inline'`) to authorize them — see §2.4.

### 2.2 Serverless API Layer

Eight Vercel serverless functions in `/api/`, each a standalone ESM file:

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/submit` | POST | CORS + rate limit | Multi-purpose form handler: bookings (with Razorpay HMAC verify), callbacks, nurse applications. Writes to Supabase via service_role, sends emails via Resend. |
| `/api/create-order` | POST | CORS + rate limit + idempotency | Creates Razorpay payment orders. Returns `orderId`, `keyId`, `amount`, `currency` to the client for Razorpay checkout. |
| `/api/webhook-razorpay` | POST | HMAC signature | Razorpay webhook receiver. Verifies `x-razorpay-signature` against `RAZORPAY_WEBHOOK_SECRET`. Parses raw body (bodyParser disabled). Syncs payment ledger to Supabase, creates invoices, sends admin emails on failure/refund. |
| `/api/admin-login` | POST | IP allowlist + rate limit | Admin password login. `bcrypt.compare` → JWT (HS256, 12 h, `jti` claim). Returns token in JSON body. |
| `/api/admin-verify` | POST | JWT + IP allowlist + blocklist check | Verifies admin session. Checks Redis blocklist for revoked JTIs. Returns paginated data via `admin_dashboard_data` RPC. |
| `/api/admin-logout` | POST | JWT + IP allowlist | Revokes admin JWT by adding its `jti` to the Redis blocklist with remaining TTL. |
| `/api/bookings` | GET | Supabase session token | Returns the logged-in customer's bookings with nurse + invoice joins. Uses caller's Supabase session (anon key) — RLS enforces data isolation. |
| `/api/security-utils` | — (library) | — | Shared utilities: `hashPII`, `extractIP`, `validateAmount`, `validateCurrency`, `generateRequestId`. |

**Key patterns across all handlers:**
- Module-scope env var validation (throws on missing required vars).
- CORS: exact-match origin check against `ALLOWED_ORIGIN` + `ALLOWED_PREVIEW_ORIGINS`.
- Rate limiting via Upstash Redis (sliding window, 5 requests / 5 minutes).
- Structured JSON logging (`logEvent`).
- `extractIP()` reads the **last** entry of `x-forwarded-for` (Vercel-appended, trustworthy).

**Shared libraries (`/lib`):**

| File | Purpose |
|------|---------|
| `redis-blocklist.js` | JWT revocation via Upstash Redis. `blocklistToken(jti, ttl)` writes; `isTokenBlocked(jti)` reads. **Fail-closed**: returns `true` (blocked) on any Redis error. |
| `logger.js` | Structured JSON logger with lazy Sentry init. `ERROR` and `CRITICAL` events forward to Sentry. |

### 2.3 Database & RLS Policies

**Supabase project:** `careconnect360-staging`

**7 tables** (defined in baseline migration `20260718084120_remote_schema.sql`):

```
profiles  ◄──────── bookings  ────────► nurses
    │                    │
    │                    ▼
    │                payments  ────► invoices
    │
    ├──► callbacks
    │
    └──► applications
```

| Table | Primary Key | Notable Columns |
|-------|-------------|-----------------|
| `profiles` | `id` (FK → `auth.users`) | `role` (customer / nurse / admin), `full_name`, `phone`, `avatar_url` |
| `bookings` | `id` (uuid) | `customer_id` (FK → profiles), `nurse_id` (FK → nurses), `payment_id` (text, Razorpay ID, unique), `status` (pending_payment / confirmed / assigned / in_progress / completed / cancelled), `amount_paise` |
| `payments` | `id` (uuid) | `payment_id` (text, Razorpay ID, unique), `webhook_event_id` (unique), `booking_id` (FK), `status`, `amount_paise`, `razorpay_notes` (jsonb) |
| `invoices` | `id` (uuid) | `invoice_number` (auto: CC360-INV-YYYY-NNNNN), `booking_id` (FK), `payment_id` (FK → payments), `customer_id` (FK), `total_paise` |
| `nurses` | `id` (uuid) | `profile_id` (FK → profiles), `first_name`, `speciality`, `status` |
| `callbacks` | `id` (uuid) | `name`, `phone`, `preferred_time` |
| `applications` | `id` (uuid) | `first_name`, `last_name`, `email`, `phone`, `status` (submitted / reviewed / converted / rejected) |

**Extensions enabled:** `pg_stat_statements`, `pgcrypto`, `supabase_vault`, `uuid-ossp`.

**Triggers:**
- `handle_new_user()` — fires on `auth.users` INSERT, copies `full_name` and `avatar_url` into `profiles`.
- `rls_auto_enable()` — event trigger that auto-enables RLS on every new table in `public`.
- `trg_prevent_self_role_escalation()` — blocks authenticated users from changing their own `profiles.role` (only `service_role` may do this).

#### RLS Policy Matrix

| Table | Role | SELECT | INSERT | UPDATE | DELETE |
|-------|------|--------|--------|--------|--------|
| `profiles` | owner | ✅ (`auth.uid() = id`) | — | ✅ (`auth.uid() = id`) | — |
| `bookings` | customer | ✅ (`auth.uid() = customer_id`) | ❌ deny-all | ❌ deny-all | ❌ deny-all |
| `bookings` | nurse | ✅ (via nurses subquery) | ❌ deny-all | ❌ deny-all | ❌ deny-all |
| `bookings` | service_role | bypasses RLS | ✅ (bypass) | ✅ (bypass) | ✅ (bypass) |
| `payments` | anon | ❌ deny-all | ❌ deny-all | ❌ deny-all | ❌ deny-all |
| `payments` | service_role | bypasses RLS | ✅ (bypass) | ✅ (bypass) | ✅ (bypass) |
| `invoices` | customer | ✅ (`auth.uid() = customer_id`) | — | — | — |
| `nurses` | authenticated | ✅ (`profile_id = auth.uid()`) | — | — | — |
| `callbacks` | public | — | ✅ (with check: true) | — | — |
| `applications` | public | — | ✅ (with check: true) | — | — |

**RPC function `admin_dashboard_data`:**
- `SECURITY DEFINER`, executed as `service_role`.
- Returns paginated JSONB with explicit column lists (not `SELECT *`): bookings(8 cols), callbacks(4 cols), applications(5 cols), payments(4 cols).
- Revoked from `public`, `anon`, `authenticated` — callable only by `service_role`.

### 2.4 Security Headers & CSP

All security headers are defined in `vercel.json` and applied to every route via the `/(.*)` source pattern:

| Header | Value | Purpose |
|--------|-------|---------|
| **Content-Security-Policy** | `default-src 'self'; script-src 'self' 'sha256-…' (×4) https://checkout.razorpay.com https://js-de.sentry-cdn.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://cdn.b12.io https://*.razorpay.com; connect-src 'self' https://api.razorpay.com https://o4511563071750144.ingest.de.sentry.io https://*.supabase.co wss://*.supabase.co; frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com; worker-src 'self' blob:;` | Whitelist-only resource loading. Script-src uses SHA-256 hashes for the 4 unique inline `<script>` blocks. `connect-src` locks down to Supabase, Razorpay, and Sentry ingest only. `wss://` allowed for Supabase Realtime. |
| **X-Frame-Options** | `DENY` | Clickjacking prevention |
| **X-Content-Type-Options** | `nosniff` | MIME sniffing prevention |
| **X-XSS-Protection** | `1; mode=block` | Legacy XSS filter (defense-in-depth) |
| **Referrer-Policy** | `strict-origin-when-cross-origin` | Limits referrer leakage |
| **Strict-Transport-Security** | `max-age=63072000; includeSubDomains; preload` | Force HTTPS for 2 years, submitted for HSTS preload |
| **Permissions-Policy** | `camera=(), microphone=(), geolocation=()` | Disables sensitive APIs |

**Route-specific headers:**

| Route | Cache-Control | Notes |
|-------|--------------|-------|
| `/api/webhook-razorpay` | `no-store, no-cache, must-revalidate, private` + `X-Robots-Tag: noindex, nofollow` | Prevents CDN caching of webhook responses |
| `/admin` | `no-store, no-cache, must-revalidate, private` | Admin dashboard never cached |
| `/login` | `no-store, no-cache, must-revalidate, private` | Login page never cached |

---

## 3. Deployment & Infrastructure Pipeline

### 3.1 Vercel Deployment

**Configuration (`vercel.json`):**

```jsonc
{
  "cleanUrls": true,          // /admin → admin.html (no extension)
  "trailingSlash": false,     // enforce trailing-slash-free URLs
  "functions": {
    "api/*.js": {
      "maxDuration": 10       // 10-second timeout for all serverless functions
    }
  }
}
```

- **Build:** No build step — static HTML files served from project root, serverless functions auto-detected from `/api/`.
- **Routing:** `cleanUrls: true` allows `/admin`, `/login` without `.html` extensions.
- **Function timeout:** 10 s (sufficient for Razorpay verification + Supabase writes + Resend email).
- **Node.js version:** 18+ (set via `package.json` and CI config).

### 3.2 Supabase Integration

**Project:** `careconnect360-staging`

**Migrations (applied in order):**

| # | File | Date | Purpose |
|---|------|------|---------|
| 1 | `20260718084120_remote_schema.sql` | 2026-07-18 | Full baseline: 7 tables, indexes, FKs, triggers, RLS policies, extensions |
| 2 | `20260718090000_hardening.sql` | 2026-07-18 | Prevent self-role-escalation trigger, dedupe redundant RLS policies, drop duplicate index, create `admin_dashboard_data` RPC |
| 3 | `20260724000000_rls_bookings_payments.sql` | 2026-07-24 | Deny-all RLS write policies on `bookings` (INSERT/UPDATE/DELETE) and `payments` (ALL for anon) |
| 4 | `20260724000001_rls_nurses_select.sql` | 2026-07-24 | SELECT policy on `nurses` for authenticated users (`profile_id = auth.uid()`) |
| 5 | `20260725000000_rpc_admin_dashboard_narrow_select.sql` | 2026-07-25 | Replace `SELECT *` with explicit column lists in `admin_dashboard_data` RPC |

**Migration policy:** Additive only — never edit or reorder existing migrations. New changes are timestamped new files.

**Service accounts used:**
- `SUPABASE_SERVICE_ROLE_KEY` — server-side handlers (`submit.js`, `webhook-razorpay.js`, `admin-verify.js`). Bypasses RLS.
- `SUPABASE_ANON_KEY` — client-side (`auth.js`) and `bookings.js` (RLS-enforced queries with caller's session token).

### 3.3 Environment Secrets Management

**Runtime secrets (set in Vercel dashboard, never committed):**

| Secret | Used By | Purpose |
|--------|---------|---------|
| `ALLOWED_ORIGIN` | All API handlers | Exact-match production origin for CORS |
| `ALLOWED_PREVIEW_ORIGINS` | `submit.js`, `admin-login.js` | Comma-separated staging origins (documented in `.env.example`) |
| `SUPABASE_URL` | All Supabase clients | Supabase project API URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `submit.js`, `webhook-razorpay.js`, `admin-verify.js` | Server-side Supabase client (bypasses RLS) |
| `SUPABASE_ANON_KEY` | `bookings.js`, client HTML | Public Supabase key (RLS-enforced) |
| `RAZORPAY_KEY_ID` | `submit.js`, `create-order.js` | Razorpay publishable key |
| `RAZORPAY_KEY_SECRET` | `submit.js`, `create-order.js`, `webhook-razorpay.js` | Razorpay secret (HMAC signing) |
| `RAZORPAY_WEBHOOK_SECRET` | `webhook-razorpay.js` | Webhook signature verification |
| `UPSTASH_REDIS_REST_URL` | All Redis consumers | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | All Redis consumers | Upstash Redis auth token |
| `JWT_SECRET` | `admin-login.js`, `admin-verify.js`, `admin-logout.js` | JWT signing key (≥32 chars enforced at startup) |
| `ADMIN_PASSWORD_HASH` | `admin-login.js` | bcrypt hash of admin password |
| `ADMIN_ALLOWED_IPS` | `admin-login.js`, `admin-verify.js`, `admin-logout.js` | Comma-separated IP allowlist for admin endpoints |
| `RESEND_API_KEY` | `submit.js`, `webhook-razorpay.js` | Resend transactional email API key |
| `ADMIN_EMAIL` | `submit.js`, `webhook-razorpay.js` | Admin notification recipient |
| `SENTRY_DSN` | `lib/logger.js` | Sentry error monitoring DSN |

**Secrets committed to repo:** None. `.env`, `.env.local`, and `.vercel/` are all gitignored.

**Startup guards:** Every handler validates required env vars at module scope and throws `CRITICAL: missing <VAR>` on startup. This surfaces misconfigurations immediately rather than at request time.

### 3.4 CI/CD Pipeline

**GitHub Actions workflow** (`.github/workflows/ci.yml`):

Triggers on push to `main`/`security-and-cleanup`, PRs to `main`, and manual dispatch. Six jobs run in parallel (except deployment-readiness, which waits for all):

| Job | Tool | What It Checks |
|-----|------|----------------|
| 1. Supply Chain Security | `npm audit --audit-level=moderate` | Known dependency vulnerabilities |
| 2. Secrets Scanning | Gitleaks (full history) | Hardcoded secrets in git history |
| 3. CodeQL Analysis | GitHub CodeQL (`security-extended` + `security-and-quality`) | Semantic security vulnerabilities in JS |
| 4. Frontend Quality | `node --check` on all API files, HTML structure validation, grep for `RAZORPAY_LIVE_KEY`/`STRIPE_LIVE_KEY`/Airtable tokens | Syntax errors, missing DOCTYPE/viewport, leaked production secrets |
| 5. Lighthouse CI | `@lhci/cli` | Performance, accessibility, SEO audits |
| 6. Deployment Readiness | Aggregates results from jobs 1–5 | Pass/fail summary gate |

**Concurrency:** `group: workflow-ref` with `cancel-in-progress: true` — redundant runs are cancelled on new pushes.

---

## 4. Security Hardening Summary

21 tasks remediated from the 2026-07-23 security audit, executed in strict severity order.

### 4.1 Phase 0 — Critical Blockers

| Task | Severity | Problem | Fix | Files |
|------|----------|---------|-----|-------|
| **TASK-001** | Critical | Logout only cleared `sessionStorage` — JWT remained valid for up to 12 h | Logout handler now `POST`s Bearer token to `/api/admin-logout` which adds `jti` to Redis blocklist | `admin.html` |
| **TASK-002** | Critical | Wildcard CORS accepted any `*.vercel.app` origin | Exact-match against `ALLOWED_ORIGIN` + `ALLOWED_PREVIEW_ORIGINS` (comma-separated) | `api/submit.js`, `api/admin-login.js` |
| **TASK-003** | Critical | No server-side Razorpay HMAC signature verification before booking write | Computes `HMAC-SHA256(order_id\|payment_id, key_secret)` and verifies with `crypto.timingSafeEqual` before any Redis/DB write. Rejects 402 on mismatch. | `api/submit.js` |
| **TASK-004** | Critical | `bookings` had SELECT-only RLS (any auth user could INSERT directly); `payments` had RLS enabled with zero policies | Explicit deny-all INSERT/UPDATE/DELETE policies on `bookings`; deny-all-anon on `payments`. Service_role bypasses RLS, so server-side writes unaffected. | `supabase/migrations/20260724000000_rls_bookings_payments.sql` |
| **TASK-005** | Critical | Unhandled `JSON.parse` on webhook body caused 500 → Razorpay retry storm | Wrapped in try/catch; returns 400 (not 500) so Razorpay stops retrying | `api/webhook-razorpay.js` |

### 4.2 Phase 1 — Security Hardening

| Task | Severity | Problem | Fix | Files |
|------|----------|---------|-----|-------|
| **TASK-006** | High | `validateCurrency` referenced undefined `CONFIG.DEFAULT_CURRENCY` | Replaced with literal `'INR'` | `api/security-utils.js` |
| **TASK-007** | High | IPv4-only regex rejected all IPv6 addresses | Replaced with `net.isIP()` (handles both v4 and v6) | `api/security-utils.js` |
| **TASK-008** | High | Redis blocklist check failed **open** on Upstash outage | Flipped to fail-closed — `return true` (blocked) on error | `lib/redis-blocklist.js` |
| **TASK-009** | High | `x-forwarded-for` extraction read first (attacker-controlled) entry | Changed to `.pop()` (last entry, Vercel-appended/trustworthy) in all 3 admin handlers | `api/admin-login.js`, `api/admin-verify.js`, `api/admin-logout.js` |
| **TASK-010** | High | CSP `script-src` used `'unsafe-inline'` | Replaced with 4 SHA-256 hashes for the unique inline `<script>` blocks | `vercel.json` |
| **TASK-011** | Medium | `nurses` table RLS enabled but no SELECT policy — reads silently blocked | Added `CREATE POLICY` for authenticated users (`profile_id = auth.uid()`) | `supabase/migrations/20260724000001_rls_nurses_select.sql` |
| **TASK-012** | Medium | XSS sink via `innerHTML` with unsanitized `err.message` in admin error rendering | Replaced with `createElement` + `textContent` (both `admin.html` copies) | `admin.html` |
| **TASK-013** | Medium | No startup guard for missing `SUPABASE_URL`/`SUPABASE_ANON_KEY` in `bookings.js` | Added module-scope throw on missing env vars (matches pattern in other handlers) | `api/bookings.js` |

### 4.3 Phase 2 — Performance

| Task | Severity | Problem | Fix | Files |
|------|----------|---------|-----|-------|
| **TASK-014** | Medium | `admin_dashboard_data` RPC did `SELECT *` on 4 tables (~49 columns) | Replaced with explicit column lists (21 columns total: bookings 8, callbacks 4, applications 5, payments 4) | `supabase/migrations/20260725000000_rpc_admin_dashboard_narrow_select.sql` |
| **TASK-015** | Low | `Ratelimit` instance constructed per-request | Hoisted to module scope (built once per warm Lambda) | `api/create-order.js` |
| **TASK-016** | Medium | Invoice write always set `customer_id: null`; sequential awaits that could parallelize | Fetches `customer_id` from existing booking lookup; parallelizes status-update + invoice-existence-check via `Promise.all` | `api/webhook-razorpay.js` |

### 4.4 Phase 3 — Maintainability

| Task | Severity | Problem | Fix | Files |
|------|----------|---------|-----|-------|
| **TASK-017** | — | Duplicate root/ vs `public/` HTML tree | Consolidated to single source (root). Deleted all 7 files from `public/`. Simplified build script. Removed 3 now-unnecessary CSP hashes. | `public/*.html` (deleted), `package.json`, `vercel.json` |
| **TASK-018** | Low | Duplicated `hashPII` in `submit.js` and `security-utils.js` | Deleted local copy in `submit.js`, imported from `security-utils.js` | `api/submit.js` |
| **TASK-019** | Low | Inline `x-forwarded-for` parsing in `submit.js` bypassed shared validation | Replaced with `SecurityUtils.extractIP()` call. Fixed root cause: changed to `.pop()` to match TASK-009 pattern. | `api/submit.js`, `api/security-utils.js` |
| **TASK-020** | [~] Pending Product Decision | `getEmailTemplate` handles `refund.processed` but not `refund.created` | Flagged with code comment (product decision pending — `syncToSupabase` already maps both to `refunded` status) | `api/webhook-razorpay.js` |
| **TASK-021** | Low | `invoices.payment_id` FK was never populated | Looks up `payments.id` (uuid) from `payments.payment_id` (Razorpay text ID) during invoice creation | `api/webhook-razorpay.js` |

---

## 5. Data Flow Diagrams

### 5.1 Booking Payment Flow

```
Browser                          Vercel Serverless              Razorpay              Supabase
   │                                    │                          │                    │
   │  POST /api/create-order            │                          │                    │
   │  {amount: 50000, currency: INR}    │                          │                    │
   │ ─────────────────────────────────► │                          │                    │
   │                                    │  POST /v1/orders         │                    │
   │                                    │ ───────────────────────► │                    │
   │  {orderId, keyId, amount}          │  ←─────────────────────  │                    │
   │ ◄───────────────────────────────── │                          │                    │
   │                                    │                          │                    │
   │ ─── Razorpay Checkout (client) ───────────────────────────── │                    │
   │                                    │                          │                    │
   │  POST /api/submit                  │                          │                    │
   │  {type:booking, payment_id,        │                          │                    │
   │   razorpay_order_id, signature}    │                          │                    │
   │ ─────────────────────────────────► │                          │                    │
   │                                    │ 1. HMAC verify           │                    │
   │                                    │ 2. Redis NX claim        │                    │
   │                                    │ 3. payments.fetch ──────►│                    │
   │                                    │    {status:captured}     │                    │
   │                                    │ 4. bookings.insert ─────────────────────────►  │
   │                                    │ 5. Resend email ─────►   │                    │
   │  {ok: true}                        │                          │                    │
   │ ◄───────────────────────────────── │                          │                    │
```

### 5.2 Webhook Reconciliation Flow

```
Razorpay                     Vercel Serverless              Upstash Redis         Supabase
   │                               │                              │                    │
   │ POST /api/webhook-razorpay    │                              │                    │
   │ + x-razorpay-signature        │                              │                    │
   │ ─────────────────────────────►│                              │                    │
   │                               │ 1. Verify HMAC               │                    │
   │                               │ 2. Idempotency check ──────► │                    │
   │                               │ 3. JSON.parse (try/catch)    │                    │
   │                               │ 4. Upsert payments ──────────────────────────────► │
   │                               │ 5. If captured:              │                    │
   │                               │    a. Update bookings.status ────────────────────►  │
   │                               │    b. Check invoices exist ──────────────────────►  │
   │                               │    c. Lookup payments.id ────────────────────────►  │
   │                               │    d. Insert invoice ────────────────────────────►  │
   │                               │ 6. Send admin email ──►      │                    │
   │ 200 OK                        │                              │                    │
   │ ◄──────────────────────────── │                              │                    │
```

### 5.3 Admin Auth Flow

```
Browser                          Vercel Serverless              Upstash Redis         Supabase
   │                                    │                          │                    │
   │ POST /api/admin-login              │                          │                    │
   │ {password}                         │                          │                    │
   │ ─────────────────────────────────► │                          │                    │
   │                                    │ 1. IP allowlist check    │                    │
   │                                    │ 2. Rate limit ──────────►│                    │
   │                                    │ 3. bcrypt.compare        │                    │
   │                                    │ 4. jwt.sign {role,jti}   │                    │
   │ {ok, token, expiresIn}            │                          │                    │
   │ ◄───────────────────────────────── │                          │                    │
   │                                    │                          │                    │
   │ sessionStorage.setItem(token)      │                          │                    │
   │                                    │                          │                    │
   │ POST /api/admin-verify             │                          │                    │
   │ Authorization: Bearer <token>      │                          │                    │
   │ ─────────────────────────────────► │                          │                    │
   │                                    │ 1. IP allowlist check    │                    │
   │                                    │ 2. jwt.verify            │                    │
   │                                    │ 3. Blocklist check ─────►│                    │
   │                                    │ 4. RPC admin_dashboard_data ──────────────────►  │
   │ {ok, bookings, callbacks, ...}     │                          │                    │
   │ ◄───────────────────────────────── │                          │                    │
   │                                    │                          │                    │
   │ POST /api/admin-logout             │                          │                    │
   │ Authorization: Bearer <token>      │                          │                    │
   │ ─────────────────────────────────► │                          │                    │
   │                                    │ 1. jwt.verify            │                    │
   │                                    │ 2. blocklistToken(jti) ─►│ (SET with TTL)     │
   │ {ok, message}                      │                          │                    │
   │ ◄───────────────────────────────── │                          │                    │
```

---

## 6. File Map

```
Careconnect360-main/
├── api/
│   ├── submit.js              POST /api/submit (bookings, callbacks, applications)
│   ├── create-order.js        POST /api/create-order (Razorpay order creation)
│   ├── webhook-razorpay.js    POST /api/webhook-razorpay (payment ledger sync)
│   ├── admin-login.js         POST /api/admin-login (JWT issuance)
│   ├── admin-verify.js        POST /api/admin-verify (session validation + dashboard data)
│   ├── admin-logout.js        POST /api/admin-logout (JWT revocation)
│   ├── bookings.js            GET /api/bookings (customer bookings via RLS)
│   └── security-utils.js      Shared: hashPII, extractIP, validateAmount, validateCurrency
│
├── lib/
│   ├── redis-blocklist.js     JWT revocation blocklist (fail-closed)
│   └── logger.js              Structured JSON logger + Sentry integration
│
├── auth.js                    Client-side Supabase auth (Google OAuth, role routing)
│
├── index.html                 Landing page (3237 lines, inline JS)
├── admin.html                 Admin dashboard (278 lines)
├── login.html                 Google OAuth login (68 lines)
├── Contact.html               Contact page
├── PrivacyPolicy.html         Privacy policy
├── Refund.html                Refund policy
├── Terms-Conditions.html      Terms & conditions
│
├── supabase/
│   └── migrations/
│       ├── 20260718084120_remote_schema.sql                Baseline schema (7 tables)
│       ├── 20260718090000_hardening.sql                    Role-escalation trigger, RPC
│       ├── 20260724000000_rls_bookings_payments.sql        Deny-all write RLS
│       ├── 20260724000001_rls_nurses_select.sql            Nurses SELECT policy
│       └── 20260725000000_rpc_admin_dashboard_narrow_select.sql  Narrow column RPC
│
├── .github/workflows/
│   └── ci.yml                 6-job CI/CD pipeline (audit, Gitleaks, CodeQL, frontend, Lighthouse)
│
├── vercel.json                Deployment config + security headers + CSP
├── package.json               ESM project, 8 runtime dependencies
├── .env.example               ALLOWED_PREVIEW_ORIGINS template
├── PRD.md                     Audit remediation plan (21 tasks)
├── progress.txt               Append-only task completion log
├── AGENTS.md                  Agent coding guidelines
├── PROMPT.md                  Ralph Loop standing instructions
└── verify.sh                  Pre-commit verification gate
```

---

*Generated from codebase analysis on 2026-07-25. Source of truth: `PRD.md` for task status, `progress.txt` for completion history, `supabase/migrations/` for schema, `vercel.json` for headers and deployment config.*
