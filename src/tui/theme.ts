/**
 * TUI design constants and theme definitions.
 *
 * Pure data module with no runtime dependencies.
 * All values use `as const` for maximum type inference.
 */

// ---------------------------------------------------------------------------
// Box drawing characters
// ---------------------------------------------------------------------------

export const BOX = {
  topLeft: "\u256D",
  topRight: "\u256E",
  bottomLeft: "\u2570",
  bottomRight: "\u256F",
  horizontal: "\u2500",
  vertical: "\u2502",
  teeLeft: "\u251C",
  teeRight: "\u2524",
} as const;

// ---------------------------------------------------------------------------
// Status icons — covers every TicketStatus value from core/schemas.ts
// ---------------------------------------------------------------------------

export const STATUS_ICONS = {
  pending: { icon: "\u25CB", color: "gray" },
  planning: { icon: "\u25D0", color: "blue" },
  awaiting_approval: { icon: "\u25D1", color: "yellow" },
  approved: { icon: "\u25D5", color: "cyan" },
  executing: { icon: "\u25D0", color: "blue" },
  completed: { icon: "\u2713", color: "green" },
  failed: { icon: "\u2717", color: "red" },
  skipped: { icon: "\u2212", color: "yellow" },
} as const;

export type StatusColor = (typeof STATUS_ICONS)[keyof typeof STATUS_ICONS]["color"];

// ---------------------------------------------------------------------------
// Semantic color palette (chalk / Ink compatible color strings)
// ---------------------------------------------------------------------------

export const COLORS = {
  primary: "cyan",
  secondary: "blue",
  success: "green",
  warning: "yellow",
  error: "red",
  muted: "gray",
  accent: "magenta",
  text: "white",
} as const;

// ---------------------------------------------------------------------------
// Priority level colors
// ---------------------------------------------------------------------------

export const PRIORITY_COLORS: Record<number, string> = {
  0: "gray",
  1: "cyan",
  2: "yellow",
  3: "red",
};

export function getPriorityColor(priority: number): string {
  return PRIORITY_COLORS[priority] ?? (priority > 3 ? "red" : "gray");
}

// ---------------------------------------------------------------------------
// Key binding labels for status bar / help display
// ---------------------------------------------------------------------------

export const KEYBINDS = {
  back: "ESC Back",
  select: "ENTER Select",
  quit: "q Quit",
  scrollUp: "\u2191/k Up",
  scrollDown: "\u2193/j Down",
  filter: "f Filter",
  help: "? Help",
} as const;
