import { BaseQuestion, Domain, EXAM_ORDER, ExamConfig, examConfigs, ExamId } from "./question-bank";

export type AnswerValue = number | number[] | string | string[] | null;
export type Mode = "exam" | "study";
export type SessionSize = 20 | 60 | 75 | 115 | 300;
export type SessionDuty = "all" | Domain;

export type AttemptSummary = {
  id: string;
  completedAt: string;
  mode: Mode;
  questions: number;
  answered: number;
  correct: number;
  percent: number;
  duty: SessionDuty;
  examId?: ExamId;
};

export type SavedSession = {
  examId?: ExamId;
  mode: Mode;
  currentIndex: number;
  answers: Record<number, AnswerValue>;
  flagged: number[];
  checked: number[];
  timeLeft: number;
  shuffleOn: boolean;
  questionIds: number[];
  sessionSize: SessionSize;
  sessionDuty: SessionDuty;
  sessionSeed: string;
  attemptStartedAt: string;
};

export type NarrationPreferences = {
  enabled: boolean;
  autoRead: boolean;
  rate: number;
};

export type ExamProgressSnapshot = {
  history: AttemptSummary[];
  activeSession: SavedSession | null;
};

export type ProgressBackupV1 = {
  schemaVersion: 1;
  exportedAt: string;
  app: "aureum-study-hall";
  exams: Record<ExamId, ExamProgressSnapshot>;
  narration: NarrationPreferences | null;
};

export type BackupMergeResult = {
  attemptsAdded: number;
  sessionsRestored: number;
  examsUpdated: ExamId[];
  narrationUpdated: boolean;
  conflictingSessions: ExamId[];
};

export type CsvRestoreResult = {
  examId: ExamId;
  summary: AttemptSummary;
  questionIds: number[];
  answers: Record<number, AnswerValue>;
  matchedResponses: number;
};

export const HISTORY_CAP = 50;
export const NARRATION_PREFERENCES_KEY = "aureum-study-hall-cts-narration-v1";
export const PROGRESS_IMPORTED_EVENT = "aureum-progress-imported";

const VALID_SESSION_SIZES = new Set<number>([20, 60, 75, 115, 300]);
const VALID_NARRATION_RATES = new Set<number>([0.85, 1, 1.15]);

export type StorageReader = Pick<Storage, "getItem">;
export type StorageReadWriter = Pick<Storage, "getItem" | "setItem">;

/**
 * Validates that a candidate question order contains unique, valid IDs for the target exam.
 */
export function validQuestionOrder(
  value: unknown,
  lookup: Map<number, BaseQuestion>,
  maxLen: number,
): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= maxLen
    && new Set(value).size === value.length
    && value.every((id) => typeof id === "number" && lookup.has(id));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeAttempt(raw: unknown, examConfig: ExamConfig): AttemptSummary | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (typeof raw.completedAt !== "string" || Number.isNaN(Date.parse(raw.completedAt))) return null;
  const mode: Mode = raw.mode === "study" ? "study" : raw.mode === "exam" ? "exam" : "study";
  const questionsCount = Number(raw.questions);
  const answeredCount = Number(raw.answered);
  const correctCount = Number(raw.correct);
  const percent = Number(raw.percent);
  if (
    !Number.isFinite(questionsCount) || questionsCount <= 0
    || !Number.isFinite(answeredCount) || answeredCount < 0
    || !Number.isFinite(correctCount) || correctCount < 0
    || !Number.isFinite(percent) || percent < 0 || percent > 100
  ) {
    return null;
  }
  const duty: SessionDuty = raw.duty === "all" || (typeof raw.duty === "string" && examConfig.domains.includes(raw.duty as Domain))
    ? (raw.duty as SessionDuty)
    : "all";
  return {
    id: raw.id,
    completedAt: raw.completedAt,
    mode,
    questions: Math.round(questionsCount),
    answered: Math.min(Math.round(questionsCount), Math.round(answeredCount)),
    correct: Math.min(Math.round(questionsCount), Math.round(correctCount)),
    percent: Math.round(percent),
    duty,
    examId: examConfig.id,
  };
}

