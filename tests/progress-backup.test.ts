import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProgressBackup,
  buildProgressBackup,
  findActiveSessionConflicts,
  HISTORY_CAP,
  NARRATION_PREFERENCES_KEY,
  parseAndValidateBackup,
  parseSessionCsv,
} from "../app/progress-backup";
import { examConfigs } from "../app/question-bank";

function createMemoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    dump: () => Object.fromEntries(map.entries()),
  };
}

test("exports and validates a multi-exam JSON progress backup", () => {
  const sourceStorage = createMemoryStorage({
    [examConfigs.cts.historyKey]: JSON.stringify([
      {
        id: "2026-11-16T10:00:00.000Z",
        completedAt: "2026-11-16T10:30:00.000Z",
        mode: "exam",
        questions: 20,
        answered: 20,
        correct: 17,
        percent: 85,
        duty: "all",
        examId: "cts",
      },
    ]),
    [examConfigs["cts-i"].storageKey]: JSON.stringify({
      examId: "cts-i",
      mode: "study",
      currentIndex: 1,
      answers: { 1: 2 },
      flagged: [1],
      checked: [1],
      timeLeft: 1200,
      shuffleOn: true,
      questionIds: [1, 2, 3],
      sessionSize: 20,
      sessionDuty: "all",
      sessionSeed: "AB12CD34",
      attemptStartedAt: "2026-11-17T08:00:00.000Z",
    }),
    [NARRATION_PREFERENCES_KEY]: JSON.stringify({ enabled: true, autoRead: false, rate: 1.15 }),
  });

  const backup = buildProgressBackup(sourceStorage);
  assert.equal(backup.schemaVersion, 1);
  assert.equal(backup.exams.cts.history.length, 1);
  assert.equal(backup.exams["cts-i"].activeSession?.questionIds.length, 3);
  assert.equal(backup.narration?.rate, 1.15);

  const parsed = parseAndValidateBackup(JSON.stringify(backup));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.backup.exams.cts.history[0].percent, 85);
  assert.deepEqual(parsed.backup.exams["cts-i"].activeSession?.flagged, [1]);
});

test("rejects malformed backup payloads and drops invalid active sessions", () => {
  const badJson = parseAndValidateBackup("{not-json");
  assert.equal(badJson.ok, false);

  const wrongApp = parseAndValidateBackup(JSON.stringify({ schemaVersion: 1, app: "other", exams: {} }));
  assert.equal(wrongApp.ok, false);

  const invalidSession = parseAndValidateBackup(JSON.stringify({
    schemaVersion: 1,
    exportedAt: "2026-11-17T08:00:00.000Z",
    app: "aureum-study-hall",
    exams: {
      cts: {
        history: [],
        activeSession: {
          mode: "exam",
          currentIndex: 0,
          answers: {},
          flagged: [],
          checked: [],
          timeLeft: 100,
          shuffleOn: false,
          questionIds: [999999],
          sessionSize: 20,
          sessionDuty: "all",
          sessionSeed: "BAD",
          attemptStartedAt: "2026-11-17T08:00:00.000Z",
        },
      },
    },
    narration: null,
  }));
  assert.equal(invalidSession.ok, true);
  if (!invalidSession.ok) return;
  assert.equal(invalidSession.backup.exams.cts.activeSession, null);
});

