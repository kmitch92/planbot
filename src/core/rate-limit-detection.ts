/**
 * Rate limit detection utilities for Claude API error handling.
 *
 * This module provides functions to detect when Claude has hit rate/usage limits
 * and determine when to fall back to alternative models.
 */

/**
 * Input for rate limit detection.
 */
export interface RateLimitCheckInput {
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Cost of the operation in USD */
  costUsd?: number;
  /** Length of output returned (character count) */
  outputLength?: number;
}

/**
 * Detects if a Claude API error indicates a rate limit or usage limit has been hit.
 *
 * Uses two detection strategies:
 *
 * 1. **Explicit Detection**: Scans error message for rate/usage limit keywords
 *    - "hit your limit" (case insensitive)
 *    - "usage limit" (case insensitive)
 *    - "rate limit" (case insensitive)
 *
 * 2. **Heuristic Detection**: Identifies likely rate limits based on failure characteristics
 *    - Operation failed (success === false)
 *    - Low or zero cost (< $0.01 USD)
 *    - Short or no output (< 500 characters)
 *    - Error message present
 *
 *    Rationale: Rate limit errors typically occur early in request processing before
 *    significant tokens are consumed or output is generated.
 *
 * @param result - The result of a Claude API operation
 * @returns true if rate/usage limit detected, false otherwise
 *
 * @example
 * ```typescript
 * // Explicit rate limit message
 * isRateLimitError({
 *   success: false,
 *   error: "You have hit your limit for Claude API usage"
 * }); // true
 *
 * // Heuristic detection: early failure with minimal cost
 * isRateLimitError({
 *   success: false,
 *   error: "Request failed",
 *   costUsd: 0.001,
 *   outputLength: 100
 * }); // true
 *
 * // Not a rate limit: expensive operation that failed
 * isRateLimitError({
 *   success: false,
 *   error: "Connection timeout",
 *   costUsd: 0.15,
 *   outputLength: 5000
 * }); // false
 * ```
 */
export function isRateLimitError(result: RateLimitCheckInput): boolean {
  // Explicit detection: Check error message for rate/usage limit keywords
  if (result.error) {
    const errorLower = result.error.toLowerCase();
    if (
      errorLower.includes("hit your limit") ||
      errorLower.includes("usage limit") ||
      errorLower.includes("rate limit")
    ) {
      return true;
    }
  }

  // Heuristic detection: Early failure with minimal resource consumption
  // Indicates request was likely rejected before processing
  const failedWithError = !result.success && result.error !== undefined;
  const lowCost = (result.costUsd ?? 0) < 0.01;
  const shortOutput = (result.outputLength ?? 0) < 500;

  return failedWithError && lowCost && shortOutput;
}

/**
 * Determines if fallback to an alternative model should be attempted.
 *
 * Returns true when:
 * - Current model is different from fallback model (case sensitive comparison)
 * - Current model is undefined (treats undefined as distinct from any named model)
 *
 * Returns false when:
 * - Current model equals fallback model (no point falling back to same model)
 *
 * This function should be called after detecting a rate limit error to determine
 * if switching models is a viable recovery strategy.
 *
 * @param currentModel - The model that hit the rate limit (undefined if not set)
 * @param fallbackModel - The fallback model to potentially switch to
 * @returns true if fallback should be attempted, false otherwise
 *
 * @example
 * ```typescript
 * // Should fallback: different models
 * shouldFallback("claude-opus-4", "claude-sonnet-4"); // true
 *
 * // Should not fallback: same model
 * shouldFallback("claude-opus-4", "claude-opus-4"); // false
 *
 * // Should fallback: undefined treated as different
 * shouldFallback(undefined, "claude-sonnet-4"); // true
 *
 * // Edge case: fallback to undefined (unusual but valid)
 * shouldFallback("claude-opus-4", undefined as any); // true
 * ```
 */
export function shouldFallback(
  currentModel: string | undefined,
  fallbackModel: string
): boolean {
  return currentModel !== fallbackModel;
}

/**
 * Input for calculating how long to wait before retrying after a rate limit.
 */
export interface RateLimitWaitInput {
  /** Epoch seconds when the rate limit resets, or null if unknown */
  resetsAt: number | null;
  /** Maximum time in ms the caller is willing to wait */
  maxWaitTimeMs: number;
  /** Buffer in ms added after reset time to avoid edge-case failures */
  retryBufferMs: number;
  /** Fallback delay in ms when no reset time is available */
  fallbackDelayMs: number;
}

/**
 * Result of rate limit wait calculation.
 */
export interface RateLimitWaitResult {
  /** Whether the caller should wait and retry */
  shouldWait: boolean;
  /** How long to wait in ms (0 if shouldWait is false) */
  waitMs: number;
  /** Human-readable explanation of the decision */
  reason: string;
}

/**
 * Calculates how long to wait before retrying after hitting a rate limit.
 *
 * Decision logic:
 * 1. If resetsAt is null, uses fallbackDelayMs (unless it exceeds maxWaitTimeMs)
 * 2. If resetsAt is in the past or exactly now, waits only the retryBufferMs
 * 3. If resetsAt is in the future, waits (delta + retryBufferMs) if within maxWaitTimeMs
 *
 * @param input - Rate limit wait parameters
 * @returns Whether to wait, how long, and why
 */
export function calculateRateLimitWait(
  input: RateLimitWaitInput
): RateLimitWaitResult {
  const { resetsAt, maxWaitTimeMs, retryBufferMs, fallbackDelayMs } = input;

  // No resetsAt available — use fallback delay
  if (resetsAt == null) {
    if (fallbackDelayMs > maxWaitTimeMs) {
      return {
        shouldWait: false,
        waitMs: 0,
        reason: "Fallback delay exceeds max wait time",
      };
    }
    return {
      shouldWait: true,
      waitMs: fallbackDelayMs,
      reason: "No reset time available, using fallback delay",
    };
  }

  // Convert resetsAt (epoch seconds) to ms and compute delta
  const resetsAtMs = resetsAt * 1000;
  const now = Date.now();
  const deltaMs = resetsAtMs - now;

  // resetsAt is in the past or exactly now — just wait the buffer
  if (deltaMs <= 0) {
    return {
      shouldWait: true,
      waitMs: retryBufferMs,
      reason: "Reset time already passed, waiting retry buffer",
    };
  }

  // resetsAt is in the future — check if within max wait
  const totalWaitMs = deltaMs + retryBufferMs;
  if (totalWaitMs > maxWaitTimeMs) {
    return {
      shouldWait: false,
      waitMs: 0,
      reason: "Wait time exceeds maximum allowed",
    };
  }

  return {
    shouldWait: true,
    waitMs: totalWaitMs,
    reason: "Waiting for rate limit reset",
  };
}
