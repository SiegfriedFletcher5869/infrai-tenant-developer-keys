import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  DEVELOPER_TOOL_SCOPES,
  InfraiClient,
  InfraiError,
  offboardTenant,
  provisionTenant,
} from "./tenant_account.js";

const provisionSchema = z.object({
  tenant_id: z.string().min(1),
  developer_email: z.string().email(),
  developer_name: z.string().min(1),
  scopes: z.array(z.enum(DEVELOPER_TOOL_SCOPES)).min(1),
  request_id: z.string().uuid(),
}).strict();

const offboardingSchema = z.object({
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  key_id: z.string().min(1),
}).strict();

async function readJson(request: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");
const client = new InfraiClient(apiKey);

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/tenant-accounts") {
      const input = provisionSchema.parse(await readJson(request));
      const result = await provisionTenant(client.infrai, input);
      reply(response, 201, result);
      return;
    }
    if (request.method === "POST" && request.url === "/tenant-offboarding") {
      const input = offboardingSchema.parse(await readJson(request));
      reply(response, 200, await offboardTenant(client.infrai, input));
      return;
    }
    reply(response, 404, { error: "route_not_found" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      reply(response, 400, { error: "invalid_request", issues: error.issues });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      reply(response, status, { error: error.code, details: error.details });
      return;
    }
    reply(response, 502, { error: "upstream_request_failed" });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => console.log(`Developer-tools tenant service listening on ${port}`));
