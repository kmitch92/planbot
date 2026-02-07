/**
 * Webhook server for receiving plan approval and question responses via HTTP.
 * Provides endpoints for external systems to respond to planbot requests.
 */

import type { Server } from "http";
import * as crypto from "crypto";
import express from "express";
import type {
  Application,
  Request,
  Response,
  NextFunction,
} from "express";
import { z } from "zod";
import type { ApprovalResponse, QuestionResponse } from "./types.js";
import { logger } from "../utils/logger.js";

/**
 * Configuration for the webhook server.
 */
export interface WebhookServerConfig {
  /** Port to listen on */
  port: number;
  /** Base path for webhook endpoints */
  path: string;
  /** Secret for HMAC signature verification (optional) */
  secret?: string;
  /** Enable CORS headers (default: false) */
  cors?: boolean;
  /** Whitelist of allowed CORS origins */
  corsOrigins?: string[];
  /** Allow starting without a secret (insecure mode) */
  insecure?: boolean;
}

/**
 * Callbacks invoked when responses are received.
 */
export interface WebhookCallbacks {
  /** Called when an approval response is received */
  onApproval?: (response: ApprovalResponse) => void;
  /** Called when a question response is received */
  onQuestionResponse?: (response: QuestionResponse) => void;
}

/**
 * Webhook server interface for receiving HTTP responses.
 */
export interface WebhookServer {
  /** Start the HTTP server */
  start(): Promise<void>;
  /** Stop the HTTP server gracefully */
  stop(): Promise<void>;
  /** Check if server is currently running */
  isRunning(): boolean;
  /** Set response callbacks */
  setCallbacks(callbacks: WebhookCallbacks): void;
  /** Get the full URL for the webhook endpoints */
  getUrl(): string;
}

// Request body schemas
const ApprovalRequestSchema = z.object({
  planId: z.string().min(1, "planId is required"),
  approved: z.boolean(),
  rejectionReason: z.string().optional(),
  respondedBy: z.string().optional(),
});

const QuestionRequestSchema = z.object({
  questionId: z.string().min(1, "questionId is required"),
  answer: z.string().min(1, "answer is required"),
  respondedBy: z.string().optional(),
});

// Track pending requests for status endpoint
interface PendingState {
  pendingApprovals: Set<string>;
  pendingQuestions: Set<string>;
}

/**
 * Creates a webhook server for receiving HTTP responses.
 *
 * @param config - Server configuration
 * @returns WebhookServer instance
 *
 * @example
 * ```typescript
 * const server = createWebhookServer({
 *   port: 3847,
 *   path: '/planbot/webhook',
 *   secret: 'mysecret'
 * });
 *
 * server.setCallbacks({
 *   onApproval: (response) => console.log('Approval:', response),
 *   onQuestionResponse: (response) => console.log('Answer:', response)
 * });
 *
 * await server.start();
 * // Server running at http://localhost:3847/planbot/webhook
 * ```
 */
