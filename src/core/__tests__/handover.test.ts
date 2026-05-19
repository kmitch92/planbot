import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentProvider,
  ExecutionCallbacks,
  ProviderOptions,
  StreamEvent,
} from "../types/agent-provider.js";
import type { PlanbotPaths } from "../state.js";
import type { Ticket } from "../schemas.js";
import { TicketSchema } from "../schemas.js";

// The module under test does NOT yet exist — these imports must fail at
// module-load time, which causes vitest to report every test in this file
// as failed. This is the expected RED state.
import {
  buildDebriefPrompt,
  generateDebrief,
  buildPriorWorkContext,
} from "../handover.js";

vi.mock("../../utils/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setContext: vi.fn(),
    clearContext: vi.fn(),
  },
}));

// ============================================================================
// Test fixtures
// ============================================================================

function buildTicket(overrides: Partial<Ticket> = {}): Ticket {
  return TicketSchema.parse({
    id: "ticket-handover-1",
    title: "Implement handover debrief flow",
    description: "Wire generateDebrief into the orchestrator post-execution.",
    ...overrides,
  });
}

function buildPaths(root: string): PlanbotPaths {
  const planbotRoot = join(root, ".planbot");
  return {
    root: planbotRoot,
    state: join(planbotRoot, "state.json"),
    plans: join(planbotRoot, "plans"),
    questions: join(planbotRoot, "questions"),
    sessions: join(planbotRoot, "sessions"),
    assets: join(planbotRoot, "assets"),
    logs: join(planbotRoot, "logs"),
    debriefs: join(planbotRoot, "debriefs"),
    pid: join(planbotRoot, "planbot.pid"),
  };
}

interface ResumeMockConfig {
  // Markdown chunks to emit as assistant events.
  chunks?: string[];
  // Result to resolve with.
  result?: { success: boolean; error?: string; sessionId?: string };
}

function createResumingProvider(config: ResumeMockConfig = {}): AgentProvider {
  const chunks = config.chunks ?? ["# Debrief\n\nSome content."];
  const result = config.result ?? { success: true };

  const resume = vi.fn(
    async (
      _sessionId: string,
      _input: string,
      _options: ProviderOptions,
      callbacks: ExecutionCallbacks,
    ) => {
      for (const chunk of chunks) {
        const event: StreamEvent = { type: "assistant", message: chunk };
        callbacks.onEvent?.(event);
      }
      return result;
    },
  );

  return {
    metadata: { name: "mock", supportedModels: ["mock-model"] },
    generatePlan: vi.fn(async () => ({ success: true })),
    execute: vi.fn(async () => ({ success: true })),
    resume,
    answerQuestion: vi.fn(),
    abort: vi.fn(),
    runPrompt: vi.fn(async () => ({ success: true })),
    getRateLimitResetsAt: vi.fn(() => null),
    clearRateLimitResetsAt: vi.fn(),
  };
}

// ============================================================================
// buildDebriefPrompt
// ============================================================================

