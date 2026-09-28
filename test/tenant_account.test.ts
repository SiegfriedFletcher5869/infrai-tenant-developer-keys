import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVELOPER_TOOL_SCOPES,
  offboardTenant,
  provisionTenant,
} from "../src/tenant_account.js";

test("provisioning passes the user id directly into a least-privilege tenant key", async () => {
  let keyInput: Record<string, unknown> | undefined;
  const infrai = {
    auth: { user: {
      create: async () => ({ user_id: "user_acme" }),
      delete: async () => ({}),
    } },
    account: { keys: {
      create: async (input: Record<string, unknown>) => {
        keyInput = input;
        return { key_id: "key_acme", key_secret: "created-key-value" };
      },
      revoke: async () => ({}),
    } },
  };

  const result = await provisionTenant(infrai, {
    tenant_id: "acme",
    developer_email: "builder@acme.example",
    developer_name: "Acme Build Agent",
    scopes: [...DEVELOPER_TOOL_SCOPES],
    request_id: "18b60338-f495-4c0d-9f0e-f72dc5a55c85",
  });

  assert.equal(keyInput?.project_id, "user_acme");
  assert.deepEqual(keyInput?.scopes, DEVELOPER_TOOL_SCOPES);
  assert.equal(result.key_id, "key_acme");
});

test("offboarding attempts user deletion and key revocation as one decision", async () => {
  const calls: string[] = [];
  const infrai = {
    auth: { user: {
      create: async () => ({ user_id: "unused" }),
      delete: async () => {
        calls.push("delete-user");
        throw new Error("rejected deletion fixture");
      },
    } },
    account: { keys: {
      create: async () => ({ key_id: "unused", key_secret: "unused" }),
      revoke: async () => { calls.push("revoke-key"); return {}; },
    } },
  };

  await assert.rejects(() => offboardTenant(infrai, {
    tenant_id: "acme",
    user_id: "user_acme",
    key_id: "key_acme",
  }));
  assert.deepEqual(calls.sort(), ["delete-user", "revoke-key"]);
});
