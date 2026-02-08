import { describe, it, expect, vi, afterEach } from "vitest";
import { createWebhookServer, type WebhookServer } from "../webhook-server.js";

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
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers });
  const body = await response.json();
  return { status: response.status, body };
}

async function httpPost(
  url: string,
  data: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(data),
  });
  const body = await response.json();
  return { status: response.status, body };
}

describe("Webhook Security - Rate Limiting", () => {
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

  it("returns 429 after exceeding rate limit on POST /approve", async () => {
    await startServer({
      port: 3890,
      path: "/test",
      insecure: true,
    });

    const requestBody = { planId: "test", approved: true };
    const requests = Array.from({ length: 101 }, () =>
      httpPost("http://localhost:3890/test/approve", requestBody)
    );
    const responses = await Promise.all(requests);

    const rateLimited = responses.filter((r) => r.status === 429);

    expect(rateLimited.length).toBeGreaterThanOrEqual(1);
  });

  it("returns 429 after exceeding rate limit on GET /status", async () => {
    await startServer({
      port: 3891,
      path: "/test",
      insecure: true,
    });

    const requests = Array.from({ length: 101 }, () =>
      httpGet("http://localhost:3891/test/status")
    );
    const responses = await Promise.all(requests);

    const rateLimited = responses.filter((r) => r.status === 429);

    expect(rateLimited.length).toBeGreaterThanOrEqual(1);
  });

  it("does not rate limit the health endpoint", async () => {
    await startServer({
      port: 3892,
      path: "/test",
      insecure: true,
    });

    const requests = Array.from({ length: 150 }, () =>
      httpGet("http://localhost:3892/test/health")
    );
    const responses = await Promise.all(requests);

    const allOk = responses.every((r) => r.status === 200);

    expect(allOk).toBe(true);
  });

  it("returns proper error structure in rate limit response", async () => {
    await startServer({
      port: 3893,
      path: "/test",
      insecure: true,
    });

    const requestBody = { planId: "test", approved: true };
    const requests = Array.from({ length: 101 }, () =>
      httpPost("http://localhost:3893/test/approve", requestBody)
    );
    const responses = await Promise.all(requests);

    const rateLimitedResponse = responses.find((r) => r.status === 429);

    expect(rateLimitedResponse).toBeDefined();
    expect(rateLimitedResponse!.body).toEqual({
      error: {
        code: "RATE_LIMITED",
        message: expect.any(String),
      },
    });
  });
});
