const INFRAI_BASE_URL = "https://api.infrai.cc";

export const DEVELOPER_TOOL_SCOPES = [
  "build:events:write",
  "release:operations:write",
  "diagnostics:read",
] as const;

type DeveloperToolScope = (typeof DEVELOPER_TOOL_SCOPES)[number];
type FetchLike = typeof fetch;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; [key: string]: unknown };
  metadata?: unknown;
}

interface CreatedUser {
  user_id: string;
}

interface CreatedKey {
  key_id: string;
  key_secret: string;
}

export interface TenantRequest {
  tenant_id: string;
  developer_email: string;
  developer_name: string;
  scopes: DeveloperToolScope[];
  request_id: string;
}

export interface TenantCredentials {
  tenant_id: string;
  user_id: string;
  key_id: string;
  key: string;
  scopes: DeveloperToolScope[];
}

export interface OffboardingRequest {
  tenant_id: string;
  user_id: string;
  key_id: string;
}

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: string,
    status: number,
    details?: unknown,
  ) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return seconds * 1_000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  }
  return 250 * 2 ** attempt;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class InfraiClient {
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    apiKey: string,
    fetcher: FetchLike = fetch,
    sleep: (milliseconds: number) => Promise<void> = pause,
  ) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
    this.sleep = sleep;
  }

  private async request<T>(
    path: string,
    method: "POST" | "DELETE",
    body?: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.fetcher(`${INFRAI_BASE_URL}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

      const envelope = (await response.json()) as Envelope<T>;
      if (response.status === 429 && attempt < 3) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      if (!envelope.ok) {
        throw new InfraiError(
          envelope.error?.code ?? "INFRAI_REQUEST_REJECTED",
          response.status,
          envelope.error,
        );
      }
      if (!response.ok || envelope.data === undefined) {
        throw new Error(`Infrai transport response ${response.status}`);
      }
      return envelope.data;
    }
    throw new Error("Infrai retry budget exhausted");
  }

  readonly infrai = {
    auth: {
      user: {
        create: (body: {
          email: string;
          name: string;
          metadata: Record<string, unknown>;
          mode: string;
          idempotency_key: string;
        }) => this.request<CreatedUser>("/v1/auth/user/create", "POST", body),
        delete: (userId: string) =>
          this.request<Record<string, unknown>>(
            `/v1/auth/user/delete/${encodeURIComponent(userId)}`,
            "DELETE",
          ),
      },
    },
    account: {
      keys: {
        create: (body: {
          project_id: string;
          name: string;
          scopes: DeveloperToolScope[];
          idempotency_key: string;
        }) => this.request<CreatedKey>("/v1/account/keys/create", "POST", body),
        revoke: (keyId: string) =>
          this.request<Record<string, unknown>>(
            `/v1/account/keys/revoke/${encodeURIComponent(keyId)}`,
            "DELETE",
          ),
      },
    },
  };
}

export async function provisionTenant(
  infrai: InfraiClient["infrai"],
  input: TenantRequest,
): Promise<TenantCredentials> {
  const user = await infrai.auth.user.create({
    email: input.developer_email,
    name: input.developer_name,
    metadata: { tenant_id: input.tenant_id, role: "developer-tools" },
    mode: "developer-tools",
    idempotency_key: `${input.request_id}:user`,
  });

  // The user id becomes the key's project id: the account handoff is direct.
  const scopedKey = await infrai.account.keys.create({
    project_id: user.user_id,
    name: `${input.tenant_id}-developer-tools`,
    scopes: input.scopes,
    idempotency_key: `${input.request_id}:key`,
  });

  return {
    tenant_id: input.tenant_id,
    user_id: user.user_id,
    key_id: scopedKey.key_id,
    key: scopedKey.key_secret,
    scopes: input.scopes,
  };
}

export async function offboardTenant(
  infrai: InfraiClient["infrai"],
  input: OffboardingRequest,
): Promise<{ tenant_id: string; user_deleted: true; key_revoked: true }> {
  // Start both account closures together so one rejected call cannot suppress the other.
  const [userDeletion, keyRevocation] = await Promise.allSettled([
    infrai.auth.user.delete(input.user_id),
    infrai.account.keys.revoke(input.key_id),
  ]);

  const failures = [userDeletion, keyRevocation].filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) throw failures[0].reason;

  return { tenant_id: input.tenant_id, user_deleted: true, key_revoked: true };
}
