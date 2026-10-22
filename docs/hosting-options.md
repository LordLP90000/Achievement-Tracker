# Hosting options (Switzerland / EU)

Status: M0 proposal (2026-10-22) for decisions **Q-01 (hosting), Q-02 (KMS), Q-03 (email)**. I do not choose
alone; this document lists options, trade-offs and my recommendation. Prices are indicative orders of magnitude
for a small production setup (API + worker, managed PostgreSQL with HA, backups) and must be re-checked at decision
time. Facts marked ⚠ were not independently verified in M0 and must be confirmed before signing up.

## 1. Requirements the host must meet

| # | Requirement | Source |
|---|-------------|--------|
| H-1 | Data stored and processed in Switzerland or the EU, provider contractually bound (DPA), sub-processors disclosed | brief, R-PRIV-03 |
| H-2 | Managed PostgreSQL (or a clear path to run it) with encrypted disks, automated encrypted backups with ≤ 30-day retention, private networking, TLS | R-ENC-03, R-PRIV-07 |
| H-3 | A KMS with encrypt/decrypt (wrap/unwrap) API and audit logging for the KEK — or a vetted self-hosted alternative | R-ENC-01, ADR-0006 |
| H-4 | Container hosting with non-root, read-only filesystem, secret injection from a secret store, TLS termination with TLS 1.2+/1.3 and HSTS | R-SUP-03, R-TLS-01 |
| H-5 | Logs/metrics retained in-region without third-party analytics | R-PRIV-02, C13 |
| H-6 | Transactional email provider in CH/EU with DPA | Q-03 |
| H-7 | Reasonable cost for a small app; no lock-in in the code (everything behind interfaces) | PM |

## 2. Compute + database options

| Option | HQ / jurisdiction | Regions | Managed PostgreSQL | KMS | Container platform | Indicative cost / month (small HA) | Notes |
|--------|-------------------|---------|--------------------|-----|--------------------|------------------------------------|-------|
| **A. Exoscale** (Akenes SA, part of A1 Digital) | Switzerland | Geneva `ch-gva-2`, Zurich `ch-dk-2`, plus AT/DE/BG | **Yes** — DBaaS PostgreSQL with HA plans, automated backups, private networks | **Yes** — Exoscale KMS with `encrypt`/`decrypt` API and *encryption context* (AAD), first key free | SKS (managed Kubernetes) or plain instances with Docker; load balancer with TLS | ≈ CHF 150–300 | Swiss company, Swiss data centres, FADP/GDPR, ISO 27001. Everything for H-1…H-5 from one Swiss provider. Smaller ecosystem than hyperscalers. |
| **B. Infomaniak** | Switzerland | Geneva area (multiple DCs) | ⚠ Self-managed on Public Cloud (OpenStack) or VPS; no first-party managed PostgreSQL known | ⚠ none known | Public Cloud (OpenStack) / Jelastic / VPS | ≈ CHF 80–200 | Strong privacy stance, renewable energy, Swiss. Running PostgreSQL ourselves adds operational burden (backups, HA, patching) and risk; good fit for **email** (SMTP relay + REST API) rather than DB hosting. |
| **C. Scaleway** | France (Iliad) | Paris, Amsterdam, Warsaw | Yes — Managed Database for PostgreSQL (HA option, backups) | ⚠ Scaleway Key Manager — verify GA status and encrypt/decrypt API at decision time | Serverless Containers, Kapsule (K8s), Instances; Load Balancer with TLS | ≈ EUR 80–200 | EU only (no CH). Also offers Transactional Email ⚠ (verify GA). Good price/feature ratio. |
| **D. Hetzner** | Germany | Falkenstein, Nuremberg, Helsinki | No managed PostgreSQL (self-managed on VMs, or a third-party DBaaS such as Aiven in an EU region = second processor) | None (self-host OpenBao/Vault Transit) | VMs + Docker/K3s, Hetzner LB | ≈ EUR 40–120 (+ ops time) | Cheapest; most operational work and risk on us (DB HA, backups, KMS). EU only. |
| **E. OVHcloud** | France | Gravelines, Strasbourg, Roubaix, Frankfurt, Warsaw … | Yes — Public Cloud Databases (PostgreSQL) | ⚠ OVHcloud KMS — verify API scope | Managed Kubernetes, instances | ≈ EUR 80–200 | EU only; SecNumCloud-qualified offers for sensitive data; large ecosystem. |
| **F. AWS / Google Cloud / Azure (Swiss regions)** | USA | Zurich: AWS `eu-central-2`, GCP `europe-west6`, Azure Switzerland North | Yes (RDS/Aurora, Cloud SQL, Flexible Server) | Yes (AWS KMS, Cloud KMS, Key Vault) — mature | ECS/Fargate, Cloud Run, Container Apps | ≈ CHF 200–400 (Swiss regions carry a premium) | Best tooling and maturity. **But**: US-headquartered → US CLOUD Act reach regardless of region; must be assessed in the DPIA (R-9); the KMS KEK would also be under the provider's legal reach. |

