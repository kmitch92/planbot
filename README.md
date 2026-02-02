# Planbot

Autonomous ticket execution system powered by Claude CLI. Planbot processes a queue of tickets, generating execution plans, requesting approvals, and executing tasks through Claude's API—all with optional messaging integration and webhook support.

Inspired by the [ralph](https://github.com/anthropics/ralph) pattern.

## Features

- **Autonomous Execution**: Claude generates and executes plans for each ticket
- **Plan Approval Workflow**: Review plans before execution (or auto-approve)
- **Continuous Mode**: Keep running and prompt for new plans after queue completion
- **Messaging Integration**: Slack, Discord, and Telegram support for notifications and approvals
- **Dependency Management**: Define ticket dependencies for ordered execution
- **Hook System**: Run shell commands or custom prompts at key lifecycle events
- **Webhook API**: HTTP endpoints for external integrations
- **State Management**: Pause, resume, and track progress across sessions

## Installation

```bash
npm install
npm run build
npm link  # for global CLI access
```

**Requirements**: Node.js >= 18.0.0

## Quick Start

1. Initialize a new planbot project:

```bash
planbot init
```

This creates a `.planbot/` directory and a sample `tickets.json` file.

2. Edit `tickets.json` (or create `tickets.yaml`) with your tickets:

```json
{
  "config": {
    "model": "sonnet",
    "autoApprove": false
  },
  "tickets": [
    {
      "id": "task-001",
      "title": "Add user authentication",
      "description": "Implement JWT-based auth with login/logout endpoints",
      "status": "pending"
    }
  ]
}
```

3. Start processing:

```bash
planbot start
```

Planbot will generate a plan for each ticket, request approval, and execute approved plans.

## Configuration

Configuration lives in the `config` section of your tickets file (`tickets.yaml` or `tickets.json`).

### Full Configuration Schema

```yaml
config:
  # Claude model selection
  model: sonnet  # Options: "sonnet" | "opus" | "haiku"

  # Budget limit per ticket in USD
  maxBudgetPerTicket: 10

  # Retry failed operations
  maxRetries: 3

  # Continue processing queue if a ticket fails
  continueOnError: false

  # Auto-approve plans without human review (use with caution)
  autoApprove: false

  # Skip permission prompts (dangerous mode)
  skipPermissions: false

  # Messaging provider configuration (optional)
  messaging:
    provider: slack  # Options: "slack" | "discord" | "telegram"
    # Provider-specific config (see Messaging Setup)

  # Webhook server configuration (optional)
  webhook:
    enabled: false
    port: 3847
    path: "/planbot/webhook"

  # Timeout configurations (milliseconds)
  timeouts:
    planGeneration: 300000   # 5 minutes
    execution: 1800000       # 30 minutes
    approval: 86400000       # 24 hours
    question: 3600000        # 1 hour

# Global hooks (optional)
hooks:
  beforeAll:
    - type: shell
      command: "echo 'Starting planbot'"
  afterAll:
    - type: shell
      command: "npm run lint"
  # ... (see Hooks section)

# Ticket queue
tickets:
  - id: "task-001"
    title: "Example task"
    description: "Detailed description..."
    status: pending
    priority: 1
    acceptanceCriteria:
      - "All tests pass"
      - "Code is documented"
    dependencies: []
    hooks: {}  # Ticket-specific hooks override global hooks
    metadata: {}
```

### Ticket Schema

Each ticket supports:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Unique identifier |
| `title` | string | ✓ | Short descriptive title |
| `description` | string | ✓ | Detailed work description |
| `status` | string | - | Default: `"pending"` |
| `priority` | number | - | Higher = more urgent (default: 0) |
| `acceptanceCriteria` | string[] | - | Completion criteria list |
| `dependencies` | string[] | - | IDs of tickets that must complete first |
| `hooks` | object | - | Ticket-specific hooks |
| `metadata` | object | - | Arbitrary metadata for extensibility |

**Status values**: `pending`, `planning`, `awaiting_approval`, `approved`, `executing`, `completed`, `failed`, `skipped`

## CLI Reference

### Core Commands

#### `planbot init`
Initialize a new planbot project.

```bash
planbot init
```

Creates `.planbot/` directory and sample tickets file.

#### `planbot start [options]`
Start processing the ticket queue.

```bash
planbot start
planbot start --auto-approve
planbot start --skip-permissions --model opus
```

**Options:**
- `--auto-approve`: Auto-approve all plans (bypass approval workflow)
- `--skip-permissions`: Skip permission prompts (dangerous)
- `--model <model>`: Override config model (`sonnet`, `opus`, `haiku`)
- `-C, --continuous`: Keep running and prompt for new plans after completion
- `--continuous-timeout <ms>`: Timeout for next plan prompt (default: 1 hour)

### Continuous Mode

Keep planbot running and prompt for new plans after each completion:

```bash
planbot start --continuous
```

After all tickets in the queue complete, planbot prompts you to enter a new plan:
- Type your plan text (first line becomes the title, rest becomes the description)
- Type "exit", "quit", "q", "done", or "stop" to exit

**Options:**
- `-C, --continuous`: Keep running and prompt for new plans after completion
- `--continuous-timeout <ms>`: Timeout for next plan prompt (default: 1 hour)

**Example session:**
```
>>> Queue processing complete

Queue Summary:
  Completed: 3

--- Continuous Mode ---
Enter your next plan (or "exit" to quit):
> Add rate limiting to the API
First line becomes the title

Queuing: Add rate limiting to the API
ID: cont-1706886400000-a1b2c3d4

>>> Starting: Add rate limiting to the API
...
```

#### `planbot resume`
Resume paused or stopped processing.

```bash
planbot resume
```

#### `planbot status`
Show current processing status.

```bash
planbot status
```

Displays: current ticket, phase, pending questions, pause state.

### Control Commands

#### `planbot approve <ticketId>`
Approve a ticket plan.

```bash
planbot approve task-001
```

#### `planbot reject <ticketId> [reason]`
Reject a ticket plan.

```bash
planbot reject task-001 "Approach needs revision"
```

#### `planbot respond <questionId> <answer>`
Answer a pending question from Claude.

```bash
planbot respond q-12345 "Use PostgreSQL for the database"
```

#### `planbot skip <ticketId>`
Skip a ticket (mark as skipped).

```bash
planbot skip task-002
```

#### `planbot pause`
Request pause after current operation.

```bash
planbot pause
```

#### `planbot stop`
Request stop after current operation.

```bash
planbot stop
```

### Utility Commands

#### `planbot list`
List all tickets with their status.

```bash
planbot list
```

#### `planbot logs [options]`
View execution logs.

```bash
planbot logs
planbot logs --tail 50
planbot logs --follow
```

#### `planbot validate`
Validate tickets file syntax.

```bash
planbot validate
planbot validate --file custom-tickets.yaml
```

#### `planbot plan <ticketId>`
Generate plan for a ticket without executing.

```bash
planbot plan task-001
```

#### `planbot serve`
Start webhook server only (no ticket processing).

```bash
planbot serve --port 3847
```

#### `planbot reset`
Reset state (clears current ticket and session).

```bash
planbot reset
```

#### `planbot clear`
Clear all state and logs.

```bash
planbot clear --force
```

### Global Options

All commands support:
- `-v, --verbose`: Enable verbose logging
- `-q, --quiet`: Suppress non-essential output
- `-c, --config <path>`: Path to configuration file

## Messaging Setup

Planbot supports Slack, Discord, and Telegram for notifications, approvals, and question responses.

### Slack

```yaml
messaging:
  provider: slack
  botToken: ${SLACK_BOT_TOKEN}
  appToken: ${SLACK_APP_TOKEN}
  channel: "#planbot"
```

**Setup:**
1. Create a Slack App at https://api.slack.com/apps
2. Enable Socket Mode and generate App Token (xapp-...)
3. Add Bot Token Scopes: `chat:write`, `channels:history`, `groups:history`
4. Install app to workspace and get Bot Token (xoxb-...)
5. Invite bot to your channel: `/invite @YourBotName`

**Environment variables:**
```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."
```

### Discord

```yaml
messaging:
  provider: discord
  botToken: ${DISCORD_BOT_TOKEN}
  channelId: "1234567890123456789"
```

**Setup:**
1. Create Discord App at https://discord.com/developers/applications
2. Create a Bot and copy the token
3. Enable "MESSAGE CONTENT INTENT" in Bot settings
4. Invite bot to your server with permissions: Send Messages, Read Messages, Use Slash Commands
5. Right-click your channel → Copy ID (enable Developer Mode in User Settings first)

**Environment variables:**
```bash
export DISCORD_BOT_TOKEN="..."
```

### Telegram

```yaml
messaging:
  provider: telegram
  botToken: ${TELEGRAM_BOT_TOKEN}
  chatId: "-1001234567890"
```

**Setup:**
1. Create bot via [@BotFather](https://t.me/botfather) on Telegram
2. Copy the bot token
3. Add bot to your group/channel
4. Get chat ID by sending a message and visiting: `https://api.telegram.org/bot<TOKEN>/getUpdates`

**Environment variables:**
```bash
export TELEGRAM_BOT_TOKEN="..."
```

## Hooks

Hooks run shell commands or Claude prompts at specific lifecycle events.

### Hook Types

| Hook | When It Runs |
|------|--------------|
| `beforeAll` | Once before processing any tickets |
| `afterAll` | Once after all tickets are processed |
| `beforeEach` | Before each ticket starts processing |
| `afterEach` | After each ticket completes (success or failure) |
| `onError` | When an error occurs during ticket processing |
| `onQuestion` | When Claude asks a question requiring user input |
| `onPlanGenerated` | After a plan is generated but before approval |
| `onApproval` | When a ticket requires approval |
| `onComplete` | When a ticket completes successfully |

### Hook Action Types

#### Shell Command

```yaml
hooks:
  beforeEach:
    - type: shell
      command: "git status --short"
```

#### Claude Prompt

```yaml
hooks:
  onPlanGenerated:
    - type: prompt
      prompt: "Review this plan for security issues"
```

### Environment Variables in Hooks

Hook shell commands have access to these environment variables:

| Variable | Description |
|----------|-------------|
| `PLANBOT_EVENT` | Current hook event name |
| `PLANBOT_TICKET_ID` | Current ticket ID |
| `PLANBOT_TICKET_TITLE` | Current ticket title |
| `PLANBOT_TICKET_STATUS` | Current ticket status |
| `PLANBOT_PLAN_PATH` | Path to generated plan file |
| `PLANBOT_PLAN` | Plan content (for `onPlanGenerated`) |
| `PLANBOT_ERROR` | Error message (for `onError`) |
| `PLANBOT_QUESTION` | Question text (for `onQuestion`) |
| `PLANBOT_QUESTION_ID` | Question ID (for `onQuestion`) |

### Example: Git Workflow Hooks

```yaml
hooks:
  beforeEach:
    - type: shell
      command: "git checkout -b $PLANBOT_TICKET_ID"

  onComplete:
    - type: shell
      command: "git add -A"
    - type: shell
      command: "git commit -m '$PLANBOT_TICKET_TITLE'"
    - type: shell
      command: "git push origin $PLANBOT_TICKET_ID"

  onError:
    - type: shell
      command: "git checkout main && git branch -D $PLANBOT_TICKET_ID"
```

## Webhook API

Planbot can expose an HTTP API for external systems to send approvals and question responses.

### Configuration

```yaml
config:
  webhook:
    enabled: true
    port: 3847
    path: "/planbot/webhook"
```

Optional: Set `PLANBOT_WEBHOOK_SECRET` environment variable for HMAC signature verification.

### Endpoints

#### GET `/planbot/webhook/health`
Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "uptime": 12345
}
```

#### GET `/planbot/webhook/status`
Current processing status.

**Response:**
```json
{
  "currentTicketId": "task-001",
  "currentPhase": "awaiting_approval",
  "pendingApprovals": ["plan-123"],
  "pendingQuestions": ["q-456"]
}
```

#### POST `/planbot/webhook/approve`
Approve or reject a plan.

**Request:**
```json
{
  "planId": "plan-123",
  "approved": true,
  "rejectionReason": "Optional reason if rejected",
  "respondedBy": "user@example.com"
}
```

**Response:**
```json
{
  "success": true
}
```

#### POST `/planbot/webhook/respond`
Respond to a question.

**Request:**
```json
{
  "questionId": "q-456",
  "answer": "Use PostgreSQL",
  "respondedBy": "user@example.com"
}
```

**Response:**
```json
{
  "success": true
}
```

### HMAC Signature Verification

If `PLANBOT_WEBHOOK_SECRET` is set, all webhook requests must include `X-Planbot-Signature` header:

```bash
# Generate signature
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')

# Send request
curl -X POST http://localhost:3847/planbot/webhook/approve \
  -H "Content-Type: application/json" \
  -H "X-Planbot-Signature: $SIGNATURE" \
  -d "$BODY"
```

## Development

```bash
# Development mode with auto-reload
npm run dev

# Run tests
npm test

# Build TypeScript
npm run build

# Lint code
npm run lint
```

## License

MIT
