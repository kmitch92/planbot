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

const BASIC_TEMPLATE = `# Planbot Tickets
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

const ADVANCED_TEMPLATE = `# Planbot Tickets
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

  # onPlanGenerated:
  #   - type: prompt
  #     command: Review the generated plan and identify any risks or missing steps
  #   - type: shell
  #     command: cat "\${PLANBOT_PLAN_PATH}"

  # onError:
  #   - type: shell
  #     command: echo "ERROR in \${PLANBOT_TICKET_ID}: \${PLANBOT_ERROR}"

  # onComplete:
  #   - type: shell
  #     command: echo "\${PLANBOT_TICKET_ID} completed successfully"

# =============================================================================
# Tickets
# =============================================================================
#
# Required fields: id, title, description
# Optional fields: priority, planMode, acceptanceCriteria, dependencies, hooks, metadata, images
#
# planMode (default: true):
#   true  — generate a plan, wait for approval, then execute
#   false — skip planning and approval, execute directly from description
#
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
    # images:
    #   - .planbot/assets/auth-001/design-mockup.png

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

  - id: feature-001
    title: Example Feature
    description: |
      Replace this with your actual feature description.
    priority: 1
    planMode: false                # Executes directly without plan generation
    # images:                      # Attach with: planbot attach feature-001 screenshot.png
    #   - .planbot/assets/feature-001/screenshot.png
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
