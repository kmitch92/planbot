import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TicketSchema,
  TicketsFileSchema,
  type Ticket,
} from "../schemas.js";
import { markTicketCompleteInFile } from "../tickets-io.js";

// =============================================================================
// Helpers
// =============================================================================

function createTicket(overrides: Partial<Ticket> = {}): Ticket {
  return TicketSchema.parse({
    id: "ticket-1",
    title: "Test ticket",
    description: "A test ticket for completion behavior",
    ...overrides,
  });
}

function filterProcessableTickets(tickets: readonly Ticket[]): readonly Ticket[] {
  const completed = new Set(
    tickets.filter((t) => t.status === "completed").map((t) => t.id)
  );
  const failed = new Set(
    tickets.filter((t) => t.status === "failed").map((t) => t.id)
  );

  return tickets.filter((ticket) => {
    if (ticket.status !== "pending") {
      return false;
    }
    if (ticket.complete === true) {
      return false;
    }
    if (ticket.dependencies) {
      for (const depId of ticket.dependencies) {
        if (failed.has(depId)) {
          return false;
        }
        if (!completed.has(depId)) {
          return false;
        }
      }
    }
    return true;
  });
}

// =============================================================================
// Schema: TicketSchema accepts `complete` field
// =============================================================================

describe("TicketSchema complete field", () => {
  it("accepts complete: true as a valid field", () => {
    const result = TicketSchema.safeParse({
      id: "t-1",
      title: "Done ticket",
      description: "Already finished",
      complete: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.complete).toBe(true);
    }
  });

  it("accepts complete: false as a valid field", () => {
    const result = TicketSchema.safeParse({
      id: "t-2",
      title: "Incomplete ticket",
      description: "Not yet finished",
      complete: false,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.complete).toBe(false);
    }
  });

  it("defaults complete to false when not provided", () => {
    const result = TicketSchema.parse({
      id: "t-3",
      title: "No complete field",
      description: "Should default to false",
    });

    expect(result.complete).toBe(false);
  });

  it("preserves all other fields when complete is set", () => {
    const result = TicketSchema.parse({
      id: "t-4",
      title: "Full ticket",
      description: "Has everything",
      priority: 5,
      status: "pending",
      complete: true,
      acceptanceCriteria: ["Criterion A"],
      metadata: { key: "value" },
    });

    expect(result.id).toBe("t-4");
    expect(result.title).toBe("Full ticket");
    expect(result.priority).toBe(5);
    expect(result.status).toBe("pending");
    expect(result.complete).toBe(true);
    expect(result.acceptanceCriteria).toEqual(["Criterion A"]);
    expect(result.metadata).toEqual({ key: "value" });
  });
});

// =============================================================================
// Schema: TicketsFileSchema parses YAML content with `complete` tickets
// =============================================================================

describe("TicketsFileSchema with complete tickets", () => {
  it("parses a tickets file containing tickets with complete: true", () => {
    const input = {
      tickets: [
        {
          id: "done-1",
          title: "Finished work",
          description: "This was already done",
          complete: true,
        },
        {
          id: "todo-1",
          title: "Pending work",
          description: "This still needs doing",
        },
      ],
    };

    const result = TicketsFileSchema.parse(input);

    expect(result.tickets).toHaveLength(2);
    expect(result.tickets[0]?.complete).toBe(true);
    expect(result.tickets[1]?.complete).toBe(false);
  });

  it("handles a file where all tickets are complete", () => {
    const input = {
      tickets: [
        {
          id: "done-a",
          title: "Done A",
          description: "Finished A",
          complete: true,
        },
        {
          id: "done-b",
          title: "Done B",
          description: "Finished B",
          complete: true,
        },
      ],
    };

    const result = TicketsFileSchema.parse(input);

    expect(result.tickets.every((t) => t.complete === true)).toBe(true);
  });
});

// =============================================================================
// Filtering: tickets with `complete: true` are excluded from processing
// =============================================================================

describe("Ticket filtering excludes complete tickets", () => {
  it("filters out tickets with complete: true even when status is pending", () => {
    const tickets = [
      createTicket({ id: "a", complete: true, status: "pending" }),
      createTicket({ id: "b", complete: false, status: "pending" }),
    ];

    const processable = filterProcessableTickets(tickets);

    expect(processable).toHaveLength(1);
    expect(processable[0]?.id).toBe("b");
  });

  it("includes tickets without complete field (backward compatibility)", () => {
    const ticket = createTicket({ id: "legacy" });

    const processable = filterProcessableTickets([ticket]);

    expect(processable).toHaveLength(1);
    expect(processable[0]?.id).toBe("legacy");
  });

  it("includes tickets with complete: false", () => {
    const ticket = createTicket({ id: "not-done", complete: false });

    const processable = filterProcessableTickets([ticket]);

    expect(processable).toHaveLength(1);
    expect(processable[0]?.id).toBe("not-done");
  });

  it("filters correctly in a mixed queue of complete and incomplete tickets", () => {
    const tickets = [
      createTicket({ id: "done-1", complete: true }),
      createTicket({ id: "pending-1", complete: false }),
      createTicket({ id: "done-2", complete: true }),
      createTicket({ id: "pending-2" }),
      createTicket({ id: "also-done", complete: true }),
    ];

    const processable = filterProcessableTickets(tickets);

    const processableIds = processable.map((t) => t.id);
    expect(processableIds).toEqual(["pending-1", "pending-2"]);
  });

  it("still respects status-based filtering alongside complete", () => {
    const tickets = [
      createTicket({ id: "already-running", status: "executing", complete: false }),
      createTicket({ id: "ready", status: "pending", complete: false }),
      createTicket({ id: "done-pending", status: "pending", complete: true }),
    ];

    const processable = filterProcessableTickets(tickets);

    expect(processable).toHaveLength(1);
    expect(processable[0]?.id).toBe("ready");
  });

  it("returns empty array when all pending tickets are complete", () => {
    const tickets = [
      createTicket({ id: "c1", complete: true }),
      createTicket({ id: "c2", complete: true }),
    ];

    const processable = filterProcessableTickets(tickets);

    expect(processable).toHaveLength(0);
  });
});

