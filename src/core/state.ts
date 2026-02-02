import { join } from 'node:path';
import {
  readJsonFile,
  writeJsonFile,
  ensureDir,
  fileExists,
  readTextFile,
  writeTextFile,
  appendToFile,
} from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import {
  type State,
  type StateInput,
  type PendingQuestion,
  createDefaultState,
  parseStateFile,
} from './schemas.js';

// =============================================================================
// Path Management
// =============================================================================

/**
 * Paths to various .planbot subdirectories and files
 */
export interface PlanbotPaths {
  /** .planbot/ */
  root: string;
  /** .planbot/state.json */
  state: string;
  /** .planbot/plans/ */
  plans: string;
  /** .planbot/logs/ */
  logs: string;
  /** .planbot/questions/ */
  questions: string;
  /** .planbot/sessions/ */
  sessions: string;
}

/**
 * Get paths to all .planbot subdirectories and files
 */
function getPaths(projectRoot: string): PlanbotPaths {
  const root = join(projectRoot, '.planbot');
  return {
    root,
    state: join(root, 'state.json'),
    plans: join(root, 'plans'),
    logs: join(root, 'logs'),
    questions: join(root, 'questions'),
    sessions: join(root, 'sessions'),
  };
}

// =============================================================================
// State Manager Interface
// =============================================================================

export interface StateManager {
  /** Initialize .planbot directory structure */
  init(projectRoot: string): Promise<void>;

  /** Load state from .planbot/state.json (creates default if missing) */
  load(projectRoot: string): Promise<State>;

  /** Save state atomically */
  save(projectRoot: string, state: State): Promise<void>;

  /** Update specific fields and save */
  update(projectRoot: string, updates: Partial<StateInput>): Promise<State>;

  /** Get paths to various .planbot subdirectories/files */
  getPaths(projectRoot: string): PlanbotPaths;

  /** Save a plan for a ticket */
  savePlan(projectRoot: string, ticketId: string, plan: string): Promise<string>;

  /** Load a plan for a ticket */
  loadPlan(projectRoot: string, ticketId: string): Promise<string | null>;

  /** Append to ticket log */
  appendLog(projectRoot: string, ticketId: string, entry: string): Promise<void>;

  /** Save pending question */
  addPendingQuestion(projectRoot: string, question: PendingQuestion): Promise<void>;

  /** Remove pending question (when answered) */
  removePendingQuestion(projectRoot: string, questionId: string): Promise<void>;

  /** Get all pending questions */
  getPendingQuestions(projectRoot: string): Promise<PendingQuestion[]>;

  /** Save session ID for a ticket */
  saveSession(projectRoot: string, ticketId: string, sessionId: string): Promise<void>;

  /** Load session ID for a ticket */
  loadSession(projectRoot: string, ticketId: string): Promise<string | null>;

  /** Clear all state (reset) */
  clear(projectRoot: string): Promise<void>;

  /** Check if .planbot exists and is valid */
  exists(projectRoot: string): Promise<boolean>;
}

// =============================================================================
// State Manager Implementation
// =============================================================================

