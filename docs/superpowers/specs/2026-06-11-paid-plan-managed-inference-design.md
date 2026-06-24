# Dikt Cloud Paid Plan: Tiers, Limits & Managed Inference

Companion to [2026-06-10-cloud-auth-sync-sharing-design.md](2026-06-10-cloud-auth-sync-sharing-design.md) (the "base design"). That doc defines auth, sync, video upload, and share pages. This doc defines the monetization layer on top: subscription tiers, usage limits, managed inference (we pay for AssemblyAI/Groq instead of BYO keys), metering, and Stripe billing.

## Context

Dikt is MIT-licensed and has real users. An unlimited free hosted service (especially "auto-upload every video") is financially unbounded for the maintainer. The chosen model is **open-core**: the app and server stay open source and self-hostable forever; the official hosted service is the paid product. The paid plan removes the BYO-API-key requirement entirely — transcription, summaries, and dictation inference run on Dikt's keys, metered per account — and bundles video cloud storage + share pages.

## Unit economics (verified June 2026)

| Cost driver | Rate | Notes |
|---|---|---|
| Meeting transcription (AssemblyAI Universal + speaker diarization) | **~$0.17/audio-hr** | $0.15 base + $0.02 diarization. In-region prices +10% from 2026-07-01 — pass `"model_region": "global"` to stay at current rate |
| Meeting summary (Groq `openai/gpt-oss-120b`) | **~$0.003/meeting-hr** | $0.15/M in, $0.60/M out; 1 hr ≈ 12k tokens in + 1.5k out. Negligible |
| Dictation transcription (Groq `whisper-large-v3-turbo`) | **$0.04/audio-hr** | 10-second minimum billed per request — short utterances bill as 10 s. Heavy user (50 min audio/day) ≈ $1/mo |
| Dictation formatting (modes, Groq) | negligible | tiny prompts |
| Video storage (R2) | **$0.015/GB-month**, zero egress | ~600 MB/hr at 720p30 → each stored meeting-hour ≈ $0.009/mo recurring |
| Platform fixed | ~$5–25/mo total | Workers Paid $5, Resend free→$20 at scale, D1/R2 ops negligible |
| Stripe | 2.9% + $0.30 per charge | $0.59 on a $10 charge |

Two real cost drivers: **transcription hours** (per-month) and **video storage** (cumulative). Everything else rounds to zero. Tier limits therefore meter exactly those two; "unlimited" is honest marketing for the rest (with server-side fair-use backstops, since the client is open source and modifiable).

## Tiers

| | **Local** (no account) | **Free** (account) | **Pro** | **Max** |
|---|---|---|---|---|
| Price | $0 forever | $0 | **$10/mo** ($96/yr) | **$20/mo** ($192/yr) |
| Recording, local history, local playback | ✅ | ✅ | ✅ | ✅ |
| BYO API keys (AssemblyAI/Groq/OpenAI) | ✅ | ✅ | ✅ (optional) | ✅ (optional) |
| Text sync & restore (history, meta, transcripts, summaries) | — | ✅ | ✅ | ✅ |
| Share pages | — | 3 active links, **transcript + summary only** | Unlimited, **with video** | Unlimited, with video |
| Managed meeting transcription | — | 60 min one-time credit | **20 hr/mo** | **60 hr/mo** |
| Managed summaries | — | — | Unlimited (fair use 30/day) | Unlimited (fair use 30/day) |
| Managed dictation (transcription + mode formatting) | — | — | Unlimited (fair use 4 audio-hr/day) | Unlimited (fair use 4 audio-hr/day) |
| Video cloud (auto-upload, cloud playback, restore) | — | — | **100 GB** (≈165 hr) | **500 GB** (≈830 hr) |

Margin check (worst-case single user at 100% utilization): Pro = $3.40 transcription + $1.50 storage + ~$2 dictation/summaries + $0.59 Stripe ≈ **$7.50 cost vs $10 revenue**; Max ≈ $10.20 + $7.50 + $2 + $0.88 ≈ **$20.60 vs $20** (acceptable: real utilization averages 20–40%, blended margin ~70%). Knobs (price, hours, GB) are tunable without structural change; limits live in one `PLAN_LIMITS` constant.

Positioning vs market: Otter Pro $16.99 (1,200 min/mo), Fireflies Pro $18, tl;dv Pro $25, Fathom free-unlimited (VC-subsidized). Dikt Pro at $10 with 20 hr (= 1,200 min) matches Otter's quota at 60% of the price, plus dictation and open source/local-first as differentiators. Future (out of scope): Teams tier ($/seat, shared workspaces).

