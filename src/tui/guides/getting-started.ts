export const guide = {
  title: 'Getting Started with Planbot',
  content: `
GETTING STARTED WITH PLANBOT
=============================

WHAT IS PLANBOT?
----------------
Planbot is an autonomous ticket execution system powered by Claude CLI.
It processes development tickets automatically, generating plans, seeking
approval, executing changes, and notifying you of progress.

PREREQUISITES
-------------
Before using Planbot, ensure you have:

- Node.js 18 or higher installed
- Claude CLI installed and authenticated
  (Visit: https://claude.ai/code for setup instructions)
- Git repository initialized (recommended)

QUICK START
-----------
1. Initialize a new Planbot project:
   $ planbot init

2. Create or edit your tickets.yaml file:
   $ nano tickets.yaml

3. Define your configuration and tickets (see example below)

4. Start processing:
   $ planbot start

BASIC TICKETS.YAML STRUCTURE
-----------------------------
\`\`\`yaml
config:
  model: sonnet              # AI model to use (sonnet, opus, haiku)
  planMode: true             # Require plan approval before execution
  maxConcurrent: 1           # Process 1 ticket at a time
  retryLimit: 3              # Retry failed tickets up to 3 times

tickets:
  - id: my-first-ticket
    title: My First Ticket
    description: |
      What this ticket should accomplish.
      Be specific about requirements and expected outcomes.
    status: pending
\`\`\`

HOW THE PROCESSING LOOP WORKS
------------------------------
1. PLAN PHASE
   Claude analyzes the ticket and generates an execution plan with
   step-by-step actions.

2. APPROVAL PHASE
   If planMode is enabled, Planbot waits for your approval:
   - Review the plan
   - Approve via TUI, messaging app, or webhook
   - Or reject to request a new plan

3. EXECUTE PHASE
   Claude executes the approved plan:
   - Reads/writes files
   - Runs tests
   - Makes code changes
   - May ask questions if clarification needed

4. COMPLETE PHASE
   Ticket marked as complete or failed
   - Notifications sent (if configured)
   - Results logged
   - Next ticket begins (if available)

NEXT STEPS
----------
- Run \`planbot validate\` to check your configuration
- Explore notification setup guides (Telegram, Slack, Discord)
- Configure lifecycle hooks for custom automation
- Review the hooks guide for advanced workflows

For detailed configuration options, run:
  $ planbot help
`,
};
