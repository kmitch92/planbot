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

const BASIC_TEMPLATE = `# Planbot Tickets Configuration
# See https://github.com/your-repo/planbot for documentation

config:
  model: sonnet
  maxBudgetPerTicket: 10
  maxRetries: 3
  continueOnError: false
  autoApprove: false

tickets:
  - id: example-001
    title: Example Ticket
    description: |
      Describe what needs to be done here.

      Be specific and include:
      - What files to modify
      - Expected behavior
      - Any constraints
    priority: 1
    acceptanceCriteria:
      - Criterion 1
      - Criterion 2
`;

const ADVANCED_TEMPLATE = `# Planbot Tickets Configuration (Advanced)
# See https://github.com/your-repo/planbot for documentation

config:
  model: sonnet
  maxBudgetPerTicket: 10
  maxRetries: 3
  continueOnError: false
  autoApprove: false
  skipPermissions: false

  # Optional: Configure messaging provider for approvals
  # messaging:
  #   provider: slack
  #   botToken: \${SLACK_BOT_TOKEN}
  #   appToken: \${SLACK_APP_TOKEN}
  #   channel: planbot-approvals

  webhook:
    enabled: false
    port: 3847
    path: /planbot/webhook

  timeouts:
    planGeneration: 300000   # 5 minutes
    execution: 1800000       # 30 minutes
    approval: 86400000       # 24 hours
    question: 3600000        # 1 hour

# Global hooks run for all tickets
hooks:
  beforeAll:
    - type: shell
      command: echo "Starting planbot queue..."

  afterAll:
    - type: shell
      command: echo "Queue processing complete"

  beforeEach:
    - type: shell
      command: git status --short

  afterEach:
    - type: shell
      command: echo "Ticket \${PLANBOT_TICKET_ID} finished with status \${PLANBOT_TICKET_STATUS}"

  # onError:
  #   - type: shell
  #     command: notify-failure.sh

  # onPlanGenerated:
  #   - type: prompt
  #     prompt: Review the plan and identify any potential issues

tickets:
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
    # Ticket-specific hook overrides
    # hooks:
    #   afterEach:
    #     - type: shell
    #       command: npm run test:auth

  - id: auth-002
    title: Add Password Reset Flow
    description: |
      Implement password reset functionality.

      Requirements:
      - Email-based reset flow
      - Time-limited reset tokens
      - Rate limiting on reset requests
    priority: 5
    dependencies:
      - auth-001
    acceptanceCriteria:
      - Users can request password reset
      - Reset emails are sent
      - Reset tokens expire after 1 hour
      - Passwords are properly updated

  - id: feature-001
    title: Example Feature
    description: |
      Replace this with your actual feature description.
    priority: 1
    metadata:
      estimate: 4h
      assignee: claude
`;

// =============================================================================
// Command Implementation
// =============================================================================

export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize planbot in the current directory')
    .option('--advanced', 'Use advanced template with hooks and messaging config')
    .option('--force', 'Overwrite existing configuration')
    .action(async (options: { advanced?: boolean; force?: boolean }) => {
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
        const template = options.advanced ? ADVANCED_TEMPLATE : BASIC_TEMPLATE;
        await writeTextFile(ticketsPath, template);
        spinner.text = 'Created tickets.yaml...';

        spinner.succeed('Planbot initialized successfully');

        console.log('\n' + chalk.bold('Next steps:'));
        console.log(chalk.dim('  1. Edit tickets.yaml to define your tickets'));
        console.log(chalk.dim('  2. Run: planbot start tickets.yaml'));
        console.log(chalk.dim('  3. Approve plans and monitor progress'));

        if (options.advanced) {
          console.log('\n' + chalk.yellow('Note: ') + 'Advanced template includes messaging and hook configurations.');
          console.log(chalk.dim('  See comments in tickets.yaml for setup instructions.'));
        }

        console.log('\n' + chalk.dim('Created files:'));
        console.log(chalk.dim(`  - ${ticketsPath}`));
        console.log(chalk.dim(`  - ${planbotDir}/`));

        logger.debug('Planbot initialized', { cwd, advanced: options.advanced });
      } catch (err) {
        spinner.fail('Failed to initialize planbot');
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}`));
        logger.error('Init failed', { error: message });
        process.exit(1);
      }
    });
}
