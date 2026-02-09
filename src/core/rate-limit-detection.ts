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
