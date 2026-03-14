import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { join } from 'node:path';
import { stateManager } from '../../core/state.js';
import { fileExists, writeTextFile } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';

// =============================================================================
// Templates
// =============================================================================

export const BASIC_TEMPLATE = `# Planbot Tickets
# Run \`planbot start --help\` for CLI options

tickets:
  - id: example-001                # Unique identifier (required)
    title: Example Ticket          # Short title, max 200 chars (required)
    description: |                 # Detailed work description (required)
      Describe what needs to be done here.
      Be specific about files, expected behavior, and constraints.
    priority: 1                    # Higher = more urgent (default: 0)
    planMode: false                # Skip plan generation, execute directly (default: true)
    acceptanceCriteria:            # Completion criteria (optional)
      - Criterion 1
      - Criterion 2
    # images:                      # Attached screenshots (optional)
    #   - .planbot/assets/example-001/screenshot.png
    # dependencies: [other-id]    # IDs of tickets that must complete first
    # metadata:                    # Arbitrary key-value data
    #   estimate: 2h
`;

export const ADVANCED_TEMPLATE = `# Planbot Tickets
# Run \`planbot start --help\` for CLI options

# =============================================================================
# Hooks — run commands or prompts at lifecycle events
# =============================================================================
#
# Hook types:
#   shell  — runs a shell command    { type: shell, command: "..." }
#   prompt — sends prompt to Claude  { type: prompt, command: "..." }
#
# Hook events:
#   beforeAll      — once before processing any tickets
#   afterAll       — once after all tickets are processed
#   beforeEach     — before each ticket starts
#   afterEach      — after each ticket completes (success, failure, or skip)
#   onPlanGenerated — after plan generation, before approval
#   onApproval     — when a plan is approved
#   onComplete     — when a ticket completes successfully
#   onError        — when an error occurs during processing
#   onQuestion     — when Claude asks a question requiring input
#
# Environment variables available in shell hooks:
#   PLANBOT_EVENT          — hook event name (e.g. "beforeEach")
#   PLANBOT_TICKET_ID      — current ticket ID
#   PLANBOT_TICKET_TITLE   — current ticket title
#   PLANBOT_TICKET_STATUS  — current ticket status
#   PLANBOT_PLAN_PATH      — path to plan file (onPlanGenerated)
#   PLANBOT_PLAN           — plan content (onPlanGenerated, onApproval)
#   PLANBOT_ERROR          — error message (onError)
#   PLANBOT_QUESTION       — question text (onQuestion)
#   PLANBOT_QUESTION_ID    — question ID (onQuestion)
#
config:
  autoApprove: true
  continueOnError: true
  maxRetries: 3
#  allowShellHooks: true   # Enable shell-type hooks (security: disabled by default)
#  model: sonnet
#  fallbackModel: sonnet           # Model to use when rate limited (default: sonnet)
#  maxBudgetPerTicket: 10          # Maximum $ per ticket (default: 10)
#  maxPlanRevisions: 3             # Plan revision attempts after rejection (default: 3)
#  planMode: true                  # Generate plans before execution (default: true)
#
#  # --- Resource Limits ---
#  memoryCeilingMb: 1024             # Pause queue when RSS exceeds this (MB). 0 = disabled (default: 1024)
#  memoryCheckIntervalSec: 30        # How often to check memory in seconds (default: 30)
#
#  # --- Session Log Cleanup ---
#  sessionCleanup:
#    enabled: true                   # Auto-clean ~/.claude/projects/ between iterations (default: false)
#    maxSizeMb: 200                  # Delete oldest files when total exceeds this (default: 200)
#    maxAgeDays: 7                   # Delete files older than this many days (default: 7)
#
#  # --- Timeouts (in milliseconds) ---
#  timeouts:
#    planGeneration: 900000        # 15 minutes (default)
#    execution: 1800000            # 30 minutes (default)
#    approval: 86400000            # 24 hours (default)
#    question: 3600000             # 1 hour (default)
#
#  # --- Pacing Controls (delay between Claude executions) ---
#  # Spread token usage across time windows. Durations: "5m", "1h30m", "30s" or ms.
#  pacing:
#    delayBetweenTickets: "5m"            # Wait after each ticket before starting next
#    delayBetweenIterations: "2m"         # Wait between loop iterations
#    delayBetweenRetries: "30s"           # Wait between retry attempts
#    startAfter: "2026-03-15T06:00:00Z"  # Don't start queue until this time
#
#  # --- Rate Limit Wait-and-Retry ---
#  # When Claude hits session/usage limits, wait for reset instead of failing.
#  # Requires a fallback model attempt to also fail before waiting.
#  rateLimitRetry:
#    enabled: true                     # Opt-in: wait for rate limit reset (default: false)
#    maxWaitTime: "6h"                 # Max wait per reset cycle (default: 6h)
#    retryBuffer: "30s"               # Buffer after resetsAt before retry (default: 30s)
#    fallbackDelay: "5m"              # Delay when reset time unknown (default: 5m)
#    notifyOnWait: true                # Send messaging notification (default: true)
#
#  # --- Messaging Providers (pick one) ---
#  # Telegram:
#  messaging:
#    provider: telegram
#    botToken: \${TELEGRAM_BOT_TOKEN}
#    chatId: \${TELEGRAM_CHAT_ID}
#
#  # Slack:
#  # messaging:
#  #   provider: slack
#  #   botToken: \${SLACK_BOT_TOKEN}
#  #   appToken: \${SLACK_APP_TOKEN}
#  #   channel: "#planbot"
#
#  # Discord:
#  # messaging:
#  #   provider: discord
#  #   botToken: \${DISCORD_BOT_TOKEN}
#  #   channelId: "123456789"
#
#  # --- Webhook Server (for external integrations) ---
#  webhook:
#    enabled: true
#    port: 3847
#    path: /planbot/webhook
#    secret: \${WEBHOOK_SECRET}     # Optional HMAC secret
#    cors: false

hooks:
  beforeAll:
    - type: prompt
      command: /clear

  afterAll:
    - type: prompt
      command: /schemacheck
    - type: prompt
      command: /typetest
    - type: prompt
      command: /commit

  beforeEach:
    - type: prompt
      command: /clear

  afterEach:
    - type: prompt
      command: /schemacheck
    - type: prompt
      command: /workreport
    - type: prompt
      command: /commit

#  # --- Hook with working directory (run in specific service dir) ---
#  afterEach:
#    - type: shell
#      command: npm run lint
#      cwd: services/auth-service      # Run lint in specific service dir

# =============================================================================
# Tickets
# =============================================================================
#
# Required fields: id, title, description
# Optional fields: priority, planMode, acceptanceCriteria, dependencies, hooks,
#                  metadata, images, loop, cwd
#
# planMode (default: true):
#   true  — generate a plan, wait for approval, then execute
#   false — skip planning and approval, execute directly from description
#
tickets:

  # ---------------------------------------------------------------------------
  # Basic Ticket — standard plan-and-execute workflow
  # ---------------------------------------------------------------------------
  # The simplest ticket type. Claude generates a plan, you approve it,
  # then Claude executes the plan.
  #
  - id: auth-001
    title: Implement User Authentication
    description: |
      Implement JWT-based authentication for the API.

      Requirements:
      - Use bcrypt for password hashing
      - JWT tokens with 1-hour expiry
      - Refresh token rotation
      - Secure HTTP-only cookies
    priority: 10
    acceptanceCriteria:
      - Users can register with email/password
      - Users can login and receive tokens
      - Protected routes reject invalid tokens
      - Refresh tokens work correctly

  # ---------------------------------------------------------------------------
  # Ticket with Dependencies — waits for other tickets to complete first
  # ---------------------------------------------------------------------------
  # Use dependencies when a ticket requires work from another ticket to be
  # completed first. Planbot will automatically order execution.
  #
  - id: auth-002
    title: Add Password Reset Flow
    description: |
      Implement password reset functionality.

      Requirements:
      - Email-based reset flow
      - Time-limited reset tokens
      - Rate limiting on reset requests
    priority: 5
    dependencies:                  # Waits for auth-001 to complete first
      - auth-001
    acceptanceCriteria:
      - Users can request password reset
      - Reset emails are sent
      - Reset tokens expire after 1 hour
      - Passwords are properly updated

  # ---------------------------------------------------------------------------
  # Direct Execution Ticket — skip planning, execute immediately
  # ---------------------------------------------------------------------------
  # Set planMode: false to skip plan generation and approval. Claude executes
  # directly from the description. Use for well-defined, low-risk tasks.
  #
  - id: feature-001
    title: Example Feature
    description: |
      Replace this with your actual feature description.
    priority: 1
    planMode: false                # Executes directly without plan generation
    metadata:
      estimate: 4h
      assignee: claude

  # ---------------------------------------------------------------------------
  # Ticket with Images — attach screenshots, mockups, or diagrams
  # ---------------------------------------------------------------------------
  # Attach images to provide visual context. Use: planbot attach <id> <file>
  # Images are copied to .planbot/assets/<ticket-id>/ and referenced here.
  #
  # - id: ui-redesign
  #   title: Implement New Dashboard Design
  #   description: |
  #     Implement the new dashboard layout as shown in the attached mockup.
  #     Match colors, spacing, and typography exactly.
  #   images:
  #     - .planbot/assets/ui-redesign/dashboard-mockup.png
  #     - .planbot/assets/ui-redesign/color-palette.png
  #   acceptanceCriteria:
  #     - Layout matches mockup
  #     - Responsive on mobile and desktop
  #     - Accessibility audit passes

  # ---------------------------------------------------------------------------
  # Ticket with Custom Hooks — run commands at ticket lifecycle events
  # ---------------------------------------------------------------------------
  # Per-ticket hooks override global hooks. Useful for tickets that need
  # special setup, teardown, or notifications.
  #
  # - id: deploy-staging
  #   title: Deploy to staging
  #   description: |
  #     Deploy the application to staging environment.
  #   hooks:
  #     beforeEach:
  #       - type: shell
  #         command: npm run build
  #     onComplete:
  #       - type: shell
  #         command: curl -X POST https://slack.webhook/notify -d '{"text":"Deployed to staging"}'

  # ---------------------------------------------------------------------------
  # Loop Ticket with Shell Condition — iterate until command succeeds
  # ---------------------------------------------------------------------------
  # Loop tickets execute repeatedly until either:
  #   - The condition evaluates to true (shell exit 0, or prompt returns true)
  #   - maxIterations is reached
  #
  # Shell conditions: command exit code 0 = success (stop looping)
  #
  # Loop hooks available:
  #   onIterationStart    — runs at start of each iteration
  #   onIterationComplete — runs after each iteration completes
  #
  # - id: coverage-boost
  #   title: Achieve 90% test coverage
  #   description: |
  #     Iteratively improve test coverage until threshold is met.
  #     Each iteration: identify gaps, write tests, verify improvement.
  #   planMode: false
  #   loop:
  #     goal: "Reach 90% line coverage and 85% branch coverage"
  #     condition:
  #       type: shell
  #       command: npm run test:coverage -- --json 2>/dev/null | jq -e '.total.lines.pct >= 90'
  #       cwd: packages/core          # Run condition from specific directory (optional)
  #     maxIterations: 15
  #   hooks:
  #     onIterationComplete:
  #       - type: shell
  #         command: npm run test:coverage -- --reporter=text-summary

  # ---------------------------------------------------------------------------
  # Loop Ticket with Prompt Condition — iterate until Claude confirms done
  # ---------------------------------------------------------------------------
  # Prompt conditions ask Claude to evaluate whether the goal is met.
  # Claude analyzes the current state and returns true/false.
  #
  # Use prompt conditions when:
  #   - Success criteria are subjective or complex
  #   - No simple shell command can verify completion
  #   - Human-like judgment is needed
  #
  # - id: fix-type-errors
  #   title: Fix all TypeScript errors
  #   description: |
  #     Iteratively fix TypeScript compilation errors until clean build.
  #   planMode: false
  #   loop:
  #     goal: "Zero TypeScript compilation errors"
  #     condition:
  #       type: prompt
  #       command: "Are there zero TypeScript compilation errors in the build output?"
  #     maxIterations: 20

  # ---------------------------------------------------------------------------
  # Ticket with Working Directory — execute from a specific path (monorepo)
  # ---------------------------------------------------------------------------
  # Use cwd to run a ticket from a specific directory. Useful for monorepos
  # where different services have their own package.json and test setups.
  #
  # - id: auth-service-coverage
  #   title: Improve auth-service test coverage
  #   cwd: services/auth-service        # Execute from this directory
  #   description: |
  #     Increase test coverage in the auth service to 80%.
  #   loop:
  #     goal: Achieve 80% test coverage
  #     condition:
  #       type: shell
  #       command: npm run test:coverage -- --passWithNoTests

  # ---------------------------------------------------------------------------
  # Ticket with Pacing — per-ticket delay overrides
  # ---------------------------------------------------------------------------
  # Override global pacing for specific tickets. Useful for heavy tasks that
  # need longer cooldowns, or tickets that should start at a specific time.
  #
  # - id: heavy-refactor
  #   title: Large-scale refactor
  #   description: |
  #     Refactor the authentication module. This is resource-intensive,
  #     so we space out iterations and delay the start.
  #   planMode: false
  #   pacing:
  #     delayBetweenIterations: "10m"       # Override global (e.g. "2m") with longer cooldown
  #     startAfter: "2026-03-15T22:00:00Z"  # Run overnight when token budget resets
  #   loop:
  #     goal: "Complete auth module refactor"
  #     condition:
  #       type: shell
  #       command: npm run build && npm test
  #     maxIterations: 10
`;

