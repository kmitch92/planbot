import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

import { parseTicketsFile } from "../../core/schemas.js";
import type { Ticket } from "../../core/schemas.js";
import { claude } from "../../core/claude.js";
import { createMultiplexer } from "../../messaging/index.js";
import { createTerminalProvider } from "../../messaging/terminal.js";
import { fileExists } from "../../utils/fs.js";

// =============================================================================
// Types
// =============================================================================

interface VerifyOptions {
  ticket?: string;
  output?: string;
  verbose?: boolean;
}

interface CriterionResult {
  index: number;
  text: string;
  status: "PASS" | "FAIL" | "SKIP";
  reason: string;
}

interface TicketVerification {
  ticketId: string;
  ticketTitle: string;
  criteria: CriterionResult[];
  result: "PASS" | "FAIL" | "PARTIAL" | "PENDING";
}

// =============================================================================
// VerificationTracker
// =============================================================================

const TOKEN_PATTERN = /\[VERIFY_(\w+)\s+(.*?)\]/;
const CRITERION_PATTERN = /\[CRITERION\s+(.*?)\]/;
const KV_PATTERN = /(\w+)="([^"]*)"/g;
const INDEX_PATTERN = /index=(\d+)/;

function parseKeyValues(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  let match: RegExpExecArray | null;
  // Reset lastIndex for global regex
  KV_PATTERN.lastIndex = 0;
  while ((match = KV_PATTERN.exec(raw)) !== null) {
    result[match[1]!] = match[2]!;
  }
  return result;
}

export class VerificationTracker {
  private verifications = new Map<string, TicketVerification>();
  private currentTicketId: string | null = null;
  private buffer = "";

  handleAssistantText(text: string): void {
    // Buffer text to handle tokens split across chunks
    this.buffer += text;

    // Process complete lines
    const lines = this.buffer.split("\n");
    // Keep the last partial line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      this.processLine(line);
    }
  }

  /**
   * Flush any remaining buffered text. Call after agent execution completes.
   */
  flush(): void {
    if (this.buffer.trim()) {
      this.processLine(this.buffer);
      this.buffer = "";
    }
  }

  getResults(): TicketVerification[] {
    return Array.from(this.verifications.values());
  }

  getSummary(): {
    passed: number;
    failed: number;
    skipped: number;
    total: number;
  } {
    const results = this.getResults();
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    for (const v of results) {
      if (v.result === "PASS") {
        passed++;
      } else {
        // FAIL, PARTIAL, PENDING, and any unexpected value (e.g. SKIP) count as failed
        failed++;
      }
    }

    // Count skipped criteria across all tickets
    for (const v of results) {
      for (const c of v.criteria) {
        if (c.status === "SKIP") skipped++;
      }
    }

    return { passed, failed, skipped, total: results.length };
  }

  private processLine(line: string): void {
    // Check for CRITERION token first (more specific)
    const criterionMatch = CRITERION_PATTERN.exec(line);
    if (criterionMatch) {
      this.handleCriterion(criterionMatch[1]!);
      return;
    }

    // Check for VERIFY_* tokens
    const tokenMatch = TOKEN_PATTERN.exec(line);
    if (tokenMatch) {
      const tokenType = tokenMatch[1]!;
      const payload = tokenMatch[2]!;
      this.handleToken(tokenType, payload);
    }
  }

  private handleToken(type: string, payload: string): void {
    const kv = parseKeyValues(payload);

    switch (type) {
      case "START": {
        const ticketId = kv["ticketId"];
        if (!ticketId) return;
        this.currentTicketId = ticketId;
        this.verifications.set(ticketId, {
          ticketId,
          ticketTitle: kv["ticketTitle"] ?? ticketId,
          criteria: [],
          result: "PENDING",
        });
        break;
      }
      case "CONFIRM": {
        // Acknowledgement only; no state change needed
        break;
      }
      case "END": {
        const ticketId = kv["ticketId"];
        if (!ticketId) return;
        const verification = this.verifications.get(ticketId);
        if (verification) {
          const rawResult = kv["result"] ?? "FAIL";
          verification.result = normalizeResult(rawResult);
        }
        if (this.currentTicketId === ticketId) {
          this.currentTicketId = null;
        }
        break;
      }
      case "COMPLETE": {
        // Summary token; results already accumulated
        break;
      }
    }
  }

  private handleCriterion(payload: string): void {
    if (!this.currentTicketId) return;
    const verification = this.verifications.get(this.currentTicketId);
    if (!verification) return;

    const kv = parseKeyValues(payload);
    const indexMatch = INDEX_PATTERN.exec(payload);
    const index = indexMatch ? parseInt(indexMatch[1]!, 10) : verification.criteria.length;

    const status = normalizeStatus(kv["status"] ?? "SKIP");

    verification.criteria.push({
      index,
      text: kv["text"] ?? "",
      status,
      reason: kv["reason"] ?? "",
    });
  }
}

