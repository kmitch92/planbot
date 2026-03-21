import { interruptibleDelay } from "../interruptible-delay.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("interruptibleDelay", () => {
  describe("full delay completion", () => {
    it("completes with completed: true when shouldInterrupt never fires", async () => {
      const promise = interruptibleDelay({
        durationMs: 5000,
        shouldInterrupt: () => false,
      });

      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;

      expect(result.completed).toBe(true);
      expect(result.interrupted).toBe(false);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(5000);
    });
  });

  describe("early interrupt", () => {
    it("stops early when shouldInterrupt returns true", async () => {
      let callCount = 0;
      const promise = interruptibleDelay({
        durationMs: 5000,
        shouldInterrupt: () => {
          callCount++;
          return callCount > 2;
        },
        pollIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(5000);

      const result = await promise;

      expect(result.completed).toBe(false);
      expect(result.interrupted).toBe(true);
      expect(result.elapsedMs).toBeLessThan(5000);
    });
  });

  describe("onTick callback", () => {
    it("fires each poll interval with correct elapsed and remaining values", async () => {
      const onTick = vi.fn();

      const promise = interruptibleDelay({
        durationMs: 3000,
        shouldInterrupt: () => false,
        onTick,
        pollIntervalMs: 1000,
      });

      await vi.advanceTimersByTimeAsync(3000);
      await promise;

      expect(onTick).toHaveBeenCalledTimes(3);

      expect(onTick).toHaveBeenNthCalledWith(1, 1000, 2000);
      expect(onTick).toHaveBeenNthCalledWith(2, 2000, 1000);
      expect(onTick).toHaveBeenNthCalledWith(3, 3000, 0);
    });
  });

  describe("zero-duration edge case", () => {
    it("returns immediately with completed: true and elapsedMs: 0", async () => {
      const result = await interruptibleDelay({
        durationMs: 0,
        shouldInterrupt: () => false,
      });

      expect(result).toEqual({
        completed: true,
        interrupted: false,
        elapsedMs: 0,
      });
    });
  });

  describe("custom poll interval", () => {
    it("checks more frequently with a shorter pollIntervalMs", async () => {
      const shouldInterrupt = vi.fn().mockReturnValue(false);

      const promise = interruptibleDelay({
        durationMs: 2000,
        shouldInterrupt,
        pollIntervalMs: 500,
      });

      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(shouldInterrupt.mock.calls.length).toBeGreaterThanOrEqual(4);
    });
  });
});