### Quota semantics

- **Transcription hours**: reset on the Stripe billing-period anchor. Metered by AssemblyAI-returned `audio_duration` (actual, not claimed). Pre-flight check uses the meeting's known `duration_secs`; final metering uses the provider's number — a client that lies about duration still gets metered correctly and a negative balance blocks the next job.
- **Storage**: absolute cap on bytes in R2 (maintained `storage_bytes` counter, reconciled periodically). At cap: uploads pause with a clear UI prompt (delete meetings or upgrade); text sync continues unaffected.
- **No retention deletion** — storage is a cap, never time-boxed expiry of paid users' data.
- **Fair use** on "unlimited" items: server-enforced soft caps (429 with friendly message), exist only to stop scripted abuse of the open API surface.
- **Downgrade/cancellation**: plan drops at period end → uploads/managed inference gate off; stored video over the new cap becomes read-only (playback/download/delete still work, no new uploads) for 60 days, then the user is emailed before any cleanup. Never silently delete.
- **BYO keys always work on every tier** — managed quota is only consumed in managed mode. Per-feature setting: "Dikt Cloud (included in plan)" vs "My own API key"; defaults to managed when entitled.

## Architecture additions

### D1 schema (new tables)

```sql
CREATE TABLE subscriptions (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  stripe_customer_id TEXT, stripe_subscription_id TEXT,
  plan TEXT NOT NULL DEFAULT 'free',          -- free | pro | max
  status TEXT NOT NULL DEFAULT 'none',        -- none|active|trialing|past_due|canceled
  current_period_start_ms INTEGER, current_period_end_ms INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER NOT NULL DEFAULT 0,   -- maintained counter (upload complete / delete)
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE usage_counters (
  user_id TEXT NOT NULL, period_key TEXT NOT NULL,   -- e.g. '2026-06' anchored to billing period
  transcription_secs INTEGER NOT NULL DEFAULT 0,
  dictation_secs INTEGER NOT NULL DEFAULT 0,
  summaries_count INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, period_key)
);

CREATE TABLE transcription_jobs (              -- server-side managed jobs
  user_id TEXT NOT NULL, meeting_id TEXT NOT NULL,
  assemblyai_id TEXT, status TEXT NOT NULL,    -- submitted|completed|error
  audio_duration_secs REAL, error TEXT,
  created_at_ms INTEGER NOT NULL, completed_at_ms INTEGER,
  PRIMARY KEY (user_id, meeting_id)
);
```

Plan limits are code constants (`server/src/lib/plans.ts`), not DB rows. Entitlement resolution = session middleware loads `subscriptions` row → `c.var.plan`.

### New/changed endpoints

| Endpoint | Auth | Behavior |
|---|---|---|
| POST `/api/billing/checkout` `{plan, interval}` | bearer | Stripe Checkout session → `{url}` (desktop opens system browser; success URL = hosted "return to app" page) |
| GET `/api/billing/portal` | bearer | Stripe customer portal session → `{url}` |
| POST `/api/webhooks/stripe` | Stripe signature | `checkout.session.completed`, `customer.subscription.updated/deleted` → upsert `subscriptions` (verify via `constructEventAsync`, SubtleCrypto) |
| GET `/api/account/usage` | bearer | `{plan, status, period_end_ms, transcription:{used_secs,limit_secs}, dictation_secs, summaries_count, storage:{used_bytes,limit_bytes}, shares_active}` |
| POST `/api/meetings/:id/transcribe` | bearer + quota | Managed meeting transcription. Server presigns R2 GET of the uploaded transcript audio → submits to AssemblyAI (`audio_url`, `speaker_labels`/multichannel, `webhook_url` with per-job HMAC token, `model_region:"global"`) → job row → 202 |
| POST `/api/webhooks/assemblyai` | HMAC job token | Fetch completed transcript → normalize to `MeetingTranscript` shape (port the parsing in `src-tauri/src/meeting/transcribe.rs`) → write `meeting_transcripts` + meeting `transcript_status` with seq bumps (desktop receives via normal sync pull) → meter actual `audio_duration` |
| GET `/api/meetings/:id/transcribe/status` | bearer | Fallback poll; cron sweep re-checks jobs >15 min without webhook |
| POST `/api/meetings/:id/summarize` | bearer + quota | Server-side summary with our Groq key, same prompt as `src-tauri/src/meeting/summarize.rs` (ported to TS); synchronous (LLM wait is I/O, not Worker CPU); stores summary + seq bump |
| POST `/api/dictation/transcribe` | bearer + quota | Multipart audio proxy → Groq whisper (our key). Max 10 MB, rate-limited; meters audio seconds |
| POST `/api/dictation/format` | bearer + quota | Chat-completions proxy for mode formatting (fair-use metered) |