describe("buildDebriefPrompt", () => {
  it("includes a section reference to files created or modified", () => {
    const ticket = buildTicket();

    const prompt = buildDebriefPrompt(ticket);

    expect(prompt.toLowerCase()).toMatch(/files (created|modified|changed)/);
  });

  it("includes a section reference to decisions taken", () => {
    const ticket = buildTicket();

    const prompt = buildDebriefPrompt(ticket);

    expect(prompt.toLowerCase()).toContain("decision");
  });

  it("includes a section reference to dead ends or approaches tried", () => {
    const ticket = buildTicket();

    const prompt = buildDebriefPrompt(ticket);

    const lowered = prompt.toLowerCase();
    const mentionsDeadEnds =
      lowered.includes("dead end") ||
      lowered.includes("approaches tried") ||
      lowered.includes("approach tried") ||
      lowered.includes("rejected") ||
      lowered.includes("attempted");

    expect(mentionsDeadEnds).toBe(true);
  });

  it("includes a section reference to gotchas or surprises", () => {
    const ticket = buildTicket();

    const prompt = buildDebriefPrompt(ticket);

    const lowered = prompt.toLowerCase();
    const mentionsSurprises =
      lowered.includes("gotcha") ||
      lowered.includes("surprise") ||
      lowered.includes("unexpected");

    expect(mentionsSurprises).toBe(true);
  });

  it("includes a section reference to open questions or limitations", () => {
    const ticket = buildTicket();

    const prompt = buildDebriefPrompt(ticket);

    const lowered = prompt.toLowerCase();
    const mentionsOpen =
      lowered.includes("open question") ||
      lowered.includes("limitation") ||
      lowered.includes("known issue") ||
      lowered.includes("unresolved");

    expect(mentionsOpen).toBe(true);
  });

  it("does NOT instruct the agent to use Write/Edit/file-writing tools — harness writes the file", () => {
    const ticket = buildTicket();

    const prompt = buildDebriefPrompt(ticket);

    // The harness writes the file from the returned response. The agent must
    // respond with markdown, not invoke file-writing tools.
    expect(prompt).not.toMatch(/\bWrite tool\b/i);
    expect(prompt).not.toMatch(/\buse the Write tool\b/i);
    expect(prompt).not.toMatch(/\bEdit tool\b/i);
    expect(prompt).not.toMatch(/\bwrite (it|the debrief) to (a |the )?file\b/i);
    expect(prompt).not.toMatch(/\bsave (it|the debrief) to (a |the )?file\b/i);
  });

  it("includes the ticket id in the prompt", () => {
    const ticket = buildTicket({ id: "TICKET-DEBRIEF-42" });

    const prompt = buildDebriefPrompt(ticket);

    expect(prompt).toContain("TICKET-DEBRIEF-42");
  });

  it("includes the ticket title in the prompt", () => {
    const ticket = buildTicket({
      title: "Wire verify-loop into orchestrator",
    });

    const prompt = buildDebriefPrompt(ticket);

    expect(prompt).toContain("Wire verify-loop into orchestrator");
  });

  it("includes a length or conciseness guideline", () => {
    const ticket = buildTicket();

    const prompt = buildDebriefPrompt(ticket);

    const lowered = prompt.toLowerCase();
    const mentionsLength =
      lowered.includes("concise") ||
      lowered.includes("brief") ||
      lowered.includes("short") ||
      /under\s+\d+\s+words/.test(lowered) ||
      /\d+\s+words/.test(lowered);

    expect(mentionsLength).toBe(true);
  });
});

// ============================================================================
// generateDebrief
// ============================================================================

