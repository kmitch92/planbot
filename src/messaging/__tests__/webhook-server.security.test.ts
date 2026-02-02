import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import { createWebhookServer, type WebhookServer } from "../webhook-server.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

async function httpRequest(
  url: string,
  options: {
    method?: string;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: unknown }> {
  const { method = "GET", rawBody, headers = {} } = options;

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: rawBody,
  });

  const responseBody = await response.json();
  return { status: response.status, body: responseBody };
}

describe("Webhook Server Security - HMAC Signature Verification", () => {
  const secret = "supersecretkey";
  let server: WebhookServer;
  let baseUrl: string;

  beforeEach(async () => {
    const port = getRandomPort();
    server = createWebhookServer({
      port,
      path: "/webhook",
      secret,
    });
    await server.start();
    baseUrl = server.getUrl();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("verifies signature against raw body, not re-stringified JSON", async () => {
    // Craft a payload where key order matters
    const rawBody = '{"approved":true,"planId":"plan-123"}';
    
    // Sign the raw body
    const signature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const { status, body } = await httpRequest(`${baseUrl}/approve`, {
      method: "POST",
      rawBody,
      headers: { "X-Planbot-Signature": signature },
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true });
  });

  it("rejects signature computed from different JSON formatting", async () => {
    const payload = { planId: "plan-123", approved: true };
    
    // Sign with different whitespace (this would be accepted if we don't use raw body)
    const differentFormatting = '{\n  "planId": "plan-123",\n  "approved": true\n}';
    const wrongSignature = crypto
      .createHmac("sha256", secret)
      .update(differentFormatting)
      .digest("hex");

    const rawBody = JSON.stringify(payload); // Compact format

    const { status, body } = await httpRequest(`${baseUrl}/approve`, {
      method: "POST",
      rawBody,
      headers: { "X-Planbot-Signature": wrongSignature },
    });

    expect(status).toBe(401);
    expect(body).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid signature",
      },
    });
  });

  it("accepts signature when raw body matches exactly", async () => {
    const rawBody = '{"planId":"plan-exact","approved":false,"rejectionReason":"test"}';
    
    const signature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    const { status } = await httpRequest(`${baseUrl}/approve`, {
      method: "POST",
      rawBody,
      headers: { "X-Planbot-Signature": signature },
    });

    expect(status).toBe(200);
  });
});