**Quota gates inserted into base-design endpoints**: `upload/create` (storage cap + plan gate; Free → 403 `PLAN_REQUIRED`), `shares create` (Free: ≤3 active), all managed-inference endpoints above.

### Desktop changes

- `cloud/api.rs`: new endpoint bindings; typed `QuotaExceeded`/`PlanRequired` errors surfaced as actionable UI states.
- `meeting/transcribe.rs`: branch — managed mode uploads `transcript-audio.m4a` to R2 (reuse the base-design multipart machinery; files can exceed 100 MB for long meetings) then calls `/transcribe` and relies on sync for the result; BYO path unchanged.
- Dictation path (`transcribe.rs` + mode formatting): managed mode swaps base URL to the proxy endpoints with the session bearer instead of a provider API key — request shape unchanged (OpenAI-compatible), so existing request code is reused.
- `AccountPage.tsx`: plan card (current plan, renewal date), usage meters (transcription hours, storage), Upgrade → Checkout in browser, Manage billing → portal.
- Settings (transcription/summary/dictation tabs): provider choice gains "Dikt Cloud — included in your plan" (default when entitled); BYO key fields remain.
- Upload queue: enqueue only when plan allows video; at-cap state shows on the meeting upload chip.
- Share page (`/s/:slug`): renders without `<video>` when no uploaded video (Free-tier shares) — same route, conditional block.

### Abuse controls (the client is open source and modifiable)

All enforcement server-side. Per-user rate limits on inference proxies; size caps on proxied audio; metering by provider-returned durations, never client claims; one-time free transcription credit is per verified email (OTP rate limits from the base design apply); Stripe Radar defaults for card abuse.

## Amendments to the base design

1. **"Video: auto-upload everything" becomes plan-gated** — auto-upload runs only on Pro/Max (or self-host). Free accounts get text sync only.
2. **Share pages** must render the no-video variant (Free tier).
3. **Phase 6 account deletion** must also cancel the Stripe subscription and is otherwise unchanged.
4. Self-hosters: a `SELF_HOSTED=1` Worker var disables billing/quota gates entirely (plan = unlimited) — keeps the OSS deployment first-class with zero Stripe setup.

## Phases (continuing the base design's 1–6)

7. **Billing foundation** — Stripe products/prices (Pro/Max, monthly/annual), `subscriptions` table, checkout/portal/webhook routes, plan middleware, `PLAN_LIMITS`, usage endpoint, AccountPage plan card. *Verify:* test-mode checkout upgrades a user; webhook flips plan; portal cancel downgrades at period end.
8. **Quota enforcement** — `storage_bytes` counter + reconcile, gates on `upload/create` and shares, Free-tier no-video share page, at-cap UX. *Verify:* Free account cannot upload video but shares text; capped Pro pauses uploads with prompt; delete frees space.
9. **Managed meeting inference** — transcript-audio upload path, `/transcribe` + AssemblyAI webhook + normalizer, `/summarize`, `transcription_jobs` + cron sweep, desktop branching + "included in plan" UI, metering. *Verify:* end-to-end managed transcription with app closed mid-job (result arrives via sync on relaunch); usage meter increments by actual audio duration; quota exhaustion blocks with upgrade prompt.
10. **Managed dictation** — proxy endpoints, desktop base-URL swap, fair-use limits, free-credit funnel. *Verify:* dictation works with zero configured keys on Pro; latency overhead <100 ms vs direct; rate limits return friendly errors.

Phases 7–8 can land immediately after base Phase 5 (sharing); 9 and 10 are independent of each other.

## Risks & defaults

- **AssemblyAI in-region +10% (2026-07-01)**: use `model_region:"global"`; revisit margins if global pricing changes.
- **Webhook reliability**: cron sweep is the safety net; jobs are idempotent by `(user_id, meeting_id)`.
- **Stripe on Workers**: use the official `stripe` npm package with the fetch HTTP client and async webhook verification — known-good pattern.
- **Refunds/chargebacks**: keep self-serve cancel + generous manual refunds (indie-scale); Radar handles card testing.
- **Free-credit farming**: bounded at $0.17/account, behind email verification + OTP rate limits — accepted.
- **Tax**: enable Stripe Tax from day one if selling to the EU (VAT on digital services).
