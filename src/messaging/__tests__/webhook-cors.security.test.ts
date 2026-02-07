import { describe, it, expect, vi, afterEach } from "vitest";
import { createWebhookServer, type WebhookServer } from "../webhook-server.js";
import { logger } from "../../utils/logger.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

async function httpGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(url, { headers });
  const body = await response.json();
  return { status: response.status, headers: response.headers, body };
}

describe("Webhook Security - CORS and Auth Hardening", () => {
  const servers: WebhookServer[] = [];

  async function startServer(
    config: Parameters<typeof createWebhookServer>[0]
  ): Promise<WebhookServer> {
    const server = createWebhookServer(config);
    await server.start();
    servers.push(server);
    return server;
  }

  afterEach(async () => {
    for (const server of servers) {
      if (server.isRunning()) {
        await server.stop();
      }
    }
    servers.length = 0;
    vi.clearAllMocks();
  });

  it("does not set CORS headers when cors is false (default)", async () => {
    await startServer({
      port: 3870,
      path: "/test",
      secret: "test-secret",
      cors: false,
    });

    const { headers } = await httpGet("http://localhost:3870/test/health");

    expect(headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not set CORS headers when cors is not specified", async () => {
    await startServer({
      port: 3871,
      path: "/test",
      secret: "test-secret",
    });

    const { headers } = await httpGet("http://localhost:3871/test/health");

    expect(headers.get("access-control-allow-origin")).toBeNull();
  });

  it("sets CORS headers only for whitelisted origins", async () => {
    await startServer({
      port: 3872,
      path: "/test",
      secret: "test-secret",
      cors: true,
      corsOrigins: ["https://app.example.com"],
    } as Parameters<typeof createWebhookServer>[0]);

    const allowedResponse = await httpGet(
      "http://localhost:3872/test/health",
      { Origin: "https://app.example.com" }
    );

    expect(allowedResponse.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com"
    );

    const blockedResponse = await httpGet(
      "http://localhost:3872/test/health",
      { Origin: "https://evil.com" }
    );

    expect(blockedResponse.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses to start without secret when insecure is not set", async () => {
    const server = createWebhookServer({
      port: 3873,
      path: "/test",
    });

    await expect(server.start()).rejects.toThrow(/secret/i);
  });

  it("refuses to start without secret when insecure is false", async () => {
    const server = createWebhookServer({
      port: 3874,
      path: "/test",
      insecure: false,
    } as Parameters<typeof createWebhookServer>[0]);

    await expect(server.start()).rejects.toThrow(/secret/i);
  });

  it("starts with insecure: true and no secret, logs warning", async () => {
    await startServer({
      port: 3875,
      path: "/test",
      insecure: true,
    } as Parameters<typeof createWebhookServer>[0]);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/insecure/i)
    );
  });

  it("starts normally with secret configured", async () => {
    const server = createWebhookServer({
      port: 3876,
      path: "/test",
      secret: "my-secret",
    });

    await expect(server.start()).resolves.not.toThrow();
    servers.push(server);

    expect(server.isRunning()).toBe(true);
  });
});
