# External processors

Every external service that processes personal data on behalf of Questline needs: PM approval, a data processing
agreement (DPA), a CH/EU processing location, and an entry here **before** any integration code is written
(R-PRIV-03). Sub-processors of the processor are listed as disclosed by the provider.

## Approved processors

| # | Processor | Role | Personal data received | Location | DPA | Approved by / on | Notes |
|---|-----------|------|------------------------|----------|-----|------------------|-------|
| – | *none yet* | | | | | | |

## Candidates awaiting PM decision (see `docs/hosting-options.md`)

| Decision | Candidate | Would receive | Location | Status |
|----------|-----------|---------------|----------|--------|
| Q-01 hosting / database | Exoscale (Akenes SA) — or — Scaleway — or — Hetzner — or — AWS/GCP/Azure Swiss regions | All categories as ciphertext/hashes plus plaintext structural data (data-inventory C1–C14) | CH (Geneva/Zurich) / EU | pending |
| Q-02 KMS | Provider KMS of the chosen host — or — self-hosted OpenBao Transit (no processor) — or — Scaleway Key Manager | Wrapped/unwrapped per-user DEKs during wrap/unwrap calls; **no user content** | same as hosting | pending |
| Q-03 transactional email | Infomaniak (CH) — or — Scaleway Transactional Email (FR) — or — Brevo (FR) — or — Mailjet (FR) | Recipient email address, locale, one-time links (verification/reset), security notices; **no goal content** | CH / FR | pending |

## Explicitly not used

- Third-party analytics, crash reporting, A/B testing, advertising or attribution SDKs/services.
- Push-notification services (no server-side push in v1).
- External password-breach APIs (the breach list is offline, ADR-0012).
- AI/ML services receiving user content.

## Review

Re-validated at every milestone report and whenever a provider changes its sub-processors or terms.