describe("generateDebrief", () => {
  let testDir: string;
  let paths: PlanbotPaths;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "planbot-handover-test-"));
    paths = buildPaths(testDir);
    // Pre-create the debriefs dir — generateDebrief writes into it.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(paths.debriefs, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("calls provider.resume with the supplied session id", async () => {
    const provider = createResumingProvider();
    const ticket = buildTicket({ id: "ticket-resume-call" });

    await generateDebrief({
      ticket,
      sessionId: "session-xyz-789",
      provider,
      cwd: testDir,
      paths,
      timeout: 60000,
    });

    expect(provider.resume).toHaveBeenCalledTimes(1);
    const call = (provider.resume as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call?.[0]).toBe("session-xyz-789");
  });

  it("passes timeout, cwd, and verbose through to provider.resume options", async () => {
    const provider = createResumingProvider();
    const ticket = buildTicket({ id: "ticket-options-passthrough" });

    await generateDebrief({
      ticket,
      sessionId: "session-opts",
      provider,
      cwd: "/some/abs/cwd",
      paths,
      timeout: 45000,
      verbose: true,
    });

    const call = (provider.resume as ReturnType<typeof vi.fn>).mock.calls[0];
    const options = call?.[2] as ProviderOptions;

    expect(options.timeout).toBe(45000);
    expect(options.cwd).toBe("/some/abs/cwd");
    expect(options.verbose).toBe(true);
  });

  it("writes the captured debrief markdown to <paths.debriefs>/<ticketId>.md", async () => {
    const provider = createResumingProvider({
      chunks: ["# Handover debrief\n\nWritten the auth module."],
    });
    const ticket = buildTicket({ id: "ticket-write-path" });

    await generateDebrief({
      ticket,
      sessionId: "session-write",
      provider,
      cwd: testDir,
      paths,
      timeout: 30000,
    });

    const expectedPath = join(paths.debriefs, "ticket-write-path.md");
    await expect(access(expectedPath)).resolves.toBeUndefined();
    const written = await readFile(expectedPath, "utf-8");
    expect(written).toContain("Handover debrief");
    expect(written).toContain("Written the auth module.");
  });

  it("returns { success: true, path, bytesWritten } on the happy path", async () => {
    const content = "# Done\n\nSome details about the work.";
    const provider = createResumingProvider({ chunks: [content] });
    const ticket = buildTicket({ id: "ticket-result-shape" });

    const result = await generateDebrief({
      ticket,
      sessionId: "session-result",
      provider,
      cwd: testDir,
      paths,
      timeout: 30000,
    });

    expect(result.success).toBe(true);
    expect(result.path).toBe(join(paths.debriefs, "ticket-result-shape.md"));
    expect(typeof result.bytesWritten).toBe("number");
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it("returns provider failure and does NOT write a file", async () => {
    const provider = createResumingProvider({
      chunks: [],
      result: { success: false, error: "rate limit" },
    });
    const ticket = buildTicket({ id: "ticket-provider-fail" });

    const result = await generateDebrief({
      ticket,
      sessionId: "session-fail",
      provider,
      cwd: testDir,
      paths,
      timeout: 30000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("rate limit");

    const expectedPath = join(paths.debriefs, "ticket-provider-fail.md");
    await expect(access(expectedPath)).rejects.toThrow();
  });

  it("returns failure and does NOT write a file when no assistant events are emitted", async () => {
    const provider = createResumingProvider({
      chunks: [],
      result: { success: true },
    });
    const ticket = buildTicket({ id: "ticket-empty-response" });

    const result = await generateDebrief({
      ticket,
      sessionId: "session-empty",
      provider,
      cwd: testDir,
      paths,
      timeout: 30000,
    });

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error?.toLowerCase()).toMatch(/empty|no.*content|no.*response/);

    const expectedPath = join(paths.debriefs, "ticket-empty-response.md");
    await expect(access(expectedPath)).rejects.toThrow();
  });

  it("rejects unsafe ticket ids (path traversal) without writing a file", async () => {
    // The Zod TicketSchema does not block path-traversal characters, so we
    // bypass it here to assert the handover-layer guard. The schema cap on id
    // length (max 100) allows arbitrary string content.
    const ticket = { ...buildTicket(), id: "../etc/passwd" } as Ticket;
    const provider = createResumingProvider();

    const result = await generateDebrief({
      ticket,
      sessionId: "session-bad-id",
      provider,
      cwd: testDir,
      paths,
      timeout: 30000,
    });

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error?.toLowerCase()).toMatch(/invalid|path|ticket id/);

    // No file with the unsafe id should have been created anywhere.
    const safePath = join(paths.debriefs, "..", "etc", "passwd");
    await expect(access(safePath)).rejects.toThrow();
  });

  it("rejects ticket ids containing forward slashes without writing a file", async () => {
    const ticket = { ...buildTicket(), id: "foo/bar" } as Ticket;
    const provider = createResumingProvider();

    const result = await generateDebrief({
      ticket,
      sessionId: "session-slash-id",
      provider,
      cwd: testDir,
      paths,
      timeout: 30000,
    });

    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error?.toLowerCase()).toMatch(/invalid|path|ticket id/);
  });

  it("accumulates multiple assistant event chunks into a single debrief file", async () => {
    const provider = createResumingProvider({
      chunks: [
        "# Handover debrief\n\n",
        "## Files modified\n- src/foo.ts\n\n",
        "## Decisions\n- Used a queue.\n",
      ],
    });
    const ticket = buildTicket({ id: "ticket-multi-chunk" });

    const result = await generateDebrief({
      ticket,
      sessionId: "session-chunks",
      provider,
      cwd: testDir,
      paths,
      timeout: 30000,
    });

    expect(result.success).toBe(true);

    const written = await readFile(
      join(paths.debriefs, "ticket-multi-chunk.md"),
      "utf-8",
    );

    expect(written).toContain("Handover debrief");
    expect(written).toContain("Files modified");
    expect(written).toContain("src/foo.ts");
    expect(written).toContain("Decisions");
    expect(written).toContain("Used a queue.");
  });
});

// ============================================================================
// buildPriorWorkContext
// ============================================================================

