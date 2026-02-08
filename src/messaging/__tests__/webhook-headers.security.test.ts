import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createWebhookServer, type WebhookServer } from "../webhook-server.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Webhook Security - HTTP Headers", () => {
  let server: WebhookServer;
  const BASE_URL = "http://localhost:3896/test";

  async function startServer(
    config: Parameters<typeof createWebhookServer>[0]
  ): Promise<WebhookServer> {
    const srv = createWebhookServer(config);
    await srv.start();
    return srv;
  }

  beforeAll(async () => {
    server = await startServer({
      port: 3896,
      path: "/test",
      insecure: true,
    });
  });

  afterAll(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
  });

  it("includes X-Content-Type-Options: nosniff on all responses", async () => {
    const response = await fetch(`${BASE_URL}/health`);

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("includes X-Frame-Options: DENY on all responses", async () => {
    const response = await fetch(`${BASE_URL}/health`);

    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("includes Content-Security-Policy: default-src 'none' on all responses", async () => {
    const response = await fetch(`${BASE_URL}/health`);

    const csp = response.headers.get("content-security-policy");

    expect(csp).not.toBeNull();
    expect(csp).toContain("default-src 'none'");
  });

  it("includes X-Powered-By removal (no x-powered-by header)", async () => {
    const response = await fetch(`${BASE_URL}/health`);

    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  it("security headers present on error responses too", async () => {
    const response = await fetch(`${BASE_URL}/nonexistent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
