import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import { createWebhookServer, type WebhookServer } from "../webhook-server.js";
import type { ApprovalResponse, QuestionResponse } from "../types.js";

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

function sign(body: object, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(body))
    .digest("hex");
}

async function httpRequest(
  url: string,
  options: {
    method?: string;
    body?: object;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: unknown }> {
  const { method = "GET", body, headers = {} } = options;

  const requestHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseBody = await response.json();
  return { status: response.status, body: responseBody };
}

// =============================================================================
// Server Lifecycle Tests
// =============================================================================

describe("Server Lifecycle", () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(() => {
    port = getRandomPort();
    server = createWebhookServer({
      port,
      path: "/webhook",
      insecure: true,
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  it("start() starts server and isRunning() returns true", async () => {
    expect(server.isRunning()).toBe(false);

    await server.start();

    expect(server.isRunning()).toBe(true);
  });

  it("start() throws if already running", async () => {
    await server.start();

    await expect(server.start()).rejects.toThrow("Server is already running");
  });

  it("stop() stops server gracefully and isRunning() returns false", async () => {
    await server.start();
    expect(server.isRunning()).toBe(true);

    await server.stop();

    expect(server.isRunning()).toBe(false);
  });

  it("getUrl() returns correct URL with normalized path", () => {
    const url = server.getUrl();

    expect(url).toBe(`http://localhost:${port}/webhook`);
  });
});

// =============================================================================
// Health Endpoint Tests
// =============================================================================

describe("Health Endpoint", () => {
  let server: WebhookServer;
  let baseUrl: string;

  beforeEach(async () => {
    const port = getRandomPort();
    server = createWebhookServer({
      port,
      path: "/webhook",
      insecure: true,
    });
    await server.start();
    baseUrl = server.getUrl();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("GET /health returns 200 with status ok", async () => {
    const { status, body } = await httpRequest(`${baseUrl}/health`);

    expect(status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
  });

  it("GET /health returns uptime in seconds", async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { body } = await httpRequest(`${baseUrl}/health`);

    expect(body).toHaveProperty("uptime");
    expect(typeof (body as { uptime: number }).uptime).toBe("number");
    expect((body as { uptime: number }).uptime).toBeGreaterThanOrEqual(0);
  });
});

// =============================================================================
// Approval Endpoint Tests
// =============================================================================

describe("Approval Endpoint", () => {
  let server: WebhookServer;
  let baseUrl: string;

  beforeEach(async () => {
    const port = getRandomPort();
    server = createWebhookServer({
      port,
      path: "/webhook",
      insecure: true,
    });
    await server.start();
    baseUrl = server.getUrl();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("POST /approve with valid body returns 200", async () => {
    const body = {
      planId: "plan-123",
      approved: true,
      respondedBy: "user-1",
    };

    const { status, body: responseBody } = await httpRequest(
      `${baseUrl}/approve`,
      { method: "POST", body }
    );

    expect(status).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      message: expect.stringContaining("plan-123"),
    });
  });

  it("POST /approve with invalid body returns 400 validation error", async () => {
    const body = {
      approved: true,
    };

    const { status, body: responseBody } = await httpRequest(
      `${baseUrl}/approve`,
      { method: "POST", body }
    );

    expect(status).toBe(400);
    expect(responseBody).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: expect.arrayContaining([
          expect.objectContaining({ field: "planId" }),
        ]),
      },
    });
  });

  it("POST /approve invokes onApproval callback", async () => {
    const onApproval = vi.fn();
    server.setCallbacks({ onApproval });

    const body = {
      planId: "plan-callback-test",
      approved: false,
      rejectionReason: "Needs revision",
      respondedBy: "reviewer-1",
    };

    await httpRequest(`${baseUrl}/approve`, { method: "POST", body });

    expect(onApproval).toHaveBeenCalledOnce();
    const [response] = onApproval.mock.calls[0] as [ApprovalResponse];
    expect(response.planId).toBe("plan-callback-test");
    expect(response.approved).toBe(false);
    expect(response.rejectionReason).toBe("Needs revision");
    expect(response.respondedBy).toBe("reviewer-1");
    expect(response.respondedAt).toBeInstanceOf(Date);
  });

  it("POST /approve without signature returns 401 when secret configured", async () => {
    const port = getRandomPort();
    const secureServer = createWebhookServer({
      port,
      path: "/webhook",
      secret: "testsecret",
    });
    await secureServer.start();

    const body = { planId: "plan-123", approved: true };

    const { status, body: responseBody } = await httpRequest(
      `http://localhost:${port}/webhook/approve`,
      { method: "POST", body }
    );

    await secureServer.stop();

    expect(status).toBe(401);
    expect(responseBody).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing signature",
      },
    });
  });
});

// =============================================================================
// Question Response Endpoint Tests
// =============================================================================