function normalizeStatus(raw: string): "PASS" | "FAIL" | "SKIP" {
  const upper = raw.toUpperCase();
  if (upper === "PASS") return "PASS";
  if (upper === "FAIL") return "FAIL";
  return "SKIP";
}

function normalizeResult(raw: string): "PASS" | "FAIL" | "PARTIAL" | "PENDING" {
  const upper = raw.toUpperCase();
  if (upper === "PASS") return "PASS";
  if (upper === "PARTIAL") return "PARTIAL";
  if (upper === "SKIP") return "FAIL"; // SKIP treated as FAIL in summary
  return "FAIL";
}

// =============================================================================
// Prompt Builder
// =============================================================================

export function buildVerifyPrompt(tickets: Ticket[]): string {
  const sections: string[] = [];

  // Role
  sections.push(
    "You are a verification agent reviewing whether tasks have been completed in this codebase.",
  );

  // Protocol instructions
  sections.push(`## Output Token Protocol

You MUST emit structured tokens that the harness parses from your output.
Each token MUST appear on its own line exactly as specified. Malformed tokens will not be recognized.

Token formats:

\`\`\`
[VERIFY_START ticketId="<id>"]
[CRITERION index=<n> status="PASS|FAIL|SKIP" reason="<brief explanation>"]
[VERIFY_CONFIRM ticketId="<id>"]
[VERIFY_END ticketId="<id>" result="PASS|FAIL|PARTIAL"]
[VERIFY_COMPLETE summary="<passed>/<total> passed"]
\`\`\`

- ticketId must match exactly the ticket ID provided below.
- index is zero-based, matching the acceptance criteria numbering.
- status is one of: PASS, FAIL, SKIP.
- result is one of: PASS (all criteria pass), FAIL (any criterion fails), PARTIAL (some pass, some fail).
- Emit each token on its own line with no leading whitespace.`);

  // Workflow
  sections.push(`## Workflow

Process tickets in the order given below. For each ticket:

1. Emit \`[VERIFY_START ticketId="<id>"]\`
2. Read relevant source code, tests, and configuration files to evaluate each acceptance criterion.
3. For each criterion (0-indexed), emit:
   \`[CRITERION index=<n> status="PASS|FAIL|SKIP" reason="<brief explanation>"]\`
4. Emit \`[VERIFY_CONFIRM ticketId="<id>"]\`
5. Use AskUserQuestion to present your assessment and ask:
   "Do you confirm these results for '<ticket-title>'?"
   with options: ["Confirmed", "Not complete", "Skip"]
6. Based on the user's response:
   - "Confirmed" -> emit \`[VERIFY_END ticketId="<id>" result="PASS|FAIL|PARTIAL"]\` matching your assessment
   - "Not complete" -> emit \`[VERIFY_END ticketId="<id>" result="FAIL"]\`
   - "Skip" -> emit \`[VERIFY_END ticketId="<id>" result="FAIL"]\`

After all tickets are processed, emit:
\`[VERIFY_COMPLETE summary="<passed>/<total> passed"]\``);

  // Constraints
  sections.push(`## Constraints

- Do NOT modify any files. Only read and analyze.
- Do NOT create or edit any files.
- Be thorough: read actual source files, test files, and configs before judging each criterion.
- Keep reasons concise (under 100 characters).`);

  // Ticket data
  const ticketLines: string[] = ["## Tickets to Verify"];
  for (const ticket of tickets) {
    ticketLines.push("");
    ticketLines.push(`### Ticket: ${ticket.id}`);
    ticketLines.push(`**Title**: ${ticket.title}`);
    ticketLines.push(`**Description**: ${ticket.description}`);
    if (ticket.acceptanceCriteria && ticket.acceptanceCriteria.length > 0) {
      ticketLines.push("**Acceptance Criteria**:");
      for (let i = 0; i < ticket.acceptanceCriteria.length; i++) {
        ticketLines.push(`${i}. ${ticket.acceptanceCriteria[i]}`);
      }
    }
  }
  sections.push(ticketLines.join("\n"));

  return sections.join("\n\n");
}

