import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ComponentType,
  TextChannel,
  Message,
  ButtonInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
  Interaction,
} from "discord.js";
import { logger } from "../utils/logger.js";
import type {
  MessagingProvider,
  PlanMessage,
  QuestionMessage,
  StatusMessage,
  ApprovalResponse,
  QuestionResponse,
} from "./types.js";

/**
 * Configuration for the Discord messaging provider.
 */
export interface DiscordProviderConfig {
  /** Discord bot token for authentication */
  botToken: string;
  /** Channel snowflake ID where messages will be sent */
  channelId: string;
}

/**
 * Status colors for Discord embeds.
 */
const STATUS_COLORS = {
  started: 0x3498db, // Blue
  completed: 0x2ecc71, // Green
  failed: 0xe74c3c, // Red
  skipped: 0xf1c40f, // Yellow
} as const;

/**
 * Status icons for embed titles.
 */
const STATUS_ICONS = {
  started: "🔄",
  completed: "✅",
  failed: "❌",
  skipped: "⏭️",
} as const;

/**
 * Discord embed description character limit.
 */
const EMBED_DESCRIPTION_LIMIT = 4096;

/**
 * Maximum options for button-based selection (Discord allows up to 5 buttons per row).
 */
const MAX_BUTTON_OPTIONS = 5;

/**
 * Discord-based messaging provider.
 * Uses embeds, buttons, and modals for rich interactive messaging.
 */
class DiscordProvider implements MessagingProvider {
  readonly name = "discord";

  private client: Client | null = null;
  private channel: TextChannel | null = null;
  private readonly botToken: string;
  private readonly channelId: string;

  /** Track sent messages for updates */
  private messageReferences: Map<string, Message> = new Map();

  /** Track pending questions for response handling */
  private pendingQuestions: Map<string, QuestionMessage> = new Map();

  // Callbacks set by multiplexer
  onApproval?: (response: ApprovalResponse) => void;
  onQuestionResponse?: (response: QuestionResponse) => void;

  constructor(config: DiscordProviderConfig) {
    this.botToken = config.botToken;
    this.channelId = config.channelId;
  }