function sanitizeSavedSession(
  raw: unknown,
  examConfig: ExamConfig,
  lookup: Map<number, BaseQuestion>,
): SavedSession | null {
  if (!isPlainObject(raw)) return null;
  if (!validQuestionOrder(raw.questionIds, lookup, examConfig.allQuestions.length)) return null;
  const questionSet = new Set(raw.questionIds);
  const safeIndex = Math.max(0, Math.min(raw.questionIds.length - 1, Math.floor(Number(raw.currentIndex) || 0)));

  const answers: Record<number, AnswerValue> = {};
  if (isPlainObject(raw.answers)) {
    for (const [key, val] of Object.entries(raw.answers)) {
      const id = Number(key);
      if (Number.isInteger(id) && questionSet.has(id) && val !== undefined) {
        answers[id] = val as AnswerValue;
      }
    }
  }

  const filterIds = (list: unknown) => Array.isArray(list)
    ? Array.from(new Set(list.filter((id): id is number => typeof id === "number" && questionSet.has(id))))
    : [];

  const rawSize = Number(raw.sessionSize);
  const sessionSize: SessionSize = VALID_SESSION_SIZES.has(rawSize) ? (rawSize as SessionSize) : 115;
  const sessionDuty: SessionDuty = raw.sessionDuty === "all"
    || (typeof raw.sessionDuty === "string" && examConfig.domains.includes(raw.sessionDuty as Domain))
    ? (raw.sessionDuty as SessionDuty)
    : "all";

  return {
    examId: examConfig.id,
    mode: raw.mode === "study" ? "study" : "exam",
    currentIndex: safeIndex,
    answers,
    flagged: filterIds(raw.flagged),
    checked: filterIds(raw.checked),
    timeLeft: typeof raw.timeLeft === "number" && Number.isFinite(raw.timeLeft) && raw.timeLeft >= 0
      ? Math.round(raw.timeLeft)
      : 0,
    shuffleOn: Boolean(raw.shuffleOn),
    questionIds: [...raw.questionIds],
    sessionSize,
    sessionDuty,
    sessionSeed: typeof raw.sessionSeed === "string" ? raw.sessionSeed : "",
    attemptStartedAt: typeof raw.attemptStartedAt === "string" ? raw.attemptStartedAt : new Date().toISOString(),
  };
}

function sanitizeNarration(raw: unknown): NarrationPreferences | null {
  if (!isPlainObject(raw)) return null;
  const rate = Number(raw.rate);
  return {
    enabled: Boolean(raw.enabled),
    autoRead: Boolean(raw.autoRead),
    rate: VALID_NARRATION_RATES.has(rate) ? rate : 1,
  };
}

function readJson(storage: StorageReader, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Serializes attempt history, active sessions, and narration settings across all exams.
 */
export function buildProgressBackup(storage: StorageReader): ProgressBackupV1 {
  const exams = {} as Record<ExamId, ExamProgressSnapshot>;
  for (const examId of EXAM_ORDER) {
    const config = examConfigs[examId];
    const lookup = new Map(config.allQuestions.map((q) => [q.id, q]));
    const rawHistory = readJson(storage, config.historyKey);
    const history = Array.isArray(rawHistory)
      ? rawHistory.map((item) => sanitizeAttempt(item, config)).filter((item): item is AttemptSummary => Boolean(item))
      : [];
    const activeSession = sanitizeSavedSession(readJson(storage, config.storageKey), config, lookup);
    exams[examId] = { history: history.slice(0, HISTORY_CAP), activeSession };
  }
  const narration = sanitizeNarration(readJson(storage, NARRATION_PREFERENCES_KEY));
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    app: "aureum-study-hall",
    exams,
    narration,
  };
}

/**
 * Parses and validates an exported JSON progress backup file.
 */
export function parseAndValidateBackup(
  rawText: string,
): { ok: true; backup: ProgressBackupV1 } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, error: "Could not read this file as valid JSON." };
  }
  if (!isPlainObject(parsed) || parsed.app !== "aureum-study-hall" || parsed.schemaVersion !== 1) {
    return { ok: false, error: "This file is not a valid Aureum Study Hall progress backup." };
  }
  if (!isPlainObject(parsed.exams)) {
    return { ok: false, error: "Backup file is missing exam progress data." };
  }

  const exams = {} as Record<ExamId, ExamProgressSnapshot>;
  for (const examId of EXAM_ORDER) {
    const config = examConfigs[examId];
    const lookup = new Map(config.allQuestions.map((q) => [q.id, q]));
    const rawExam = parsed.exams[examId];
    if (!isPlainObject(rawExam)) {
      exams[examId] = { history: [], activeSession: null };
      continue;
    }
    const history = Array.isArray(rawExam.history)
      ? rawExam.history.map((item) => sanitizeAttempt(item, config)).filter((item): item is AttemptSummary => Boolean(item))
      : [];
    const activeSession = sanitizeSavedSession(rawExam.activeSession, config, lookup);
    exams[examId] = { history: history.slice(0, HISTORY_CAP), activeSession };
  }

  const narration = sanitizeNarration(parsed.narration);
  return {
    ok: true,
    backup: {
      schemaVersion: 1,
      exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
      app: "aureum-study-hall",
      exams,
      narration,
    },
  };
}