// =============================================================================
// Display Results
// =============================================================================

export function displayResults(results: TicketVerification[]): void {
  const separator = chalk.dim("\u2500".repeat(50));

  console.log("");
  console.log(chalk.bold("Verification Results"));
  console.log(separator);

  for (const v of results) {
    const criteriaTotal = v.criteria.length;
    const criteriaPassed = v.criteria.filter((c) => c.status === "PASS").length;
    const tag = `(${criteriaPassed}/${criteriaTotal} criteria)`;

    if (v.result === "PASS") {
      console.log(
        ` ${chalk.green("\u2713")} ${v.ticketId}: ${v.ticketTitle}  ${chalk.green("PASS")}  ${chalk.dim(tag)}`,
      );
    } else {
      const resultColor = v.result === "PARTIAL" ? chalk.yellow : chalk.red;
      console.log(
        ` ${chalk.red("\u2717")} ${v.ticketId}: ${v.ticketTitle}  ${resultColor(v.result)}  ${chalk.dim(tag)}`,
      );
      // Show failing/skipped criteria details
      for (const c of v.criteria) {
        if (c.status !== "PASS") {
          const statusColor = c.status === "SKIP" ? chalk.yellow : chalk.red;
          const reason = c.reason ? `"${c.reason}"` : "";
          console.log(
            `   ${statusColor("\u2717")} [${c.index}] ${c.text || `Criterion ${c.index}`}  ${chalk.dim(reason)}`,
          );
        }
      }
    }
  }

  console.log(separator);

  const passed = results.filter((r) => r.result === "PASS").length;
  console.log(
    chalk.bold(`Overall: ${passed}/${results.length} tickets verified`),
  );
  console.log("");
}

// =============================================================================
// Command Factory
// =============================================================================