// =============================================================================
// Command Implementation
// =============================================================================

export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize planbot in the current directory')
    .option('--simple', 'Use simple template without hooks or messaging config')
    .option('--force', 'Overwrite existing configuration')
    .action(async (options: { simple?: boolean; force?: boolean }) => {
      const cwd = process.cwd();
      const planbotDir = join(cwd, '.planbot');
      const ticketsPath = join(cwd, 'tickets.yaml');

      const spinner = ora('Initializing planbot...').start();

      try {
        // Check if already initialized
        const planbotExists = await fileExists(planbotDir);
        const ticketsExist = await fileExists(ticketsPath);

        if ((planbotExists || ticketsExist) && !options.force) {
          spinner.fail('Planbot is already initialized in this directory');
          console.log(chalk.yellow('\nUse --force to overwrite existing configuration'));
          process.exit(1);
        }

        // Initialize .planbot directory
        await stateManager.init(cwd);
        spinner.text = 'Created .planbot directory...';

        // Write tickets template
        const template = options.simple ? BASIC_TEMPLATE : ADVANCED_TEMPLATE;
        await writeTextFile(ticketsPath, template);
        spinner.text = 'Created tickets.yaml...';

        spinner.succeed('Planbot initialized successfully');

        console.log('\n' + chalk.bold('Next steps:'));
        console.log(chalk.dim('  1. Edit tickets.yaml to define your tickets'));
        console.log(chalk.dim('  2. Run: planbot start tickets.yaml'));
        console.log(chalk.dim('  3. Approve plans and monitor progress'));

        if (!options.simple) {
          console.log('\n' + chalk.yellow('Note: ') + 'Template includes hook configurations.');
          console.log(chalk.dim('  See comments in tickets.yaml for setup instructions.'));
        }

        console.log('\n' + chalk.dim('Created files:'));
        console.log(chalk.dim(`  - ${ticketsPath}`));
        console.log(chalk.dim(`  - ${planbotDir}/`));

        logger.debug('Planbot initialized', { cwd, simple: options.simple });
      } catch (err) {
        spinner.fail('Failed to initialize planbot');
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}`));
        logger.error('Init failed', { error: message });
        process.exit(1);
      }
    });
}
