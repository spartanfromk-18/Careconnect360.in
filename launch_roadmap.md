# 🚀 CareConnect360.in — Launch Roadmap

**Target Launch: Sunday, June 8, 2026**
**Current Date: Tuesday, June 3, 2026**
**You have 5 days. Here's exactly what to do.**

---

## Day-by-Day Plan

| Day | What To Do | Time Needed |
|-----|-----------|-------------|
| **Wed Jun 4** | Airtable + Resend setup | ~1 hour |
| **Thu Jun 5** | Vercel deploy + env vars | ~30 min |
| **Fri Jun 6** | Domain DNS setup | ~20 min |
| **Sat Jun 7** | Full testing + fixes | ~2 hours |
| **Sun Jun 8** | 🎉 Go Live! Final checks | ~30 min |

---

## Step 1 — Airtable Setup (Wednesday)

> [!IMPORTANT]
> You said you already have Airtable set up with an API token. Verify these exact tables and fields exist.

### Go to [airtable.com](https://airtable.com) → Open your CareConnect base

**Create 3 tables with these EXACT names and fields:**

### Table 1: `Bookings`
| Field Name | Field Type |
|-----------|-----------|
| Name | Single line text |
| CareType | Single line text |
| Service | Single line text |
| Location | Single line text |
| Date | Single line text |
| Time | Single line text |
| Notes | Long text |
| Timestamp | Single line text |

### Table 2: `Callbacks`
| Field Name | Field Type |
|-----------|-----------|
| Name | Single line text |
| Phone | Single line text |
| PreferredTime | Single line text |
| Timestamp | Single line text |

### Table 3: `Applications`
| Field Name | Field Type |
|-----------|-----------|
| FirstName | Single line text |
| LastName | Single line text |
| Email | Email |
| Phone | Single line text |
| MNC_Registration | Single line text |
| Experience | Single line text |
| Speciality | Single line text |
| Message | Long text |
| Timestamp | Single line text |

