import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { actionFingerprint } from "@ocean/core/domain/mcp/mcp-contract.js";
import type { AgentRuntimeDeps } from "@ocean/core/domain/ports/runtime-ports.js";
import { runAgent } from "@ocean/loop/runs/run-agent.js";

type GatewayRequest = {
  profile: string;
  prompt: string;
  approval: { approved: true; fingerprint: string };
};
type GatewayMessage = {
  platform: string;
  externalId: string;
  profile: string;
  prompt: string;
  approved: boolean;
};
export type GatewayAdapter = {
  id: string;
  normalize(input: unknown): GatewayMessage;
};

function sameSecret(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

export const telegramAdapter: GatewayAdapter = {
  id: "telegram",
  normalize(input: unknown): GatewayMessage {
    if (!input || typeof input !== "object")
      throw new Error("Invalid Telegram payload");
    const message = (
      input as {
        message?: {
          message_id?: number;
          text?: string;
          chat?: { id?: number };
        };
      }
    ).message;
    if (
      !message?.message_id ||
      !message.chat?.id ||
      typeof message.text !== "string" ||
      !message.text.trim()
    )
      throw new Error("Invalid Telegram message");
    const [profile = "default", ...prompt] = message.text
      .trim()
      .replace(/^\/run\s+/i, "")
      .split(/\s+/);
    return {
      platform: "telegram",
      externalId: `${message.chat.id}:${message.message_id}`,
      profile,
      prompt: prompt.join(" ") || profile,
      approved: false,
    };
  },
};

function createGatewayHandler(
  expectedToken: string,
  cwd: string,
  runtime: AgentRuntimeDeps,
) {
  const requestTimes: number[] = [];
  return async (
    input: unknown,
    token: string | undefined,
  ): Promise<{ status: number; body: string }> => {
    const credentials = expectedToken.split(",").map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1)
        return { id: "default", token: entry, profiles: undefined };
      const label = entry.slice(0, separator);
      const scopeIndex = label.indexOf("@");
      return {
        id: scopeIndex < 1 ? label : label.slice(0, scopeIndex),
        token: entry.slice(separator + 1),
        profiles:
          scopeIndex < 1
            ? undefined
            : new Set(
                label
                  .slice(scopeIndex + 1)
                  .split("|")
                  .filter(Boolean),
              ),
      };
    });
    const identity = credentials.find(
      (credential) =>
        sameSecret(credential.token, token) &&
        (!credential.profiles ||
          (typeof input === "object" &&
            input !== null &&
            credential.profiles.has((input as GatewayRequest).profile))),
    )?.id;
    if (!expectedToken || !identity)
      return { status: 401, body: "Unauthorized" };
    const now = Date.now();
    while (requestTimes[0] !== undefined && requestTimes[0] < now - 60_000)
      requestTimes.shift();
    if (requestTimes.length >= 10)
      return { status: 429, body: "Rate limit exceeded" };
    requestTimes.push(now);
    if (
      !input ||
      typeof input !== "object" ||
      typeof (input as GatewayRequest).profile !== "string" ||
      typeof (input as GatewayRequest).prompt !== "string" ||
      (input as GatewayRequest).approval?.approved !== true ||
      typeof (input as GatewayRequest).approval?.fingerprint !== "string" ||
      (input as GatewayRequest).approval.fingerprint !==
        actionFingerprint("gateway.run", {
          profile: (input as GatewayRequest).profile,
          prompt: (input as GatewayRequest).prompt,
        })
    )
      return { status: 400, body: "Invalid or unapproved request" };
    if ((input as GatewayRequest).prompt.length > 8_000)
      return { status: 413, body: "Prompt too large" };
    try {
      await runtime.loadProfile((input as GatewayRequest).profile);
    } catch {
      return { status: 400, body: "Invalid profile" };
    }
    const session = await runAgent(
      {
        profileName: (input as GatewayRequest).profile,
        prompt: (input as GatewayRequest).prompt,
        cwd,
        actor: `gateway:${identity}`,
      },
      runtime,
    );
    return {
      status: 200,
      body: JSON.stringify({
        sessionId: session.sessionId,
        status: session.status,
      }),
    };
  };
}

export async function handleGatewayRequest(
  input: unknown,
  token: string | undefined,
  expectedToken: string,
  cwd: string,
  runtime: AgentRuntimeDeps,
): Promise<{ status: number; body: string }> {
  return createGatewayHandler(expectedToken, cwd, runtime)(input, token);
}

export function createWebhookGateway(
  cwd: string,
  expectedToken: string,
  runtime: AgentRuntimeDeps,
) {
  const handleRequest = createGatewayHandler(expectedToken, cwd, runtime);
  return createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end("Method not allowed");
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += chunk.toString();
        if (body.length > 16_000) request.destroy();
      });
      request.on("end", async () => {
        try {
          const result = await handleRequest(
            JSON.parse(body),
            request.headers.authorization?.replace(/^Bearer\s+/i, ""),
          );
          response.writeHead(result.status, {
            "content-type": "application/json",
          });
          response.end(result.body);
        } catch (_error) {
          response.writeHead(500);
          response.end("Gateway request failed");
        }
      });
    },
  );
}