// =============================================================================
// YAML write-back: markTicketCompleteInFile
// =============================================================================

describe("markTicketCompleteInFile", () => {
  let testDir: string;
  let yamlPath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-completion-test-"));
    yamlPath = join(testDir, "tickets.yaml");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("adds complete: true to the matching ticket in the YAML file", async () => {
    const yaml = [
      "tickets:",
      "  - id: t-1",
      "    title: First ticket",
      "    description: Do something",
      "  - id: t-2",
      "    title: Second ticket",
      "    description: Do another thing",
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await markTicketCompleteInFile(yamlPath, "t-1");

    const updated = await readFile(yamlPath, "utf-8");
    expect(updated).toContain("complete: true");
    expect(updated).toMatch(/id: t-1[\s\S]*?complete: true/);
  });

  it("does not modify other tickets", async () => {
    const yaml = [
      "tickets:",
      "  - id: target",
      "    title: Target ticket",
      "    description: Mark this one",
      "  - id: bystander",
      "    title: Bystander ticket",
      "    description: Leave this one alone",
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await markTicketCompleteInFile(yamlPath, "target");

    const updated = await readFile(yamlPath, "utf-8");
    const bystanderSection = updated.slice(updated.indexOf("id: bystander"));
    expect(bystanderSection).not.toContain("complete: true");
  });

  it("preserves YAML comments", async () => {
    const yaml = [
      "# Top-level comment",
      "tickets:",
      "  # Comment above ticket",
      "  - id: commented",
      "    title: Commented ticket",
      "    description: Has comments around it",
      "  # Another comment",
      "  - id: other",
      "    title: Other ticket",
      "    description: Also present",
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await markTicketCompleteInFile(yamlPath, "commented");

    const updated = await readFile(yamlPath, "utf-8");
    expect(updated).toContain("# Top-level comment");
    expect(updated).toContain("# Comment above ticket");
    expect(updated).toContain("# Another comment");
  });

  it("preserves all other fields and their values", async () => {
    const yaml = [
      "tickets:",
      "  - id: full-ticket",
      "    title: Full ticket",
      "    description: Has many fields",
      "    priority: 10",
      "    status: pending",
      '    acceptanceCriteria: ["AC1", "AC2"]',
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await markTicketCompleteInFile(yamlPath, "full-ticket");

    const updated = await readFile(yamlPath, "utf-8");
    expect(updated).toContain("id: full-ticket");
    expect(updated).toContain("title: Full ticket");
    expect(updated).toContain("description: Has many fields");
    expect(updated).toContain("priority: 10");
    expect(updated).toContain("status: pending");
    expect(updated).toContain("complete: true");
  });

  it("is idempotent - calling twice does not break anything", async () => {
    const yaml = [
      "tickets:",
      "  - id: idem",
      "    title: Idempotent ticket",
      "    description: Call twice",
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await markTicketCompleteInFile(yamlPath, "idem");
    const afterFirst = await readFile(yamlPath, "utf-8");

    await markTicketCompleteInFile(yamlPath, "idem");
    const afterSecond = await readFile(yamlPath, "utf-8");

    expect(afterFirst).toBe(afterSecond);

    const completeOccurrences = (afterSecond.match(/complete: true/g) ?? []).length;
    expect(completeOccurrences).toBe(1);
  });

  it("handles ticket ID not found gracefully without throwing", async () => {
    const yaml = [
      "tickets:",
      "  - id: existing",
      "    title: Existing ticket",
      "    description: Present in file",
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await expect(
      markTicketCompleteInFile(yamlPath, "nonexistent")
    ).resolves.not.toThrow();

    const unchanged = await readFile(yamlPath, "utf-8");
    expect(unchanged).not.toContain("complete: true");
  });

  it("preserves formatting when ticket already has complete: false", async () => {
    const yaml = [
      "tickets:",
      "  - id: was-false",
      "    title: Was false",
      "    description: Had complete false",
      "    complete: false",
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await markTicketCompleteInFile(yamlPath, "was-false");

    const updated = await readFile(yamlPath, "utf-8");
    expect(updated).toContain("complete: true");
    expect(updated).not.toContain("complete: false");
  });

  it("works with a single-ticket file", async () => {
    const yaml = [
      "tickets:",
      "  - id: solo",
      "    title: Only ticket",
      "    description: Single ticket in file",
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await markTicketCompleteInFile(yamlPath, "solo");

    const updated = await readFile(yamlPath, "utf-8");
    expect(updated).toContain("complete: true");
  });

  it("works with config and hooks sections present", async () => {
    const yaml = [
      "config:",
      "  autoApprove: true",
      "  maxRetries: 3",
      "",
      "hooks:",
      "  beforeAll:",
      "    - type: prompt",
      "      command: /clear",
      "",
      "tickets:",
      "  - id: with-config",
      "    title: Config present",
      "    description: File has config and hooks",
    ].join("\n");

    await writeFile(yamlPath, yaml, "utf-8");

    await markTicketCompleteInFile(yamlPath, "with-config");

    const updated = await readFile(yamlPath, "utf-8");
    expect(updated).toContain("config:");
    expect(updated).toContain("autoApprove: true");
    expect(updated).toContain("hooks:");
    expect(updated).toContain("complete: true");
  });
});
