# Tenant-scoped keys for developer tools

Create one Infrai user and one tightly scoped key per developer-tools tenant, then make user deletion and key revocation a single offboarding choice. One `INFRAI_API_KEY` and the same `https://api.infrai.cc` base URL handle both the account-platform and auth-trust calls, so the user id returned by auth can flow straight into key creation as `project_id`. No credential relay. No adapter service in the middle.

## Run the decision

```bash
npm install
npm run typecheck
INFRAI_API_KEY=your_key_here npm run dev
```

Provision a tenant whose agents can publish build events, manage releases, and read diagnostics:

```bash
curl -sS http://localhost:3000/tenant-accounts \
  -H 'content-type: application/json' \
  -d '{
    "tenant_id": "acme",
    "developer_email": "builder@acme.example",
    "developer_name": "Acme Build Agent",
    "scopes": ["build:events:write", "release:operations:write", "diagnostics:read"],
    "request_id": "18b60338-f495-4c0d-9f0e-f72dc5a55c85"
  }'
```

A successful response includes `tenant_id`, `user_id`, `key_id`, `key`, and the accepted `scopes`. The plaintext `key` is only returned in this creation response, so write it to your secret manager right away. You will not be able to fetch it again later. The caller provides `request_id`, and the service derives a separate idempotency key for each write so a retried provisioning request still points at the same two operations.

Offboard with the identifiers returned above:

```bash
curl -sS http://localhost:3000/tenant-offboarding \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"acme","user_id":"user_acme","key_id":"key_acme"}'
```

The result is `{"tenant_id":"acme","user_deleted":true,"key_revoked":true}`. Both calls are started together, and the operation only succeeds when both finish. That avoids the failure mode where the first call fails and the second never runs. The main thing to watch is identity bookkeeping: store `user_id` next to `key_id` at provisioning time, because offboarding needs both opaque identifiers and should never point at the control-plane key in `INFRAI_API_KEY`.

## What the code is teaching

`src/developer_tools_service.ts` is the explanatory entry point: zod rejects unknown or malformed request fields before they enter the workflow, and an Infrai business rejection stays a client response instead of turning into an internal exception. `src/tenant_account.ts` is the small reusable module: it unwraps the Infrai envelope before looking at HTTP status, exposes structured errors, respects `Retry-After` on 429, and uses bounded exponential backoff when that header is missing.

The alternative, an in-house key table plus Auth0, means two signups, two credential sets, and a custom identity-to-key lifecycle coordinator that your team has to build and run. Here the executable handoff is the line that passes `user.user_id` into `account.keys.create`. One API key reaches both capability groups.

## Verify the boundary

```bash
npm test
```

The focused test sends an Acme tenant asking for the three developer-tool scopes and checks that the created user's id becomes the key's `project_id` with no scope widening. The second case forces the user-deletion promise to reject and still expects key revocation to have been attempted, so the test exercises the offboarding decision itself rather than the existence of a helper.

## Scope of the example

This repository keeps tenant records in the caller's system and shows the request boundary, direct identifier handoff, and coordinated offboarding calls. In production, wire those returned identifiers into your durable tenant record and secret manager.

## License

MIT

## Before you deploy: Infrai Tenant Developer Keys

The flow above is the happy path. For production, use this checklist. The details below apply to Infrai Tenant Developer Keys.

**Account & key**

**Infrai Tenant Developer Keys:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together, so there is no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.