describe("Question Response Endpoint", () => {
  let server: WebhookServer;
  let baseUrl: string;

  beforeEach(async () => {
    const port = getRandomPort();
    server = createWebhookServer({
      port,
      path: "/webhook",
      insecure: true,
    });
    await server.start();
    baseUrl = server.getUrl();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("POST /respond with valid body returns 200", async () => {
    const body = {
      questionId: "question-456",
      answer: "The answer is 42",
      respondedBy: "user-1",
    };

    const { status, body: responseBody } = await httpRequest(
      `${baseUrl}/respond`,
      { method: "POST", body }
    );

    expect(status).toBe(200);
    expect(responseBody).toMatchObject({
      success: true,
      message: expect.stringContaining("question-456"),
    });
  });

  it("POST /respond with invalid body returns 400", async () => {
    const body = {
      questionId: "question-123",
    };

    const { status, body: responseBody } = await httpRequest(
      `${baseUrl}/respond`,
      { method: "POST", body }
    );

    expect(status).toBe(400);
    expect(responseBody).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: expect.arrayContaining([
          expect.objectContaining({ field: "answer" }),
        ]),
      },
    });
  });

  it("POST /respond invokes onQuestionResponse callback", async () => {
    const onQuestionResponse = vi.fn();
    server.setCallbacks({ onQuestionResponse });

    const body = {
      questionId: "question-callback-test",
      answer: "My detailed answer",
      respondedBy: "answerer-1",
    };

    await httpRequest(`${baseUrl}/respond`, { method: "POST", body });

    expect(onQuestionResponse).toHaveBeenCalledOnce();
    const [response] = onQuestionResponse.mock.calls[0] as [QuestionResponse];
    expect(response.questionId).toBe("question-callback-test");
    expect(response.answer).toBe("My detailed answer");
    expect(response.respondedBy).toBe("answerer-1");
    expect(response.respondedAt).toBeInstanceOf(Date);
  });
});

// =============================================================================
// HMAC Signature Verification Tests
// =============================================================================

describe("HMAC Signature Verification", () => {
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

  it("valid signature passes verification", async () => {
    const body = {
      planId: "plan-signed",
      approved: true,
    };
    const signature = sign(body, secret);

    const { status, body: responseBody } = await httpRequest(
      `${baseUrl}/approve`,
      {
        method: "POST",
        body,
        headers: { "X-Planbot-Signature": signature },
      }
    );

    expect(status).toBe(200);
    expect(responseBody).toMatchObject({ success: true });
  });

  it("invalid signature returns 401", async () => {
    const body = {
      planId: "plan-bad-sig",
      approved: true,
    };
    const invalidSignature = "invalidhexsignature123456789abcdef0123456789abcdef0123456789abcdef";

    const { status, body: responseBody } = await httpRequest(
      `${baseUrl}/approve`,
      {
        method: "POST",
        body,
        headers: { "X-Planbot-Signature": invalidSignature },
      }
    );

    expect(status).toBe(401);
    expect(responseBody).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid signature",
      },
    });
  });

  it("missing signature header returns 401", async () => {
    const body = {
      planId: "plan-no-sig",
      approved: true,
    };

    const { status, body: responseBody } = await httpRequest(
      `${baseUrl}/approve`,
      { method: "POST", body }
    );

    expect(status).toBe(401);
    expect(responseBody).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
        message: "Missing signature",
      },
    });
  });

  it("signature verification uses timing-safe comparison", async () => {
    const body = { planId: "plan-timing", approved: true };
    const correctSignature = sign(body, secret);

    const wrongSignatures = [
      correctSignature.slice(0, -1) + "0",
      "0" + correctSignature.slice(1),
      correctSignature.replace(/a/g, "b"),
    ];

    const timings: number[] = [];

    for (const wrongSig of wrongSignatures) {
      const start = performance.now();
      await httpRequest(`${baseUrl}/approve`, {
        method: "POST",
        body,
        headers: { "X-Planbot-Signature": wrongSig },
      });
      timings.push(performance.now() - start);
    }

    const maxDiff = Math.max(...timings) - Math.min(...timings);
    expect(maxDiff).toBeLessThan(50);
  });
});

// =============================================================================
// Edge Cases and Error Handling Tests
// =============================================================================

describe("Edge Cases and Error Handling", () => {
  let server: WebhookServer;
  let baseUrl: string;

  beforeEach(async () => {
    const port = getRandomPort();
    server = createWebhookServer({
      port,
      path: "/webhook",
      insecure: true,
    });
    await server.start();
    baseUrl = server.getUrl();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("unknown endpoint returns 404", async () => {
    const { status, body } = await httpRequest(`${baseUrl}/nonexistent`, {
      method: "POST",
      body: {},
    });

    expect(status).toBe(404);
    expect(body).toMatchObject({
      error: {
        code: "NOT_FOUND",
        message: expect.stringContaining("not found"),
      },
    });
  });

  it("callback errors are caught and do not crash server", async () => {
    const errorCallback = vi.fn(() => {
      throw new Error("Callback exploded");
    });
    server.setCallbacks({ onApproval: errorCallback });

    const body = {
      planId: "plan-error-callback",
      approved: true,
    };

    const { status } = await httpRequest(`${baseUrl}/approve`, {
      method: "POST",
      body,
    });

    expect(status).toBe(200);
    expect(errorCallback).toHaveBeenCalledOnce();
    expect(server.isRunning()).toBe(true);
  });

  it("stop() is idempotent when server not running", async () => {
    await server.stop();

    await expect(server.stop()).resolves.not.toThrow();
  });
});
