export const guide = {
  title: 'Lifecycle Hooks',
  content: `
LIFECYCLE HOOKS
===============

Hooks allow you to run custom shell commands or inject prompts at key
points in Planbot's execution lifecycle. Use them to integrate tests,
enforce standards, or customize Claude's behavior.

WHAT ARE LIFECYCLE HOOKS?
--------------------------
Hooks are automated actions triggered at specific lifecycle events:

- Run commands before/after ticket processing
- Execute tests or validation scripts
- Inject instructions into Claude's prompts
- Handle errors with custom recovery logic
- Send notifications or update external systems

HOOK TYPES
----------
Planbot supports two hook types:

1. SHELL HOOKS (type: shell)
   Execute shell commands in your project directory
   Example: npm test, git stash, docker-compose up

2. PROMPT HOOKS (type: prompt)
   Inject instructions into Claude's system prompt
   Example: "Always use TypeScript strict mode"

AVAILABLE HOOK POINTS
----------------------

beforeAll
  Runs once before any tickets are processed
  Use for: Setup, environment prep, dependency checks

afterAll
  Runs once after all tickets are processed
  Use for: Cleanup, reporting, final validation

beforeEach
  Runs before each individual ticket
  Use for: Per-ticket setup, git stash, backup state

afterEach
  Runs after each ticket completes
  Use for: Tests, linting, formatting, git operations

onError
  Runs when ticket processing fails
  Use for: Cleanup, rollback, error reporting

onQuestion
  Runs when Claude asks a question
  Use for: Logging, notifications, context gathering

onPlanGenerated
  Runs after Claude generates an execution plan
  Use for: Plan validation, static analysis, logging

onApproval
  Runs when plan approval is required
  Use for: Notifications, external approval workflows

onComplete
  Runs when a ticket succeeds
  Use for: Success notifications, artifact publishing

BASIC CONFIGURATION
-------------------
Add hooks to your tickets.yaml config section:

\`\`\`yaml
config:
  model: sonnet
  planMode: true
  allowShellHooks: true    # REQUIRED for shell hooks

hooks:
  beforeEach:
    - type: shell
      command: "git stash"

  afterEach:
    - type: shell
      command: "npm test"
    - type: shell
      command: "npm run lint"

  onError:
    - type: shell
      command: "git checkout ."
\`\`\`

SHELL HOOK EXAMPLES
-------------------

1. RUN TESTS AFTER EACH TICKET
   \`\`\`yaml
   hooks:
     afterEach:
       - type: shell
         command: "npm test"
   \`\`\`

2. STASH CHANGES BEFORE PROCESSING
   \`\`\`yaml
   hooks:
     beforeEach:
       - type: shell
         command: "git stash push -m 'Pre-ticket stash'"
   \`\`\`

3. FORMAT CODE AFTER COMPLETION
   \`\`\`yaml
   hooks:
     afterEach:
       - type: shell
         command: "npm run prettier -- --write ."
   \`\`\`

4. ROLLBACK ON ERROR
   \`\`\`yaml
   hooks:
     onError:
       - type: shell
         command: "git reset --hard HEAD"
       - type: shell
         command: "git clean -fd"
   \`\`\`

5. BUILD PROJECT BEFORE PROCESSING
   \`\`\`yaml
   hooks:
     beforeAll:
       - type: shell
         command: "npm install"
       - type: shell
         command: "npm run build"
   \`\`\`

PROMPT HOOK EXAMPLES
--------------------

1. ENFORCE TYPESCRIPT STRICT MODE
   \`\`\`yaml
   hooks:
     beforeEach:
       - type: prompt
         command: "Always use TypeScript strict mode. Never use 'any'."
   \`\`\`

2. REQUIRE TESTS FOR ALL CODE
   \`\`\`yaml
   hooks:
     beforeEach:
       - type: prompt
         command: |
           Write tests for all new functions using Jest.
           Follow TDD: write tests first, then implementation.
   \`\`\`

3. ENFORCE CODE STYLE
   \`\`\`yaml
   hooks:
     beforeEach:
       - type: prompt
         command: |
           Follow these coding standards:
           - Use functional programming patterns
           - Prefer pure functions
           - Add JSDoc comments to all exports
   \`\`\`

4. PROJECT-SPECIFIC CONVENTIONS
   \`\`\`yaml
   hooks:
     beforeEach:
       - type: prompt
         command: |
           This project uses:
           - ESM modules (import/export)
           - Zod for schema validation
           - React with hooks (no class components)
   \`\`\`

PER-TICKET HOOK OVERRIDES
--------------------------
Individual tickets can override global hooks:

\`\`\`yaml
tickets:
  - id: ticket-001
    title: Feature A
    description: Implement feature A
    hooks:
      afterEach:
        - type: shell
          command: "npm run test:integration"
      onComplete:
        - type: shell
          command: "npm run deploy:staging"
\`\`\`

Per-ticket hooks REPLACE global hooks for that lifecycle event.
To extend global hooks, duplicate them in ticket-level config.

CONDITIONAL HOOKS (ADVANCED)
-----------------------------
Use shell conditionals for environment-specific hooks:

\`\`\`yaml
hooks:
  afterEach:
    - type: shell
      command: |
        if [ "$CI" = "true" ]; then
          npm run test:ci
        else
          npm test
        fi
\`\`\`

HOOK EXECUTION ORDER
--------------------
Multiple hooks at the same lifecycle point run sequentially
in the order defined:

\`\`\`yaml
hooks:
  afterEach:
    - type: shell
      command: "npm run lint"      # Runs first
    - type: shell
      command: "npm test"          # Runs second
    - type: shell
      command: "npm run build"     # Runs third
\`\`\`

If any hook fails (non-zero exit code), subsequent hooks at that
point are skipped, and the error is reported.

SECURITY CONSIDERATIONS
-----------------------
⚠️  Shell hooks execute with full file system access!

Best practices:
1. Set allowShellHooks: true explicitly (never default)
2. Review all hook commands carefully
3. Avoid hooks that modify critical files (.git, node_modules)
4. Use environment variables for sensitive data
5. Test hooks in isolated environment first
6. Audit hooks regularly
7. Never run untrusted hooks from external sources

DEBUGGING HOOKS
---------------
Enable debug logging to see hook execution:

  $ DEBUG=planbot:hooks planbot start

Check hook output in logs:
- Command executed
- Exit code
- stdout/stderr output
- Execution time

COMMON USE CASES
----------------

1. TEST-DRIVEN WORKFLOW
   \`\`\`yaml
   hooks:
     beforeEach:
       - type: prompt
         command: "Write tests first using TDD."
     afterEach:
       - type: shell
         command: "npm test"
   \`\`\`

2. CONTINUOUS INTEGRATION
   \`\`\`yaml
   hooks:
     afterEach:
       - type: shell
         command: "npm run lint"
       - type: shell
         command: "npm test"
       - type: shell
         command: "npm run build"
   \`\`\`

3. GIT WORKFLOW AUTOMATION
   \`\`\`yaml
   hooks:
     beforeEach:
       - type: shell
         command: "git stash"
     onComplete:
       - type: shell
         command: "git add ."
       - type: shell
         command: "git commit -m 'Completed: $TICKET_ID'"
     onError:
       - type: shell
         command: "git checkout ."
   \`\`\`

4. NOTIFICATION INTEGRATION
   \`\`\`yaml
   hooks:
     onComplete:
       - type: shell
         command: |
           curl -X POST https://api.company.com/notify \\
             -d "ticket=$TICKET_ID completed"
   \`\`\`

ENVIRONMENT VARIABLES IN HOOKS
-------------------------------
Available variables during hook execution:

- TICKET_ID: Current ticket ID
- TICKET_TITLE: Current ticket title
- PLANBOT_STATUS: Current processing status
- CI: Set by CI environments
- Custom variables from .env file

Access in shell hooks:
\`\`\`yaml
hooks:
  onComplete:
    - type: shell
      command: "echo Completed $TICKET_ID: $TICKET_TITLE"
\`\`\`

TROUBLESHOOTING
---------------

Problem: Hook not executing
- Verify allowShellHooks: true for shell hooks
- Check hook is at correct lifecycle point
- Ensure YAML syntax is valid
- Review debug logs

Problem: Hook fails but should succeed
- Test command in terminal manually
- Check exit codes (0 = success, non-zero = failure)
- Verify working directory is correct
- Check file paths are absolute or relative to project root

Problem: Prompt hook not affecting Claude
- Verify prompt hooks at beforeEach/beforeAll
- Check prompt text is clear and specific
- Try more explicit instructions
- Review Claude's output for adherence

Problem: Hook execution too slow
- Minimize number of hooks
- Optimize shell commands
- Use asynchronous processing where possible
- Consider moving heavy tasks to afterAll

BEST PRACTICES
--------------
1. Keep hooks simple and focused
2. Test hooks independently before integrating
3. Use descriptive hook commands
4. Document complex hooks with comments
5. Prefer idempotent hooks (safe to run multiple times)
6. Log hook output for debugging
7. Set timeouts for long-running hooks
8. Use hooks to enforce code quality, not replace it
9. Version control hook configurations
10. Review hooks during code review process
`,
};
