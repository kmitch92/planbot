import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ZodError } from "zod";
import { createStartCommand } from "../commands/start.js";

// =============================================================================
// Module Mocks
// =============================================================================

vi.mock("ora", () => ({
  default: () => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn(),
    fail: vi.fn(),
    text: "",
  }),
}));

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

vi.mock("../../core/orchestrator.js", () => ({
  createOrchestrator: vi.fn(),
}));

vi.mock("../../core/state.js", () => ({
  stateManager: {
    exists: vi.fn(),
    init: vi.fn(),
  },
}));

vi.mock("../../core/schemas.js", () => ({
  parseTicketsFile: vi.fn(),
  validateTicketDependencies: vi.fn(),
  resolveEnvVars: vi.fn(),
}));

vi.mock("../../messaging/index.js", () => ({
  createMultiplexer: vi.fn(),
  createTelegramProvider: vi.fn(),
  TimeoutError: class TimeoutError extends Error {},
}));

vi.mock("../../messaging/terminal.js", () => ({
  createTerminalProvider: vi.fn(),
}));

vi.mock("../../utils/fs.js", () => ({
  fileExists: vi.fn(),
}));

// =============================================================================
// Autonomous Mode Safety Interlock
// =============================================================================

describe("Autonomous Mode Safety Interlock", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("process.exit called");
      }) as never);
    consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("rejects when both --skip-permissions and --auto-approve are set without risk acknowledgment", async () => {
    const command = createStartCommand();

    await expect(
      command.parseAsync(
        ["node", "planbot", "tickets.yaml", "--skip-permissions", "--auto-approve"],
        { from: "user" }
      )
    ).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("proceeds when --i-accept-autonomous-risk is also set", async () => {
    const command = createStartCommand();

    const safetyInterlockExitCalls: number[] = [];

    exitSpy.mockRestore();
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit called with ${code}`);
      }) as never);

    let thrownError: Error | undefined;
    try {
      await command.parseAsync(
        [
          "node",
          "planbot",
          "tickets.yaml",
          "--skip-permissions",
          "--auto-approve",
          "--i-accept-autonomous-risk",
        ],
        { from: "user" }
      );
    } catch (err) {
      thrownError = err as Error;
    }

    const consoleErrorCalls = consoleErrorSpy.mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    const hasAutonomousRejection =
      consoleErrorCalls.includes("autonomous") ||
      consoleErrorCalls.includes("--i-accept-autonomous-risk") ||
      consoleErrorCalls.includes("safety interlock");

    expect(hasAutonomousRejection).toBe(false);
  });

  it("proceeds when only --skip-permissions is set", async () => {
    const command = createStartCommand();

    let thrownError: Error | undefined;
    try {
      await command.parseAsync(
        ["node", "planbot", "tickets.yaml", "--skip-permissions"],
        { from: "user" }
      );
    } catch (err) {
      thrownError = err as Error;
    }

    const consoleErrorCalls = consoleErrorSpy.mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    const hasAutonomousRejection =
      consoleErrorCalls.includes("autonomous") ||
      consoleErrorCalls.includes("--i-accept-autonomous-risk") ||
      consoleErrorCalls.includes("safety interlock");

    expect(hasAutonomousRejection).toBe(false);
  });

  it("proceeds when only --auto-approve is set", async () => {
    const command = createStartCommand();

    let thrownError: Error | undefined;
    try {
      await command.parseAsync(
        ["node", "planbot", "tickets.yaml", "--auto-approve"],
        { from: "user" }
      );
    } catch (err) {
      thrownError = err as Error;
    }

    const consoleErrorCalls = consoleErrorSpy.mock.calls
      .map((call) => call.join(" "))
      .join("\n");
    const hasAutonomousRejection =
      consoleErrorCalls.includes("autonomous") ||
      consoleErrorCalls.includes("--i-accept-autonomous-risk") ||
      consoleErrorCalls.includes("safety interlock");

    expect(hasAutonomousRejection).toBe(false);
  });
});

// =============================================================================
// skipPermissions YAML Override Protection
// =============================================================================

describe("skipPermissions YAML override protection", () => {
  const minimalTicket = {
    id: "test",
    title: "Test",
    description: "Test desc",
  };

  it("rejects skipPermissions: true in YAML config", async () => {
    const { parseTicketsFile } = await vi.importActual<
      typeof import("../../core/schemas.js")
    >("../../core/schemas.js");

    expect(() =>
      parseTicketsFile({
        config: { skipPermissions: true },
        tickets: [minimalTicket],
      })
    ).toThrow(ZodError);
  });

  it("accepts skipPermissions: false in YAML config", async () => {
    const { parseTicketsFile } = await vi.importActual<
      typeof import("../../core/schemas.js")
    >("../../core/schemas.js");

    const result = parseTicketsFile({
      config: { skipPermissions: false },
      tickets: [minimalTicket],
    });

    expect(result.config.skipPermissions).toBe(false);
  });

  it("accepts config without skipPermissions and defaults to false", async () => {
    const { parseTicketsFile } = await vi.importActual<
      typeof import("../../core/schemas.js")
    >("../../core/schemas.js");

    const result = parseTicketsFile({
      config: {},
      tickets: [minimalTicket],
    });

    expect(result.config.skipPermissions).toBe(false);
  });
});