function createStateManager(): StateManager {
  return {
    async init(projectRoot: string): Promise<void> {
      const paths = getPaths(projectRoot);
      logger.debug('Initializing .planbot directory', { path: paths.root });

      await ensureDir(paths.root);
      await ensureDir(paths.plans);
      await ensureDir(paths.logs);
      await ensureDir(paths.questions);
      await ensureDir(paths.sessions);

      // Create default state if it doesn't exist
      if (!(await fileExists(paths.state))) {
        const defaultState = createDefaultState();
        await writeJsonFile(paths.state, defaultState);
        logger.debug('Created default state file', { path: paths.state });
      }

      logger.debug('Initialized .planbot directory structure');
    },

    async load(projectRoot: string): Promise<State> {
      const paths = getPaths(projectRoot);
      logger.debug('Loading state', { path: paths.state });

      if (!(await fileExists(paths.state))) {
        logger.debug('State file not found, creating default');
        const defaultState = createDefaultState();
        await ensureDir(paths.root);
        await writeJsonFile(paths.state, defaultState);
        return defaultState;
      }

      const raw = await readJsonFile<unknown>(paths.state);
      const state = parseStateFile(raw);
      logger.debug('Loaded state', { phase: state.currentPhase, ticketId: state.currentTicketId });
      return state;
    },

    async save(projectRoot: string, state: State): Promise<void> {
      const paths = getPaths(projectRoot);
      logger.debug('Saving state', { path: paths.state });

      // Update lastUpdatedAt timestamp
      const updatedState: State = {
        ...state,
        lastUpdatedAt: new Date().toISOString(),
      };

      await ensureDir(paths.root);
      await writeJsonFile(paths.state, updatedState);
      logger.debug('State saved', { lastUpdatedAt: updatedState.lastUpdatedAt });
    },

    async update(projectRoot: string, updates: Partial<StateInput>): Promise<State> {
      logger.debug('Updating state', { updates: Object.keys(updates) });

      // Re-read state to handle concurrent access
      const currentState = await this.load(projectRoot);

      const updatedState: State = {
        ...currentState,
        ...updates,
        lastUpdatedAt: new Date().toISOString(),
      };

      await this.save(projectRoot, updatedState);
      return updatedState;
    },

    getPaths(projectRoot: string): PlanbotPaths {
      return getPaths(projectRoot);
    },

    async savePlan(projectRoot: string, ticketId: string, plan: string): Promise<string> {
      const paths = getPaths(projectRoot);
      const planPath = join(paths.plans, `${ticketId}.md`);
      logger.debug('Saving plan', { ticketId, path: planPath });

      await ensureDir(paths.plans);
      await writeTextFile(planPath, plan);
      logger.debug('Plan saved', { ticketId });
      return planPath;
    },

    async loadPlan(projectRoot: string, ticketId: string): Promise<string | null> {
      const paths = getPaths(projectRoot);
      const planPath = join(paths.plans, `${ticketId}.md`);
      logger.debug('Loading plan', { ticketId, path: planPath });

      if (!(await fileExists(planPath))) {
        logger.debug('Plan not found', { ticketId });
        return null;
      }

      const plan = await readTextFile(planPath);
      logger.debug('Plan loaded', { ticketId, length: plan.length });
      return plan;
    },

    async appendLog(projectRoot: string, ticketId: string, entry: string): Promise<void> {
      const paths = getPaths(projectRoot);
      const logPath = join(paths.logs, `${ticketId}.log`);
      logger.debug('Appending to log', { ticketId, path: logPath });

      const timestamp = new Date().toISOString();
      const formattedEntry = `[${timestamp}] ${entry}\n`;

      await appendToFile(logPath, formattedEntry);
      logger.debug('Log entry appended', { ticketId });
    },

    async addPendingQuestion(projectRoot: string, question: PendingQuestion): Promise<void> {
      logger.debug('Adding pending question', { questionId: question.id, ticketId: question.ticketId });

      // Re-read state for concurrent access
      const state = await this.load(projectRoot);

      // Avoid duplicates
      const exists = state.pendingQuestions.some((q) => q.id === question.id);
      if (exists) {
        logger.debug('Question already exists', { questionId: question.id });
        return;
      }

      const updatedQuestions = [...state.pendingQuestions, question];
      await this.update(projectRoot, { pendingQuestions: updatedQuestions });
      logger.debug('Pending question added', { questionId: question.id });
    },

    async removePendingQuestion(projectRoot: string, questionId: string): Promise<void> {
      logger.debug('Removing pending question', { questionId });

      // Re-read state for concurrent access
      const state = await this.load(projectRoot);

      const updatedQuestions = state.pendingQuestions.filter((q) => q.id !== questionId);

      if (updatedQuestions.length === state.pendingQuestions.length) {
        logger.debug('Question not found', { questionId });
        return;
      }

      await this.update(projectRoot, { pendingQuestions: updatedQuestions });
      logger.debug('Pending question removed', { questionId });
    },

    async getPendingQuestions(projectRoot: string): Promise<PendingQuestion[]> {
      logger.debug('Getting pending questions');
      const state = await this.load(projectRoot);
      logger.debug('Retrieved pending questions', { count: state.pendingQuestions.length });
      return state.pendingQuestions;
    },

    async saveSession(projectRoot: string, ticketId: string, sessionId: string): Promise<void> {
      const paths = getPaths(projectRoot);
      const sessionPath = join(paths.sessions, `${ticketId}.txt`);
      logger.debug('Saving session', { ticketId, sessionPath });

      await ensureDir(paths.sessions);
      await writeTextFile(sessionPath, sessionId);
      logger.debug('Session saved', { ticketId });
    },

    async loadSession(projectRoot: string, ticketId: string): Promise<string | null> {
      const paths = getPaths(projectRoot);
      const sessionPath = join(paths.sessions, `${ticketId}.txt`);
      logger.debug('Loading session', { ticketId, sessionPath });

      if (!(await fileExists(sessionPath))) {
        logger.debug('Session not found', { ticketId });
        return null;
      }

      const sessionId = (await readTextFile(sessionPath)).trim();
      logger.debug('Session loaded', { ticketId });
      return sessionId;
    },

    async clear(projectRoot: string): Promise<void> {
      const paths = getPaths(projectRoot);
      logger.debug('Clearing state', { path: paths.root });

      // Remove all contents by recreating with fresh state
      const { rm } = await import('node:fs/promises');

      try {
        await rm(paths.root, { recursive: true, force: true });
      } catch {
        // Directory might not exist, ignore
      }

      // Reinitialize with fresh state
      await this.init(projectRoot);
      logger.debug('State cleared and reinitialized');
    },

    async exists(projectRoot: string): Promise<boolean> {
      const paths = getPaths(projectRoot);
      logger.debug('Checking if .planbot exists', { path: paths.root });

      const rootExists = await fileExists(paths.root);
      if (!rootExists) {
        logger.debug('.planbot directory does not exist');
        return false;
      }

      const stateExists = await fileExists(paths.state);
      if (!stateExists) {
        logger.debug('.planbot/state.json does not exist');
        return false;
      }

      // Validate state file is parseable
      try {
        const raw = await readJsonFile<unknown>(paths.state);
        parseStateFile(raw);
        logger.debug('.planbot exists and is valid');
        return true;
      } catch (err) {
        logger.debug('.planbot/state.json is invalid', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
  };
}

// =============================================================================
// Default Export
// =============================================================================

/**
 * Default StateManager instance
 */
export const stateManager: StateManager = createStateManager();
