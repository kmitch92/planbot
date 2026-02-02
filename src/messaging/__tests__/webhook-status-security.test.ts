import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { createWebhookServer } from '../webhook-server.js';
import type { WebhookServer } from '../webhook-server.js';

describe('Webhook Server - Status Endpoint Security', () => {
  let server: WebhookServer;
  const port = 3850;
  const path = '/test/webhook';
  const secret = 'test-secret-key';

  beforeEach(async () => {
    server = createWebhookServer({ port, path, secret });
    await server.start();
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
  });

  it('status endpoint requires valid signature when secret is configured', async () => {
    const response = await fetch(`http://localhost:${port}${path}/status`);
    expect(response.status).toBe(401);
    const data = await response.json() as { error: { code: string; message: string } };
    expect(data.error.code).toBe('UNAUTHORIZED');
    expect(data.error.message).toBe('Missing signature');
  });

  it('status endpoint returns 401 with invalid signature', async () => {
    const response = await fetch(`http://localhost:${port}${path}/status`, {
      headers: {
        'X-Planbot-Signature': 'invalid-signature'
      }
    });
    expect(response.status).toBe(401);
    const data = await response.json() as { error: { code: string; message: string } };
    expect(data.error.code).toBe('UNAUTHORIZED');
    expect(data.error.message).toBe('Invalid signature');
  });

  it('status endpoint returns data with valid signature', async () => {
    // For GET requests, the body is empty
    const rawBody = '';
    const signature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const response = await fetch(`http://localhost:${port}${path}/status`, {
      headers: {
        'X-Planbot-Signature': signature
      }
    });
    expect(response.status).toBe(200);
    const data = await response.json() as { pendingApprovals: string[]; pendingQuestions: string[] };
    expect(data).toHaveProperty('pendingApprovals');
    expect(data).toHaveProperty('pendingQuestions');
    expect(Array.isArray(data.pendingApprovals)).toBe(true);
    expect(Array.isArray(data.pendingQuestions)).toBe(true);
  });
});

describe('Webhook Server - Status Without Secret', () => {
  let server: WebhookServer;
  const port = 3851;
  const path = '/test/webhook';

  beforeEach(async () => {
    server = createWebhookServer({ port, path }); // No secret
    await server.start();
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
  });

  it('status endpoint works without signature when no secret configured', async () => {
    const response = await fetch(`http://localhost:${port}${path}/status`);
    expect(response.status).toBe(200);
    const data = await response.json() as { pendingApprovals: string[]; pendingQuestions: string[] };
    expect(data).toHaveProperty('pendingApprovals');
    expect(data).toHaveProperty('pendingQuestions');
  });
});