/**
 * Merges two attempt lists, deduplicating by attempt ID and sorting newest first.
 */
export function mergeAttemptHistory(existing: AttemptSummary[], incoming: AttemptSummary[]): {
  merged: AttemptSummary[];
  added: number;
} {
  const byId = new Map<string, AttemptSummary>();
  for (const item of existing) byId.set(item.id, item);
  let added = 0;
  for (const item of incoming) {
    if (!byId.has(item.id)) {
      added += 1;
      byId.set(item.id, item);
    }
  }
  const merged = [...byId.values()]
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, HISTORY_CAP);
  return { merged, added };
}

/**
 * Returns exams where both the backup and the target browser hold an active saved session.
 */
export function findActiveSessionConflicts(backup: ProgressBackupV1, storage: StorageReader): ExamId[] {
  const conflicts: ExamId[] = [];
  for (const examId of EXAM_ORDER) {
    if (!backup.exams[examId].activeSession) continue;
    const config = examConfigs[examId];
    const lookup = new Map(config.allQuestions.map((q) => [q.id, q]));
    const existing = sanitizeSavedSession(readJson(storage, config.storageKey), config, lookup);
    if (existing) conflicts.push(examId);
  }
  return conflicts;
}

/**
 * Applies a validated backup into localStorage, merging history and restoring sessions.
 */
export function applyProgressBackup(
  backup: ProgressBackupV1,
  storage: StorageReadWriter,
  options: { overwriteActiveSessions?: boolean } = {},
): BackupMergeResult {
  let attemptsAdded = 0;
  let sessionsRestored = 0;
  const examsUpdated = new Set<ExamId>();
  const conflictingSessions: ExamId[] = [];

  for (const examId of EXAM_ORDER) {
    const config = examConfigs[examId];
    const lookup = new Map(config.allQuestions.map((q) => [q.id, q]));
    const incoming = backup.exams[examId];

    if (incoming.history.length > 0) {
      const rawExisting = readJson(storage, config.historyKey);
      const existingHistory = Array.isArray(rawExisting)
        ? rawExisting.map((item) => sanitizeAttempt(item, config)).filter((item): item is AttemptSummary => Boolean(item))
        : [];
      const { merged, added } = mergeAttemptHistory(existingHistory, incoming.history);
      if (added > 0 || existingHistory.length !== merged.length) {
        storage.setItem(config.historyKey, JSON.stringify(merged));
        attemptsAdded += added;
        examsUpdated.add(examId);
      }
    }

    if (incoming.activeSession) {
      const existingSession = sanitizeSavedSession(readJson(storage, config.storageKey), config, lookup);
      if (!existingSession || options.overwriteActiveSessions) {
        storage.setItem(config.storageKey, JSON.stringify(incoming.activeSession));
        sessionsRestored += 1;
        examsUpdated.add(examId);
      } else {
        conflictingSessions.push(examId);
      }
    }
  }

  let narrationUpdated = false;
  if (backup.narration) {
    storage.setItem(NARRATION_PREFERENCES_KEY, JSON.stringify(backup.narration));
    narrationUpdated = true;
  }

  return {
    attemptsAdded,
    sessionsRestored,
    examsUpdated: [...examsUpdated],
    narrationUpdated,
    conflictingSessions,
  };
}

/**
 * Parses RFC-4180 CSV text into rows of cell strings.
 */
function parseCsvRows(csvText: string): string[][] {
  const clean = csvText.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.length > 0)) rows.push(row);
  return rows;
}

function inferExamFromCsv(
  rows: Array<{ id: number; task: string; topic: string }>,
  filenameHint = "",
): ExamId {
  const lower = filenameHint.toLowerCase();
  if (lower.includes("cts-i")) return "cts-i";
  if (lower.includes("cts-d")) return "cts-d";
  if (lower.includes("-cts-")) return "cts";

  let bestExam: ExamId = "cts";
  let bestScore = -1;
  for (const examId of EXAM_ORDER) {
    const lookup = new Map(examConfigs[examId].allQuestions.map((q) => [q.id, q]));
    let score = 0;
    for (const row of rows) {
      const q = lookup.get(row.id);
      if (!q) continue;
      score += 1;
      if (row.topic && q.topic === row.topic) score += 3;
      if (row.task && q.task === row.task) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestExam = examId;
    }
  }
  return bestExam;
}

