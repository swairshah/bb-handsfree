import test from "node:test";
import assert from "node:assert/strict";
import {
  THREAD_ERROR_EVENT_TYPES,
  THREAD_OUTCOME_EVENT_TYPES,
  latestThreadError,
  latestThreadOutcome,
} from "./thread-errors.ts";

test("finds the provider error behind a newer failed lifecycle event", () => {
  const error = latestThreadError([
    {
      type: "turn/completed",
      seq: 12,
      createdAt: 1200,
      data: { status: "failed" },
    },
    {
      type: "provider/error",
      seq: 11,
      createdAt: 1100,
      data: {
        message: "Provider error",
        detail:
          "OAuth refresh failed for anthropic: Refresh token expired; stack=Error: hidden stack",
        errorInfo: {
          category: "unauthorized",
          httpStatusCode: 400,
          providerCode: "invalid_grant",
        },
      },
    },
  ]);

  assert.deepEqual(error, {
    type: "provider/error",
    message: "Provider error",
    detail: "OAuth refresh failed for anthropic: Refresh token expired",
    sequence: 11,
    createdAt: 1100,
    category: "unauthorized",
    providerCode: "invalid_grant",
    httpStatusCode: 400,
  });
});

test("returns a useful provisioning failure", () => {
  const error = latestThreadError([
    {
      type: "system/thread-provisioning",
      seq: 4,
      data: {
        status: "failed",
        entries: [
          { status: "started", text: "Creating worktree" },
          { status: "failed", text: "Branch main does not exist" },
        ],
      },
    },
  ]);

  assert.equal(error?.message, "Branch main does not exist");
  assert.equal(error?.type, "system/thread-provisioning");
});

test("describes a manually stopped turn when assistant output is missing", () => {
  const outcome = latestThreadOutcome([
    {
      type: "turn/completed",
      seq: 14,
      createdAt: 1400,
      data: { status: "interrupted" },
    },
    {
      type: "system/thread/interrupted",
      seq: 13,
      createdAt: 1300,
      data: { reason: "manual-stop" },
    },
  ]);

  assert.deepEqual(outcome, {
    status: "interrupted",
    message: "Thread was stopped manually.",
    reason: "manual-stop",
    sequence: 14,
    createdAt: 1400,
    error: null,
  });
});

test("describes the provider error for the latest failed turn", () => {
  const outcome = latestThreadOutcome([
    {
      type: "turn/completed",
      seq: 22,
      createdAt: 2200,
      data: { status: "failed" },
    },
    {
      type: "provider/error",
      seq: 21,
      createdAt: 2100,
      data: { message: "Provider error", detail: "Authentication expired" },
    },
    {
      type: "turn/completed",
      seq: 10,
      createdAt: 1000,
      data: { status: "completed" },
    },
  ]);

  assert.equal(outcome?.status, "failed");
  assert.equal(outcome?.message, "Authentication expired");
  assert.equal(outcome?.error?.sequence, 21);
});

test("declares bounded SDK event filters", () => {
  assert.deepEqual(THREAD_ERROR_EVENT_TYPES, [
    "provider/error",
    "system/error",
    "turn/completed",
    "client/turn/rejected",
    "system/thread-provisioning",
  ]);
  assert.deepEqual(THREAD_OUTCOME_EVENT_TYPES, [
    ...THREAD_ERROR_EVENT_TYPES,
    "system/thread/interrupted",
  ]);
});
