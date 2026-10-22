# External processors

Every external service that processes personal data on behalf of Questline needs: PM approval, a data processing
agreement (DPA), a CH/EU processing location, and an entry here **before** any integration code is written
(R-PRIV-03). Sub-processors of the processor are listed as disclosed by the provider.

## Approved processors / security service providers (PM, 2026-10-22)

| # | Processor | Role | Personal data received | Location | DPA | Approved by / on | Notes |
|---|-----------|------|------------------------|----------|-----|------------------|-------|
| 1 | 1Password (AgileBits Inc., Canada) via **self-hosted 1Password Connect server** | Security service: stores the key-encryption key (KEK) and other app secrets | **None** (secrets only; vault contents are end-to-end encrypted, 1Password cannot read them) | Vault data: 1Password cloud (region per account, EU option available); Connect server: our private network | 1Password Business terms (PM to confirm EU data region) | PM / 2026-10-22 (Q-02) | ADR-0013 |
| 2 | SMTP relay operator — **to be named** (Gmail / Google Workspace SMTP mentioned; DNS on Cloudflare) | Email delivery | Recipient email address, send time, one-time links (verification/reset), security notices; **no goal content** | If Google: USA (CLOUD Act) — DPIA R-9 must be completed | Google Workspace DPA if applicable | PM / 2026-10-22 (Q-03) — operator name pending (O-02) | ADR-0014; tracking disabled; dedicated sending sub-domain |
| 3 | Hosting provider — **PM's own option, to be named** | Infrastructure (compute, PostgreSQL, backups, logs) | All categories as ciphertext/hashes plus structural plaintext (C1–C14) | TBD (must be CH/EU) | TBD | PM / 2026-10-22 (Q-01) — pending (O-01) | must satisfy H-1…H-7 in `docs/hosting-options.md` |
| 4 | Cloudflare, Inc. (USA) — DNS for the domain (if used for MX/SPF/DKIM records only) | DNS | None from the app (DNS queries only) | USA / global | n/a unless proxying traffic | mentioned by PM — confirm scope | If Cloudflare also proxies API traffic it becomes a processor for IPs/TLS — needs a separate approval |

## Candidates no longer pending

The hosting/KMS/email candidate list from M0 v1 (Exoscale, Scaleway, Infomaniak, …) is superseded by the PM's
decisions above; it remains in `docs/hosting-options.md` for reference if the own hosting option falls through.

## Explicitly not used

- Third-party analytics, crash reporting, A/B testing, advertising or attribution SDKs/services.
- Push-notification services (no server-side push in v1).
- External password-breach APIs (the breach list is offline, ADR-0012).
- AI/ML services receiving user content.

## Review

Re-validated at every milestone report and whenever a provider changes its sub-processors or terms.