function reconstructAnswer(question: BaseQuestion, responseText: string, resultText: string): AnswerValue {
  const trimmed = responseText.trim();
  if (!trimmed || /^unanswered$/i.test(trimmed)) return null;

  if (question.type === "single" || question.type === "connect") {
    const idx = question.choices?.findIndex((choice) => choice.trim() === trimmed) ?? -1;
    if (idx >= 0) return question.type === "connect" ? String(idx) : idx;
    if (/^correct$/i.test(resultText.trim()) && question.answer !== undefined) {
      return question.answer as AnswerValue;
    }
    return null;
  }

  if (question.type === "hotspot") {
    const spot = question.hotspots?.find((item) => item.label.trim() === trimmed);
    if (spot) return spot.id;
    if (/^correct$/i.test(resultText.trim()) && typeof question.answer === "string") {
      return question.answer;
    }
    return null;
  }

  if (question.type === "multi") {
    const parts = trimmed.split(/\s*;\s*/).filter(Boolean);
    const indices = parts
      .map((part) => question.choices?.findIndex((choice) => choice.trim() === part) ?? -1)
      .filter((idx) => idx >= 0);
    if (indices.length > 0) return indices;
    if (/^correct$/i.test(resultText.trim()) && Array.isArray(question.answer)) {
      return [...(question.answer as number[])];
    }
    return null;
  }

  if (question.type === "order") {
    const steps = trimmed.split(/\s*(?:→|->)\s*/).filter(Boolean);
    if (steps.length > 0) return steps;
    return null;
  }

  if (question.type === "numeric") {
    const match = trimmed.match(/-?\d+(?:\.\d+)?/);
    return match ? match[0] : null;
  }

  return null;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Reconstructs a completed session report and AttemptSummary from an exported CSV report.
 */
export function parseSessionCsv(
  csvText: string,
  filenameHint = "",
): { ok: true; result: CsvRestoreResult } | { ok: false; error: string } {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return { ok: false, error: "CSV file has no question rows to import." };
  }
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const idIdx = header.indexOf("question id");
  const respIdx = header.indexOf("your response");
  const resultIdx = header.indexOf("result");
  const taskIdx = header.indexOf("task");
  const topicIdx = header.indexOf("topic");

  if (idIdx < 0 || respIdx < 0 || resultIdx < 0) {
    return { ok: false, error: "CSV headers do not match an Aureum Study Hall session report." };
  }

  const parsedRows = rows.slice(1).map((cols) => ({
    id: Number(cols[idIdx]),
    task: taskIdx >= 0 ? (cols[taskIdx] ?? "").trim() : "",
    topic: topicIdx >= 0 ? (cols[topicIdx] ?? "").trim() : "",
    response: cols[respIdx] ?? "",
    result: cols[resultIdx] ?? "",
  })).filter((row) => Number.isInteger(row.id) && row.id > 0);

  if (parsedRows.length === 0) {
    return { ok: false, error: "No valid question IDs were found in this CSV report." };
  }

  const examId = inferExamFromCsv(parsedRows, filenameHint);
  const config = examConfigs[examId];
  const lookup = new Map(config.allQuestions.map((q) => [q.id, q]));

  const questionIds: number[] = [];
  const seen = new Set<number>();
  const answers: Record<number, AnswerValue> = {};
  let answeredCount = 0;
  let correctCount = 0;
  let matchedResponses = 0;
  const domains = new Set<Domain>();

  for (const row of parsedRows) {
    const question = lookup.get(row.id);
    if (!question || seen.has(row.id)) continue;
    seen.add(row.id);
    questionIds.push(row.id);
    domains.add(question.domain);

    const parsedAnswer = reconstructAnswer(question, row.response, row.result);
    if (parsedAnswer !== null) {
      answers[row.id] = parsedAnswer;
      matchedResponses += 1;
    }
    if (row.response.trim() && !/^unanswered$/i.test(row.response.trim())) {
      answeredCount += 1;
    }
    if (/^correct$/i.test(row.result.trim())) {
      correctCount += 1;
    }
  }

  if (questionIds.length === 0) {
    return { ok: false, error: "None of the question IDs in this CSV matched the question bank." };
  }

  const dateMatch = filenameHint.match(/(\d{4}-\d{2}-\d{2})/);
  const completedAt = dateMatch ? `${dateMatch[1]}T12:00:00.000Z` : new Date().toISOString();
  const duty: SessionDuty = domains.size === 1 ? [...domains][0] : "all";
  const summary: AttemptSummary = {
    id: `csv-${examId}-${dateMatch ? dateMatch[1] : "upload"}-${stableHash(csvText)}`,
    completedAt,
    mode: "study",
    questions: questionIds.length,
    answered: answeredCount,
    correct: correctCount,
    percent: Math.round((correctCount / questionIds.length) * 100),
    duty,
    examId,
  };

  return {
    ok: true,
    result: {
      examId,
      summary,
      questionIds,
      answers,
      matchedResponses,
    },
  };
}
