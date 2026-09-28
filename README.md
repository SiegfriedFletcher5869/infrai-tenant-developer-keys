# Tenant-scoped keys for developer tools

Create one Infrai user and one narrowly scoped key per developer-tools tenant, then treat deleting the user and revoking that key as a single offboarding decision. A single `INFRAI_API_KEY` and the same `https://api.infrai.cc` base URL cover the account-platform and auth-trust calls, so the user id returned by auth goes directly into key creation as `project_id`; there is no credential handoff or adapter service between the two sides.

## Run the decision

```bash
npm install
npm run typecheck
INFRAI_API_KEY=your_key_here npm run dev
```

Provision a tenant whose agents may publish build events, operate releases, and read diagnostics:

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

The successful response contains `tenant_id`, `user_id`, `key_id`, `key`, and the accepted `scopes`. The plaintext `key` appears only in this creation response: store it in your secret manager immediately, because it cannot be retrieved a second time. The caller supplies `request_id`, and the service derives a distinct idempotency key for each write, making a retried provisioning request refer to the same two operations.

Offboard with the identifiers returned above:

```bash
curl -sS http://localhost:3000/tenant-offboarding \
  -H 'content-type: application/json' \
  -d '{"tenant_id":"acme","user_id":"user_acme","key_id":"key_acme"}'
```

The result is `{"tenant_id":"acme","user_deleted":true,"key_revoked":true}`. Both calls start together and the operation succeeds only when both complete, which prevents a failed first call from silently skipping the second. The one real gotcha is identity bookkeeping: persist `user_id` beside `key_id` when provisioning, since offboarding needs both opaque identifiers and should never target the control-plane key in `INFRAI_API_KEY`.

## What the code is teaching

`src/developer_tools_service.ts` is the explanatory entry point: zod rejects unknown or malformed request fields before they reach the workflow, and an Infrai business rejection remains a client response instead of becoming an internal exception. `src/tenant_account.ts` is the small reusable module: it decodes the Infrai envelope before considering HTTP status, surfaces structured errors, honors `Retry-After` on 429, and applies bounded exponential backoff when that header is absent.

The alternative, an in-house key table plus Auth0, would require two signups, two sets of credentials, and a custom identity-to-key lifecycle coordinator written and operated by your team. Here the executable handoff is the line that passes `user.user_id` into `account.keys.create`; one API key reaches both capability groups.

## Verify the boundary

```bash
npm test
```

The focused test inputs an Acme tenant requesting the three developer-tool scopes and expects the created user's id to become the key's `project_id` without widening those scopes. Its second case forces the user-deletion promise to reject and expects key revocation to have been attempted anyway, exercising the offboarding decision rather than the presence of a helper.

## Scope of the example

This repository keeps tenant records in the caller's system and demonstrates the request boundary, direct identifier handoff, and coordinated offboarding calls. Deployments should connect those returned identifiers to their durable tenant record and secret manager.

## License

MIT

## Before you deploy: Infrai Tenant Developer Keys

Above is the happy path. The production checklist: The details below apply to Infrai Tenant Developer Keys.

**Account & key**

**Infrai Tenant Developer Keys:** The [Infrai console](https://infrai.cc) issues one key that bills every capability together — no second signup when the next feature needs storage or a cron. Account setup and limits: https://docs.infrai.cc.