  /**
   * Connect to Discord and set up event handlers.
   */
  async connect(): Promise<void> {
    if (this.client?.isReady()) {
      logger.debug("Discord provider already connected");
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    // Set up interaction handler before login
    this.client.on("interactionCreate", (interaction) => {
      this.handleInteraction(interaction).catch((error) => {
        logger.error("Error handling Discord interaction", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });

    // Handle errors
    this.client.on("error", (error) => {
      logger.error("Discord client error", { error: error.message });
    });

    // Handle warnings
    this.client.on("warn", (message) => {
      logger.warn("Discord client warning", { message });
    });

    // Wait for ready event
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Discord connection timeout"));
      }, 30000);

      this.client!.once("ready", async () => {
        clearTimeout(timeout);
        logger.info("Discord client ready", { user: this.client!.user?.tag });

        // Fetch and validate channel
        try {
          const channel = await this.client!.channels.fetch(this.channelId);
          if (!channel || !(channel instanceof TextChannel)) {
            reject(new Error(`Channel ${this.channelId} not found or not a text channel`));
            return;
          }
          this.channel = channel;
          logger.debug("Discord channel fetched", { channelId: this.channelId });
          resolve();
        } catch (error) {
          reject(error);
        }
      });

      this.client!.login(this.botToken).catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Disconnect from Discord.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.channel = null;
      this.messageReferences.clear();
      this.pendingQuestions.clear();
      logger.debug("Discord provider disconnected");
    }
  }

  /**
   * Check if the Discord client is connected and ready.
   */
  isConnected(): boolean {
    return this.client?.isReady() ?? false;
  }

  /**
   * Send a plan for approval with interactive buttons.
   */
  async sendPlanForApproval(plan: PlanMessage): Promise<void> {
    if (!this.channel) {
      throw new Error("Discord provider not connected");
    }

    // Build embed
    const embed = new EmbedBuilder()
      .setTitle(`📋 Plan Review: ${this.truncate(plan.ticketTitle, 200)}`)
      .setDescription(this.truncate(plan.plan, EMBED_DESCRIPTION_LIMIT))
      .addFields({ name: "Ticket ID", value: plan.ticketId, inline: true })
      .setColor(0x5865f2) // Discord blurple
      .setTimestamp()
      .setFooter({ text: `Plan ID: ${plan.planId}` });

    // Build approval buttons
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve_${plan.planId}`)
        .setLabel("Approve")
        .setEmoji("✅")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`reject_${plan.planId}`)
        .setLabel("Reject")
        .setEmoji("❌")
        .setStyle(ButtonStyle.Danger)
    );

    try {
      const message = await this.channel.send({
        embeds: [embed],
        components: [buttons],
      });

      this.messageReferences.set(plan.planId, message);
      logger.debug("Plan sent for approval", { planId: plan.planId });
    } catch (error) {
      logger.error("Failed to send plan for approval", {
        error: error instanceof Error ? error.message : String(error),
        planId: plan.planId,
      });
      throw error;
    }
  }

  /**
   * Send a question with appropriate input method based on options.
   */
  async sendQuestion(question: QuestionMessage): Promise<void> {
    if (!this.channel) {
      throw new Error("Discord provider not connected");
    }

    // Build embed
    const embed = new EmbedBuilder()
      .setTitle(`❓ Question: ${this.truncate(question.ticketTitle, 200)}`)
      .setDescription(question.question)
      .addFields({ name: "Ticket ID", value: question.ticketId, inline: true })
      .setColor(0x5865f2)
      .setTimestamp()
      .setFooter({ text: `Question ID: ${question.questionId}` });

    // Store question for response handling
    this.pendingQuestions.set(question.questionId, question);

    try {
      let message: Message;

      if (question.options && question.options.length > 0) {
        if (question.options.length <= MAX_BUTTON_OPTIONS) {
          // Use buttons for <= 5 options
          message = await this.sendQuestionWithButtons(embed, question);
        } else {
          // Use select menu for > 5 options
          message = await this.sendQuestionWithSelect(embed, question);
        }
      } else {
        // Free text - use button to open modal
        message = await this.sendQuestionWithModal(embed, question);
      }

      this.messageReferences.set(question.questionId, message);
      logger.debug("Question sent", { questionId: question.questionId });
    } catch (error) {
      this.pendingQuestions.delete(question.questionId);
      logger.error("Failed to send question", {
        error: error instanceof Error ? error.message : String(error),
        questionId: question.questionId,
      });
      throw error;
    }
  }

  /**
   * Send a status update embed.
   */
  async sendStatus(status: StatusMessage): Promise<void> {
    if (!this.channel) {
      throw new Error("Discord provider not connected");
    }

    const icon = STATUS_ICONS[status.status];
    const color = STATUS_COLORS[status.status];

    const embed = new EmbedBuilder()
      .setTitle(`${icon} ${status.status.charAt(0).toUpperCase() + status.status.slice(1)}: ${this.truncate(status.ticketTitle, 200)}`)
      .setColor(color)
      .addFields({ name: "Ticket ID", value: status.ticketId, inline: true })
      .setTimestamp();

    if (status.message) {
      embed.setDescription(status.message);
    }

    if (status.status === "failed" && status.error) {
      embed.addFields({ name: "Error", value: this.truncate(status.error, 1024) });
    }

    try {
      await this.channel.send({ embeds: [embed] });
      logger.debug("Status sent", { ticketId: status.ticketId, status: status.status });
    } catch (error) {
      logger.error("Failed to send status", {
        error: error instanceof Error ? error.message : String(error),
        ticketId: status.ticketId,
      });
      throw error;
    }
  }

  /**
   * Send question with button options.
   */
  private async sendQuestionWithButtons(
    embed: EmbedBuilder,
    question: QuestionMessage
  ): Promise<Message> {
    const buttons = new ActionRowBuilder<ButtonBuilder>();

    for (const option of question.options!) {
      buttons.addComponents(
        new ButtonBuilder()
          .setCustomId(`answer_${question.questionId}_${option.value}`)
          .setLabel(this.truncate(option.label, 80))
          .setStyle(ButtonStyle.Primary)
      );
    }

    return this.channel!.send({
      embeds: [embed],
      components: [buttons],
    });
  }

  /**
   * Send question with select menu for many options.
   */
  private async sendQuestionWithSelect(
    embed: EmbedBuilder,
    question: QuestionMessage
  ): Promise<Message> {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`select_${question.questionId}`)
      .setPlaceholder("Select an option...")
      .addOptions(
        question.options!.slice(0, 25).map((option) => ({
          label: this.truncate(option.label, 100),
          value: option.value,
        }))
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    return this.channel!.send({
      embeds: [embed],
      components: [row],
    });
  }

  /**
   * Send question with button to open modal for free text input.
   */
  private async sendQuestionWithModal(
    embed: EmbedBuilder,
    question: QuestionMessage
  ): Promise<Message> {
    const button = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`modal_${question.questionId}`)
        .setLabel("Answer Question")
        .setStyle(ButtonStyle.Primary)
    );

    return this.channel!.send({
      embeds: [embed],
      components: [button],
    });
  }

  /**
   * Handle all Discord interactions (buttons, select menus, modals).
   */
  private async handleInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isButton()) {
      await this.handleButtonInteraction(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await this.handleSelectInteraction(interaction);
    } else if (interaction.isModalSubmit()) {
      await this.handleModalSubmit(interaction);
    }
  }

  /**
   * Handle button interactions.
   */
  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith("approve_")) {
      const planId = customId.replace("approve_", "");
      await this.handleApprovalAction(interaction, planId, true);
    } else if (customId.startsWith("reject_")) {
      const planId = customId.replace("reject_", "");
      await this.showRejectionModal(interaction, planId);
    } else if (customId.startsWith("answer_")) {
      const parts = customId.split("_");
      const questionId = parts[1];
      const value = parts.slice(2).join("_");
      await this.handleQuestionAnswer(interaction, questionId, value);
    } else if (customId.startsWith("modal_")) {
      const questionId = customId.replace("modal_", "");
      await this.showAnswerModal(interaction, questionId);
    }
  }

  /**
   * Handle select menu interactions.
   */
  private async handleSelectInteraction(
    interaction: StringSelectMenuInteraction
  ): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith("select_")) {
      const questionId = customId.replace("select_", "");
      const value = interaction.values[0];
      await this.handleQuestionAnswer(interaction, questionId, value);
    }
  }

  /**
   * Handle modal submit interactions.
   */
  private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith("rejection_modal_")) {
      const planId = customId.replace("rejection_modal_", "");
      const reason = interaction.fields.getTextInputValue("rejection_reason");
      await this.handleApprovalAction(interaction, planId, false, reason);
    } else if (customId.startsWith("answer_modal_")) {
      const questionId = customId.replace("answer_modal_", "");
      const answer = interaction.fields.getTextInputValue("answer_input");
      await this.handleModalQuestionAnswer(interaction, questionId, answer);
    }
  }

  /**
   * Show rejection reason modal.
   */
  private async showRejectionModal(
    interaction: ButtonInteraction,
    planId: string
  ): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId(`rejection_modal_${planId}`)
      .setTitle("Rejection Reason");

    const reasonInput = new TextInputBuilder()
      .setCustomId("rejection_reason")
      .setLabel("Why are you rejecting this plan?")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder("Optional: Provide feedback for improving the plan...");

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  /**
   * Show answer input modal for free text questions.
   */
  private async showAnswerModal(
    interaction: ButtonInteraction,
    questionId: string
  ): Promise<void> {
    const question = this.pendingQuestions.get(questionId);
    const questionText = question?.question ?? "Please provide your answer";

    const modal = new ModalBuilder()
      .setCustomId(`answer_modal_${questionId}`)
      .setTitle("Your Answer");

    const answerInput = new TextInputBuilder()
      .setCustomId("answer_input")
      .setLabel(this.truncate(questionText, 45))
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(answerInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  /**
   * Handle approval/rejection action.
   */
  private async handleApprovalAction(
    interaction: ButtonInteraction | ModalSubmitInteraction,
    planId: string,
    approved: boolean,
    rejectionReason?: string
  ): Promise<void> {
    const user = interaction.user;

    // Update original message
    const originalMessage = this.messageReferences.get(planId);
    if (originalMessage) {
      const embed = EmbedBuilder.from(originalMessage.embeds[0]);
      embed.setColor(approved ? 0x2ecc71 : 0xe74c3c);
      embed.addFields({
        name: approved ? "Approved" : "Rejected",
        value: `By ${user.tag}${rejectionReason ? `\nReason: ${rejectionReason}` : ""}`,
      });

      await originalMessage.edit({
        embeds: [embed],
        components: [], // Remove buttons
      });
    }

    // Acknowledge the interaction
    await interaction.reply({
      content: approved ? "✅ Plan approved!" : `❌ Plan rejected${rejectionReason ? `: ${rejectionReason}` : ""}`,
      ephemeral: true,
    });

    // Emit approval callback
    if (this.onApproval) {
      this.onApproval({
        planId,
        approved,
        rejectionReason: rejectionReason || undefined,
        respondedBy: user.tag,
        respondedAt: new Date(),
      });
    }

    // Cleanup
    this.messageReferences.delete(planId);
    logger.info("Plan approval processed", { planId, approved, user: user.tag });
  }

  /**
   * Handle question answer from button or select.
   */
  private async handleQuestionAnswer(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    questionId: string,
    answer: string
  ): Promise<void> {
    const user = interaction.user;
    const question = this.pendingQuestions.get(questionId);

    // Find label for value if options exist
    let displayAnswer = answer;
    if (question?.options) {
      const option = question.options.find((o) => o.value === answer);
      if (option) {
        displayAnswer = option.label;
      }
    }

    // Update original message
    const originalMessage = this.messageReferences.get(questionId);
    if (originalMessage) {
      const embed = EmbedBuilder.from(originalMessage.embeds[0]);
      embed.setColor(0x2ecc71);
      embed.addFields({ name: "Answer", value: `${displayAnswer} (by ${user.tag})` });

      await originalMessage.edit({
        embeds: [embed],
        components: [], // Remove interactive elements
      });
    }

    // Acknowledge the interaction
    await interaction.reply({
      content: `✅ Answer recorded: ${displayAnswer}`,
      ephemeral: true,
    });

    // Emit response callback
    if (this.onQuestionResponse) {
      this.onQuestionResponse({
        questionId,
        answer,
        respondedBy: user.tag,
        respondedAt: new Date(),
      });
    }

    // Cleanup
    this.pendingQuestions.delete(questionId);
    this.messageReferences.delete(questionId);
    logger.info("Question answered", { questionId, answer, user: user.tag });
  }

  /**
   * Handle question answer from modal submission.
   */
  private async handleModalQuestionAnswer(
    interaction: ModalSubmitInteraction,
    questionId: string,
    answer: string
  ): Promise<void> {
    const user = interaction.user;

    // Update original message
    const originalMessage = this.messageReferences.get(questionId);
    if (originalMessage) {
      const embed = EmbedBuilder.from(originalMessage.embeds[0]);
      embed.setColor(0x2ecc71);
      embed.addFields({
        name: "Answer",
        value: this.truncate(`${answer} (by ${user.tag})`, 1024),
      });

      await originalMessage.edit({
        embeds: [embed],
        components: [], // Remove button
      });
    }

    // Acknowledge the interaction
    await interaction.reply({
      content: "✅ Answer recorded!",
      ephemeral: true,
    });

    // Emit response callback
    if (this.onQuestionResponse) {
      this.onQuestionResponse({
        questionId,
        answer,
        respondedBy: user.tag,
        respondedAt: new Date(),
      });
    }

    // Cleanup
    this.pendingQuestions.delete(questionId);
    this.messageReferences.delete(questionId);
    logger.info("Question answered via modal", { questionId, user: user.tag });
  }

  /**
   * Truncate text to a maximum length.
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + "...";
  }
}

/**
 * Create a Discord messaging provider.
 * @param config - Configuration for the Discord provider
 * @returns A MessagingProvider for Discord interaction
 */
export function createDiscordProvider(
  config: DiscordProviderConfig
): MessagingProvider {
  return new DiscordProvider(config);
}