## 3. KMS options (Q-02)

| Option | Fits with | Pros | Cons |
|--------|-----------|------|------|
| **Exoscale KMS** | A | Same provider/jurisdiction as the data; encrypt/decrypt with AAD matches our `KeyWrapper` (AAD = user ID); audit log; first key free | Newer service; API via Exoscale IAM (API keys with role restrictions) |
| Provider KMS (Scaleway/OVH/AWS/GCP/Azure) | C/E/F | Mature on hyperscalers | Cross-provider use (e.g. Exoscale compute + AWS KMS) splits jurisdictions and adds latency — not recommended |
| **Self-hosted OpenBao / HashiCorp Vault — Transit engine** | any (B, D especially) | Full control; open source (OpenBao is the Linux Foundation fork of Vault); Transit does exactly wrap/unwrap | We operate an HA secret service (unseal, backups, upgrades) — significant ops burden and a new critical component; only recommended if no provider KMS exists |
| Infisical KMS (SaaS or self-hosted) | any | Open source, simple API | SaaS adds a processor; self-hosted = same burden as OpenBao |

The application code depends only on the `KeyWrapper` interface (wrap/unwrap with AAD); switching provider is one
adapter + a re-wrap job of all DEKs (cheap: one small record per user).

## 4. Transactional email options (Q-03)

| Option | HQ | Sending location | Interface | Indicative cost | Notes |
|--------|----|------------------|-----------|-----------------|-------|
| **Infomaniak** | Switzerland | CH | Authenticated SMTP (app password, STARTTLS 587) and REST API (OAuth 2.0) | included in a mail/hosting plan, from ≈ CHF 5–20 | Swiss, privacy-focused. For our volume (verification/reset/notices) SMTP via `nodemailer` or the REST API via `fetch`. ⚠ Confirm sending limits and DPA terms for app-generated mail. |
| Scaleway Transactional Email | France | FR | REST API / SMTP | pay per email (≈ EUR 0.25–0.50 per 1 000) | Natural fit if hosting is Scaleway. ⚠ verify GA. |
| Brevo (ex-Sendinblue) | France | EU | REST API / SMTP | free tier, then ≈ EUR 15–25 | Mature deliverability tooling; more features than we need (and more data processing by default — disable tracking). |
| Mailjet (Sinch) | France / Sweden | EU | REST API / SMTP | free tier, then ≈ EUR 15–25 | Similar to Brevo. |
| Non-EU providers (Postmark, SendGrid, Resend, SES outside EU) | USA | – | – | – | **Not recommended** (jurisdiction). |

Whatever the provider: disable open/click tracking, keep provider-side logs minimal, use a dedicated sending
domain with SPF/DKIM/DMARC, and send **no goal content**.

## 5. Recommendation

| Decision | Recommendation | Why | Fallback |
|----------|----------------|-----|----------|
| Q-01 hosting | **A. Exoscale (Zurich `ch-dk-2`, backups to Geneva)** — managed PostgreSQL HA plan, 2 small instances (API + worker) or SKS if the PM wants Kubernetes | Swiss jurisdiction for the whole stack; managed DB satisfies H-2 without us operating PostgreSQL; KMS in the same jurisdiction satisfies H-3 | **C. Scaleway (Paris)** if cost or ecosystem matters more than CH residency — EU-only stack; re-verify its KMS/TEM maturity first |
| Q-02 KMS | **Exoscale KMS** (one KEK, yearly rotation, AAD = user ID) | Same provider, encrypt/decrypt with encryption context fits ADR-0006; no extra processor | OpenBao Transit on Exoscale if the KMS does not meet a requirement discovered in M2 |
| Q-03 email | **Infomaniak** (Swiss) via REST API or authenticated SMTP, dedicated sub-domain `mail.<domain>` | Swiss processor; low volume; privacy stance | Scaleway TEM if hosting is Scaleway |
| Dev/CI | Docker Compose locally; GitHub Actions for CI (code, no personal data) — GitHub is a US processor **for source code only**, already in use by the PM's repository | – | – |

Estimated monthly run cost for the recommendation: **≈ CHF 200–350** (DBaaS HA ≈ 100–180, two instances ≈ 40–80,
load balancer ≈ 20, KMS ≈ 0–10, email ≈ 5–20, object storage for exports/log archive ≈ 5). A single-node DB plan would
roughly halve this for a beta.

## 6. What I need from the PM

1. Choose A (Swiss) or C (EU) — or ask for a deeper evaluation of F if hyperscaler tooling is desired despite the
   jurisdiction question.
2. Approve the email provider and confirm who signs the DPA(s).
3. Confirm the budget order of magnitude.
4. Provide the production domain (API host, email sending domain, problem-type URIs — Q-19).

Until decided, M1 proceeds with provider-neutral artefacts (Docker image, Compose, CI, `KeyWrapper` with the
local adapter) — nothing in M1 depends on the choice. Q-02/Q-03 are needed at the start of M2.