### Get your credentials:
1. **API Token** → [airtable.com/create/tokens](https://airtable.com/create/tokens)
   - Create a Personal Access Token
   - Scopes: `data.records:read` + `data.records:write`
   - Access: Your CareConnect base
   - Copy the token (starts with `pat...`)

2. **Base ID** → Open your base → Help → API Documentation → Copy the Base ID (starts with `app...`)

> [!TIP]
> Save these somewhere safe — you'll need them in Step 3.

---

## Step 2 — Resend Email Setup (Wednesday)

### Go to [resend.com](https://resend.com) → Sign up (free tier = 3,000 emails/month)

1. **Get API Key:**
   - Dashboard → API Keys → Create API Key
   - Copy it (starts with `re_...`)

2. **Verify your domain** (required to send from `notifications@careconnect360.in`):
   - Go to Resend → Domains → Add Domain
   - Enter: `careconnect360.in`
   - Resend will give you **DNS records** to add (MX, TXT, DKIM)
   - Add these DNS records where you bought your domain (GoDaddy, Namecheap, Hostinger, etc.)
   - Wait for verification (usually 5-30 minutes)

> [!WARNING]
> Until the domain is verified, Resend won't send emails from `notifications@careconnect360.in`. The website will still work — form submissions will save to Airtable, but email notifications won't go out.

---

## Step 3 — Vercel Deploy (Thursday)

### Go to [vercel.com](https://vercel.com) → Sign up with GitHub

1. **Import Project:**
   - Click "Add New" → "Project"
   - Import from GitHub → Select `spartanfromk-18/Careconnect360.in`
   - Framework Preset: **Other** (not Next.js)
   - Root Directory: `./` (leave default)
   - Click **Deploy**

2. **Add Environment Variables:**
   - Go to your project → Settings → Environment Variables
   - Add ALL of these (for **Production**, **Preview**, and **Development**):

| Variable | Value |
|---------|-------|
| `AIRTABLE_API_KEY` | `pat...` (your token from Step 1) |
| `AIRTABLE_BASE_ID` | `app...` (your base ID from Step 1) |
| `AIRTABLE_BOOKINGS_TABLE` | `Bookings` |
| `AIRTABLE_CALLBACKS_TABLE` | `Callbacks` |
| `AIRTABLE_APPS_TABLE` | `Applications` |
| `RESEND_API_KEY` | `re_...` (your key from Step 2) |
| `ADMIN_EMAIL` | `careconnect.in.help@gmail.com` |
| `ADMIN_PASSWORD` | Pick a strong password (16+ chars) |
| `JWT_SECRET` | Generate with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ALLOWED_ORIGIN` | `https://careconnect360.in` |

3. **Redeploy** after adding env vars:
   - Go to Deployments → Click the 3 dots on latest → Redeploy

> [!IMPORTANT]
> The `JWT_SECRET` must be a random string. Run the command above in your terminal to generate one. Or visit [generate-secret.vercel.app/64](https://generate-secret.vercel.app/64).

---

## Step 4 — Domain DNS Setup (Friday)

### Connect `careconnect360.in` to Vercel

1. **In Vercel:**
   - Project → Settings → Domains
   - Add: `careconnect360.in`
   - Add: `www.careconnect360.in`
   - Vercel will show you DNS records to add

2. **At your domain registrar** (GoDaddy/Namecheap/Hostinger/etc.):
   - Add an **A Record**:
     - Name: `@`
     - Value: `76.76.21.21`
   - Add a **CNAME Record**:
     - Name: `www`
     - Value: `cname.vercel-dns.com`

3. **Wait for DNS propagation** (usually 10 min - 24 hours)

4. **SSL** is automatic — Vercel handles HTTPS for you

> [!TIP]
> You can check propagation at [dnschecker.org](https://dnschecker.org)

---

## Step 5 — Full Testing (Saturday)

### Test every page loads:
- [ ] `https://careconnect360.in` — Homepage
- [ ] `https://careconnect360.in/services.html` — Services
- [ ] `https://careconnect360.in/how-it-works.html` — How It Works
- [ ] `https://careconnect360.in/for-nurses.html` — For Nurses
- [ ] `https://careconnect360.in/login.html` — Login/Signup
- [ ] `https://careconnect360.in/privacy.html` — Privacy Policy
- [ ] `https://careconnect360.in/admin.html` — Admin Dashboard

### Test forms (submit test data):
- [ ] Book a service → Check it appears in Airtable `Bookings` table
- [ ] Request callback → Check it appears in Airtable `Callbacks` table
- [ ] Apply as nurse → Check it appears in Airtable `Applications` table
- [ ] Check email → You should receive notification at `careconnect.in.help@gmail.com`

### Test admin dashboard:
- [ ] Go to `/admin.html`
- [ ] Login with your `ADMIN_PASSWORD`
- [ ] Verify it shows all bookings, callbacks, and applications from Airtable

### Test contact links:
- [ ] Phone link dials `+91-8968893965`
- [ ] Email link opens `careconnect.in.help@gmail.com`
- [ ] WhatsApp link opens `wa.me/918968893965`

### Test mobile:
- [ ] Open on your phone — check responsive layout

---

## Step 6 — Go Live! (Sunday 🎉)

- [ ] All tests pass
- [ ] Remove any test data from Airtable
- [ ] Share the link: **https://careconnect360.in**

---

## Quick Reference — All Accounts Needed

| Service | URL | Cost |
|---------|-----|------|
| **GitHub** | github.com | ✅ Free |
| **Vercel** | vercel.com | ✅ Free (Hobby plan) |
| **Airtable** | airtable.com | ✅ Free (1,000 records/base) |
| **Resend** | resend.com | ✅ Free (3,000 emails/month) |
| **Domain** | Your registrar | 💰 Already purchased |

**Total cost: ₹0 (besides the domain you already own)**

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Form submissions fail | Check Airtable env vars in Vercel. Field names must match exactly. |
| No email notifications | Check Resend domain verification. Check `RESEND_API_KEY` in Vercel. |
| Admin login fails | Check `ADMIN_PASSWORD` and `JWT_SECRET` are set in Vercel env vars. |
| Site shows 404 | Check Vercel deployment — make sure root directory is `./` |
| DNS not working | Wait 24 hours. Check records at dnschecker.org |
| CORS errors in console | Check `ALLOWED_ORIGIN` matches your exact domain (with `https://`) |

---

> [!NOTE]
> **No code changes needed.** Everything is ready in the repo. This is purely setup and configuration work on external platforms.