describe("buildPriorWorkContext", () => {
  function makePaths(): PlanbotPaths {
    return buildPaths("/abs/project");
  }

  it("returns an empty string when no tickets have been completed", () => {
    const out = buildPriorWorkContext({
      completedTicketIds: [],
      paths: makePaths(),
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: 1,
      totalTickets: 5,
    });

    expect(out).toBe("");
  });

  it("includes a human-readable 'ticket N of M' header using 1-based numbering", () => {
    const out = buildPriorWorkContext({
      completedTicketIds: ["a", "b"],
      paths: makePaths(),
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: 3,
      totalTickets: 7,
    });

    expect(out.toLowerCase()).toContain("ticket 3 of 7");
  });

  it("lists at most 5 ticket ids when maxListed is not provided", () => {
    const completed = ["a", "b", "c", "d", "e", "f", "g"];

    const out = buildPriorWorkContext({
      completedTicketIds: completed,
      paths: makePaths(),
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: completed.length + 1,
      totalTickets: completed.length + 1,
    });

    // Count lines that look like bullet entries for ticket ids of the
    // single-letter ids used here.
    const bulletLines = out
      .split("\n")
      .filter((line) => /^[-*]\s+[a-z][a-z0-9_-]*\b/i.test(line));

    expect(bulletLines).toHaveLength(5);

    // Oldest ids must NOT appear when truncated.
    expect(out).not.toMatch(/(^|[\s/-])a(\b|:)/);
    expect(out).not.toMatch(/(^|[\s/-])b(\b|:)/);

    // Most recent ids MUST appear.
    expect(out).toContain("c");
    expect(out).toContain("d");
    expect(out).toContain("e");
    expect(out).toContain("f");
    expect(out).toContain("g");
  });

  it("includes the absolute path to the tickets file", () => {
    const out = buildPriorWorkContext({
      completedTicketIds: ["one"],
      paths: makePaths(),
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: 2,
      totalTickets: 3,
    });

    expect(out).toContain("/abs/project/tickets.yaml");
  });

  it("includes the absolute path to the debriefs directory", () => {
    const paths = makePaths();

    const out = buildPriorWorkContext({
      completedTicketIds: ["one"],
      paths,
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: 2,
      totalTickets: 3,
    });

    expect(out).toContain(paths.debriefs);
  });

  it("includes a debrief file path for each listed ticket id", () => {
    const paths = makePaths();
    const completed = ["alpha", "beta", "gamma"];

    const out = buildPriorWorkContext({
      completedTicketIds: completed,
      paths,
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: completed.length + 1,
      totalTickets: completed.length + 1,
    });

    for (const id of completed) {
      expect(out).toContain(join(paths.debriefs, `${id}.md`));
    }
  });

  it("hints that the agent can list the debriefs directory for older debriefs", () => {
    const out = buildPriorWorkContext({
      completedTicketIds: ["a", "b", "c", "d", "e", "f"],
      paths: makePaths(),
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: 7,
      totalTickets: 7,
    });

    const lowered = out.toLowerCase();
    const mentionsOlder =
      lowered.includes("older debrief") ||
      lowered.includes("list the") ||
      lowered.includes("list directory") ||
      lowered.includes("older");

    expect(mentionsOlder).toBe(true);
  });

  it("honours a maxListed override (only lists 2 when maxListed=2)", () => {
    const paths = makePaths();
    const completed = ["a", "b", "c", "d"];

    const out = buildPriorWorkContext({
      completedTicketIds: completed,
      paths,
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: 5,
      totalTickets: 5,
      maxListed: 2,
    });

    const bulletLines = out
      .split("\n")
      .filter((line) => /^[-*]\s+[a-z][a-z0-9_-]*\b/i.test(line));

    expect(bulletLines).toHaveLength(2);

    // Older two ids must NOT appear as bullet entries.
    const hasA = bulletLines.some((line) => /\ba\b/.test(line));
    const hasB = bulletLines.some((line) => /\bb\b/.test(line));
    expect(hasA).toBe(false);
    expect(hasB).toBe(false);
  });

  it("emits a compact pointer-only block (under 2 KB) with 5 ticket ids", () => {
    const paths = makePaths();
    const completed = ["alpha", "bravo", "charlie", "delta", "echo"];

    const out = buildPriorWorkContext({
      completedTicketIds: completed,
      paths,
      ticketsFilePath: "/abs/project/tickets.yaml",
      currentTicketIndex: 6,
      totalTickets: 6,
    });

    // Pointer-only guarantee: no inlined debrief content, so the block stays
    // roughly constant-size regardless of how many tickets have completed.
    expect(out.length).toBeLessThan(2048);
  });
});