test("merges attempt histories without duplicates and detects active session conflicts", () => {
  const sharedAttempt = {
    id: "att-1",
    completedAt: "2026-11-15T10:00:00.000Z",
    mode: "exam" as const,
    questions: 20,
    answered: 20,
    correct: 15,
    percent: 75,
    duty: "all" as const,
    examId: "cts" as const,
  };
  const newerAttempt = {
    id: "att-2",
    completedAt: "2026-11-17T09:00:00.000Z",
    mode: "study" as const,
    questions: 20,
    answered: 20,
    correct: 19,
    percent: 95,
    duty: "A" as const,
    examId: "cts" as const,
  };

  const targetStorage = createMemoryStorage({
    [examConfigs.cts.historyKey]: JSON.stringify([sharedAttempt]),
    [examConfigs.cts.storageKey]: JSON.stringify({
      mode: "exam",
      currentIndex: 0,
      answers: {},
      flagged: [],
      checked: [],
      timeLeft: 900,
      shuffleOn: false,
      questionIds: [1, 2],
      sessionSize: 20,
      sessionDuty: "all",
      sessionSeed: "LOCAL123",
      attemptStartedAt: "2026-11-17T08:30:00.000Z",
    }),
  });

  const parsed = parseAndValidateBackup(JSON.stringify({
    schemaVersion: 1,
    exportedAt: "2026-11-17T09:05:00.000Z",
    app: "aureum-study-hall",
    exams: {
      cts: {
        history: [sharedAttempt, newerAttempt],
        activeSession: {
          mode: "study",
          currentIndex: 1,
          answers: { 1: 0 },
          flagged: [],
          checked: [],
          timeLeft: 500,
          shuffleOn: true,
          questionIds: [1, 2, 3],
          sessionSize: 20,
          sessionDuty: "all",
          sessionSeed: "IMPORT99",
          attemptStartedAt: "2026-11-17T09:00:00.000Z",
        },
      },
    },
    narration: null,
  }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.deepEqual(findActiveSessionConflicts(parsed.backup, targetStorage), ["cts"]);

  const safeMerge = applyProgressBackup(parsed.backup, targetStorage, { overwriteActiveSessions: false });
  assert.equal(safeMerge.attemptsAdded, 1);
  assert.equal(safeMerge.sessionsRestored, 0);
  assert.deepEqual(safeMerge.conflictingSessions, ["cts"]);
  const mergedHistory = JSON.parse(targetStorage.getItem(examConfigs.cts.historyKey)!);
  assert.equal(mergedHistory.length, 2);
  assert.equal(mergedHistory[0].id, "att-2");
  assert.ok(HISTORY_CAP >= 50);

  const overwriteMerge = applyProgressBackup(parsed.backup, targetStorage, { overwriteActiveSessions: true });
  assert.equal(overwriteMerge.sessionsRestored, 1);
  const restoredSession = JSON.parse(targetStorage.getItem(examConfigs.cts.storageKey)!);
  assert.equal(restoredSession.sessionSeed, "IMPORT99");
});

test("reconstructs a completed session and AttemptSummary from an exported CSV report", () => {
  const q1 = examConfigs["cts-d"].questions.find((q) => q.type === "single")!;
  const q2 = examConfigs["cts-d"].questions.find((q) => q.type === "single" && q.id !== q1.id)!;
  const wrongChoiceIndex = q2.choices!.findIndex((_, index) => index !== Number(q2.answer));

  const escapeCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const csv = [
    "Position,Question ID,Exam area,Task,Topic,Your response,Best answer,Result,Source",
    [1, q1.id, q1.domain, q1.task, q1.topic, q1.choices![Number(q1.answer)], q1.choices![Number(q1.answer)], "Correct", q1.source].map(escapeCell).join(","),
    [2, q2.id, q2.domain, q2.task, q2.topic, q2.choices![wrongChoiceIndex], q2.choices![Number(q2.answer)], "Review", q2.source].map(escapeCell).join(","),
  ].join("\n");

  const parsed = parseSessionCsv(csv, "aureum-cts-d-study-report-2026-11-17.csv");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.result.examId, "cts-d");
  assert.deepEqual(parsed.result.questionIds, [q1.id, q2.id]);
  assert.equal(parsed.result.answers[q1.id], Number(q1.answer));
  assert.equal(parsed.result.answers[q2.id], wrongChoiceIndex);
  assert.equal(parsed.result.summary.correct, 1);
  assert.equal(parsed.result.summary.percent, 50);

  const invalidCsv = parseSessionCsv("Name,Score\nAlice,100");
  assert.equal(invalidCsv.ok, false);
});