export function createWebhookServer(config: WebhookServerConfig): WebhookServer {
  const { port, path, secret, cors = false, corsOrigins, insecure } = config;

  let app: Application;
  let server: Server | null = null;
  let callbacks: WebhookCallbacks = {};
  const startTime = Date.now();

  // Track pending requests
  const pending: PendingState = {
    pendingApprovals: new Set(),
    pendingQuestions: new Set(),
  };

  /**
   * Normalize path to ensure it starts with / and doesn't end with /
   */
  function normalizePath(p: string): string {
    let normalized = p.startsWith("/") ? p : `/${p}`;
    normalized = normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
    return normalized;
  }

  const basePath = normalizePath(path);

  /**
   * Verify HMAC signature if secret is configured
   */
  function verifySignature(req: Request, res: Response, next: NextFunction): void {
    if (!secret) {
      next();
      return;
    }

    const signature = req.headers["x-planbot-signature"];
    if (!signature || typeof signature !== "string") {
      logger.warn("Webhook request missing signature header");
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing signature" } });
      return;
    }

    // Get raw body for signature verification
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody || Buffer.from('');

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");

    // Use timing-safe comparison to prevent timing attacks
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);

    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      logger.warn("Webhook request has invalid signature");
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid signature" } });
      return;
    }

    next();
  }

  /**
   * Request logging middleware
   */
  function requestLogger(req: Request, _res: Response, next: NextFunction): void {
    logger.debug(`Webhook ${req.method} ${req.path}`, {
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    next();
  }

  /**
   * CORS middleware
   */
  function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (cors) {
      const origin = req.headers.origin;
      if (corsOrigins && corsOrigins.length > 0) {
        // Whitelist mode -- only allow listed origins
        if (origin && corsOrigins.includes(origin)) {
          res.header("Access-Control-Allow-Origin", origin);
          res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          res.header("Access-Control-Allow-Headers", "Content-Type, X-Planbot-Signature");
        }
        // If origin not in whitelist, don't set CORS headers (browser will block)
      } else {
        // CORS enabled but no whitelist -- block by not setting any headers
        // (safer than setting *)
      }
    }
    next();
  }

  /**
   * Setup express app and routes
   */
  function setupApp(): Application {
    const expressApp = express();

    // Middleware
    // Capture raw body for HMAC verification before JSON parsing
    expressApp.use(express.json({
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      }
    }));
    expressApp.use(corsMiddleware);
    expressApp.use(requestLogger);

    // Handle OPTIONS preflight
    expressApp.options(`${basePath}/*`, (_req, res) => {
      res.sendStatus(204);
    });

    // Health check endpoint (no auth required)
    expressApp.get(`${basePath}/health`, (_req, res) => {
      res.json({
        status: "ok",
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
    });

    // Status endpoint (auth required if secret configured)
    expressApp.get(`${basePath}/status`, verifySignature, (_req, res) => {
      res.json({
        pendingApprovals: Array.from(pending.pendingApprovals),
        pendingQuestions: Array.from(pending.pendingQuestions),
      });
    });

    // Approval endpoint
    expressApp.post(`${basePath}/approve`, verifySignature, (req, res) => {
      const parseResult = ApprovalRequestSchema.safeParse(req.body);

      if (!parseResult.success) {
        const errors = parseResult.error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }));
        logger.warn("Invalid approval request", { errors });
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            details: errors,
          },
        });
        return;
      }

      const { planId, approved, rejectionReason, respondedBy } = parseResult.data;

      const response: ApprovalResponse = {
        planId,
        approved,
        rejectionReason,
        respondedBy,
        respondedAt: new Date(),
      };

      logger.info(`Received approval response for plan ${planId}`, {
        approved,
        respondedBy,
      });

      // Remove from pending
      pending.pendingApprovals.delete(planId);

      // Invoke callback
      if (callbacks.onApproval) {
        try {
          callbacks.onApproval(response);
        } catch (err) {
          logger.error("Error in approval callback", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.json({
        success: true,
        message: `Approval ${approved ? "accepted" : "rejected"} for plan ${planId}`,
      });
    });

    // Question response endpoint
    expressApp.post(`${basePath}/respond`, verifySignature, (req, res) => {
      const parseResult = QuestionRequestSchema.safeParse(req.body);

      if (!parseResult.success) {
        const errors = parseResult.error.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }));
        logger.warn("Invalid question response", { errors });
        res.status(400).json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            details: errors,
          },
        });
        return;
      }

      const { questionId, answer, respondedBy } = parseResult.data;

      const response: QuestionResponse = {
        questionId,
        answer,
        respondedBy,
        respondedAt: new Date(),
      };

      logger.info(`Received response for question ${questionId}`, {
        respondedBy,
      });

      // Remove from pending
      pending.pendingQuestions.delete(questionId);

      // Invoke callback
      if (callbacks.onQuestionResponse) {
        try {
          callbacks.onQuestionResponse(response);
        } catch (err) {
          logger.error("Error in question response callback", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      res.json({
        success: true,
        message: `Response received for question ${questionId}`,
      });
    });

    // 404 handler
    expressApp.use((req, res) => {
      res.status(404).json({
        error: {
          code: "NOT_FOUND",
          message: `Endpoint ${req.method} ${req.path} not found`,
        },
      });
    });

    // Error handler
    expressApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      logger.error("Webhook server error", {
        error: err.message,
      });
      res.status(500).json({
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred",
        },
      });
    });

    return expressApp;
  }

  return {
    async start(): Promise<void> {
      if (server) {
        throw new Error("Server is already running");
      }

      // Require secret unless explicitly running in insecure mode
      if (!secret && !insecure) {
        throw new Error(
          "Webhook server requires a secret for HMAC authentication. " +
          "Set 'secret' in webhook config or set 'insecure: true' to disable (not recommended)."
        );
      }

      if (!secret && insecure) {
        logger.warn("Webhook server starting in insecure mode without HMAC authentication");
      }

      app = setupApp();

      return new Promise((resolve, reject) => {
        try {
          server = app.listen(port, () => {
            const url = `http://localhost:${port}${basePath}`;
            logger.info(`Webhook server started at ${url}`);
            resolve();
          });

          server.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "EADDRINUSE") {
              const error = new Error(`Port ${port} is already in use`);
              logger.error("Failed to start webhook server", { port, error: error.message });
              reject(error);
            } else {
              logger.error("Webhook server error", { error: err.message });
              reject(err);
            }
          });
        } catch (err) {
          reject(err);
        }
      });
    },

    async stop(): Promise<void> {
      if (!server) {
        return;
      }

      return new Promise((resolve, reject) => {
        server!.close((err) => {
          if (err) {
            logger.error("Error stopping webhook server", { error: err.message });
            reject(err);
          } else {
            logger.info("Webhook server stopped");
            server = null;
            resolve();
          }
        });
      });
    },

    isRunning(): boolean {
      return server !== null;
    },

    setCallbacks(newCallbacks: WebhookCallbacks): void {
      callbacks = { ...callbacks, ...newCallbacks };
    },

    getUrl(): string {
      return `http://localhost:${port}${basePath}`;
    },
  };
}

/**
 * Utility to add a pending approval (for status tracking)
 */
export function addPendingApproval(planId: string): void {
  // This would need to be exposed through the server instance in a real implementation
  logger.debug(`Tracking pending approval: ${planId}`);
}

/**
 * Utility to add a pending question (for status tracking)
 */
export function addPendingQuestion(questionId: string): void {
  // This would need to be exposed through the server instance in a real implementation
  logger.debug(`Tracking pending question: ${questionId}`);
}
