/**
 * Messaging module for multi-provider communication.
 * Handles plan approvals, questions, and status updates across Slack, Discord, Telegram, etc.
 */

export type {
  PlanMessage,
  QuestionMessage,
  ApprovalResponse,
  QuestionResponse,
  StatusMessage,
  MessagingProvider,
} from "./types.js";

export {
  createMultiplexer,
  TimeoutError,
  type Multiplexer,
  type MultiplexerOptions,
  type MultiplexerEvents,
} from "./multiplexer.js";

export {
  createTerminalProvider,
  type TerminalProviderOptions,
} from "./terminal.js";

export {
  createWebhookServer,
  type WebhookServer,
  type WebhookServerConfig,
  type WebhookCallbacks,
} from "./webhook-server.js";

export {
  createTelegramProvider,
  type TelegramProviderConfig,
} from "./telegram.js";

export {
  createDiscordProvider,
  type DiscordProviderConfig,
} from "./discord.js";