export function createVerifyCommand(): Command {
  return new Command("verify")
    .description("Verify ticket acceptance criteria against the codebase")
    .argument(
      "[tickets-file]",
      "Path to tickets.yaml or tickets.json",
      "tickets.yaml",
    )
    .option("--ticket <id>", "Verify a single ticket")
    .option("--output <path>", "Write JSON report to file")
    .option("-v, --verbose", "Enable verbose logging")
    .action(async (ticketsFile: string, options: VerifyOptions) => {
      const cwd = process.cwd();
      const ticketsPath = resolve(cwd, ticketsFile);

      const spinner = ora("Loading tickets...").start();

      let multiplexer: ReturnType<typeof createMultiplexer> | null = null;

      try {
        // Load tickets file
        if (!(await fileExists(ticketsPath))) {
          spinner.fail(`Tickets file not found: ${ticketsPath}`);
          process.exit(1);
        }

        const content = await readFile(ticketsPath, "utf-8");
        let parsed: unknown;

        if (ticketsPath.endsWith(".json")) {
          parsed = JSON.parse(content);
        } else {
          parsed = parseYaml(content);
        }

        const ticketsData = parseTicketsFile(parsed);

        // Filter to tickets with acceptance criteria
        let verifiable = ticketsData.tickets.filter(
          (t) => t.acceptanceCriteria && t.acceptanceCriteria.length > 0,
        );

        const skippedCount = ticketsData.tickets.length - verifiable.length;
        if (skippedCount > 0) {
          spinner.info(
            `${skippedCount} ticket(s) skipped (no acceptance criteria)`,
          );
        }

        // Filter to single ticket if --ticket provided
        if (options.ticket) {
          const target = verifiable.find((t) => t.id === options.ticket);
          if (!target) {
            // Check if ticket exists but has no criteria
            const exists = ticketsData.tickets.find(
              (t) => t.id === options.ticket,
            );
            if (exists) {
              spinner.fail(
                `Ticket "${options.ticket}" has no acceptance criteria`,
              );
            } else {
              spinner.fail(`Ticket "${options.ticket}" not found`);
            }
            process.exit(1);
          }
          verifiable = [target];
        }

        if (verifiable.length === 0) {
          spinner.warn("No tickets with acceptance criteria to verify");
          process.exit(0);
        }

        spinner.succeed(
          `Loaded ${verifiable.length} ticket(s) for verification`,
        );

        // Set up messaging
        const terminal = createTerminalProvider({
          showFullPlan: false,
          colors: true,
        });

        multiplexer = createMultiplexer({
          questionTimeout: 3600000, // 1 hour
        });

        multiplexer.addProvider(terminal);
        await multiplexer.connectAll();

        // Set up tracker and prompt
        const tracker = new VerificationTracker();
        const prompt = buildVerifyPrompt(verifiable);

        // Populate ticket titles in tracker by pre-seeding nothing;
        // tracker builds state from tokens. We keep a title lookup for
        // criterion text enrichment after execution.
        const titleMap = new Map<string, Ticket>();
        for (const t of verifiable) {
          titleMap.set(t.id, t);
        }

        // SIGINT handler
        const onSigint = () => {
          console.log(chalk.yellow("\nAborting verification..."));
          claude.abort();
          multiplexer?.disconnectAll().catch(() => {});
          process.exit(130);
        };
        process.on("SIGINT", onSigint);

        console.log(chalk.bold("\nStarting verification...\n"));

        // Execute agent
        const mux = multiplexer; // capture for closure
        const result = await claude.execute(
          prompt,
          {
            permissionMode: "plan",
            skipPermissions: false,
            timeout: 1800000, // 30 min
            cwd,
            verbose: options.verbose,
          },
          {
            onEvent: (event) => {
              if (event.type === "assistant" && event.message) {
                tracker.handleAssistantText(event.message);
              }
            },
            onQuestion: async (question) => {
              const response = await mux.askQuestion({
                questionId: question.id,
                ticketId: "verify",
                ticketTitle: "Verification",
                question: question.text,
                options: question.options?.map((o) => ({
                  label: o,
                  value: o,
                })),
              });
              return response.answer;
            },
            onOutput: () => {},
          },
        );

        // Flush remaining buffered text
        tracker.flush();

        // Remove SIGINT handler
        process.removeListener("SIGINT", onSigint);

        // Enrich criterion text from ticket data
        const results = tracker.getResults();
        for (const v of results) {
          const ticket = titleMap.get(v.ticketId);
          if (ticket) {
            // Ensure title is set from source data
            v.ticketTitle = ticket.title;
            // Fill in criterion text from acceptance criteria
            for (const c of v.criteria) {
              if (
                !c.text &&
                ticket.acceptanceCriteria &&
                c.index < ticket.acceptanceCriteria.length
              ) {
                c.text = ticket.acceptanceCriteria[c.index]!;
              }
            }
          }
        }

        // Display results
        displayResults(results);

        // Write JSON report if requested
        if (options.output) {
          const reportPath = resolve(cwd, options.output);
          await writeFile(reportPath, JSON.stringify(results, null, 2), "utf-8");
          console.log(chalk.dim(`Report written to ${reportPath}`));
        }

        if (!result.success) {
          console.log(
            chalk.yellow(
              "Agent execution completed with errors. Results may be incomplete.",
            ),
          );
        }

        // Exit code: 0 if all passed, 1 if any failed
        const summary = tracker.getSummary();
        const exitCode = summary.failed > 0 ? 1 : 0;
        process.exit(exitCode);
      } catch (err) {
        spinner.fail("Verification failed");
        const message = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`\nError: ${message}`));
        process.exit(1);
      } finally {
        if (multiplexer) {
          await multiplexer.disconnectAll().catch(() => {});
        }
      }
    });
}
