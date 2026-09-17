export const THREAD_ERROR_EVENT_TYPES = [
  "provider/error",
  "system/error",
  "turn/completed",
  "client/turn/rejected",
  "system/thread-provisioning",
] as const;

export const THREAD_OUTCOME_EVENT_TYPES = [
  ...THREAD_ERROR_EVENT_TYPES,
  "system/thread/interrupted",
] as const;

export interface ThreadErrorSummary {
  type: string;
  message: string;
  detail: string | null;
  sequence: number | null;
  createdAt: number | null;
  code?: string;
  category?: string;
  providerCode?: string;
  httpStatusCode?: number;
}

export interface ThreadOutcomeSummary {
  status: "completed" | "failed" | "interrupted";
  message: string;
  reason: string | null;
  sequence: number | null;
  createdAt: number | null;
  error: ThreadErrorSummary | null;
}

interface ThreadEventLike {
  type: string;
  data: unknown;
  seq?: number;
  createdAt?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Keep the useful provider explanation while dropping stack frames and bounding tool output. */
function conciseDetail(value: unknown, max = 2000): string | null {
  let detail = text(value);
  if (!detail) return null;
  const stackMarker = detail.indexOf("; stack=");
  if (stackMarker >= 0) detail = detail.slice(0, stackMarker);
  const stackLine = detail.search(/\n\s*at\s+/);
  if (stackLine >= 0) detail = detail.slice(0, stackLine);
  detail = detail.trim();
  return detail.length > max ? `${detail.slice(0, max)}…` : detail;
}

function baseSummary(event: ThreadEventLike, message: string, detail: string | null): ThreadErrorSummary {
  return {
    type: event.type,
    message,
    detail,
    sequence: typeof event.seq === "number" ? event.seq : null,
    createdAt: typeof event.createdAt === "number" ? event.createdAt : null,
  };
}

/**
 * Find the newest useful failure in events ordered newest-first.
 * Lifecycle rows without an error message are skipped so the preceding
 * provider/system error remains visible.
 */
export function latestThreadError(events: readonly ThreadEventLike[]): ThreadErrorSummary | null {
  for (const event of events) {
    const data = record(event.data);
    if (!data) continue;

    if (event.type === "provider/error") {
      const summary = baseSummary(
        event,
        text(data.message) ?? "Provider error",
        conciseDetail(data.detail),
      );
      const errorInfo = record(data.errorInfo);
      const category = text(errorInfo?.category);
      const providerCode = text(errorInfo?.providerCode);
      const httpStatusCode = errorInfo?.httpStatusCode;
      if (category) summary.category = category;
      if (providerCode) summary.providerCode = providerCode;
      if (typeof httpStatusCode === "number") summary.httpStatusCode = httpStatusCode;
      return summary;
    }

    if (event.type === "system/error") {
      const summary = baseSummary(
        event,
        text(data.message) ?? "System error",
        conciseDetail(data.detail),
      );
      const code = text(data.code);
      if (code) summary.code = code;
      return summary;
    }

    if (event.type === "client/turn/rejected") {
      return baseSummary(
        event,
        text(data.message) ?? "Thread request rejected",
        conciseDetail(data.reason),
      );
    }

    if (event.type === "turn/completed" && data.status === "failed") {
      const error = record(data.error);
      const message = text(error?.message);
      if (message) return baseSummary(event, message, null);
      continue;
    }

    if (event.type === "system/thread-provisioning" && data.status === "failed") {
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const failedEntry = [...entries]
        .reverse()
        .map(record)
        .find((entry) => entry?.status === "failed" && text(entry.text));
      return baseSummary(
        event,
        text(failedEntry?.text) ?? "Thread workspace provisioning failed",
        null,
      );
    }
  }
  return null;
}

function interruptionMessage(reason: string | null): string {
  if (reason === "manual-stop") return "Thread was stopped manually.";
  if (reason === "host-daemon-restarted") return "Thread was interrupted because the host daemon restarted.";
  if (reason === "provider-turn-idle") return "Thread was interrupted after the provider stopped responding.";
  return "Thread was interrupted.";
}

/** Describe the latest terminal turn when no assistant output was produced. */
export function latestThreadOutcome(events: readonly ThreadEventLike[]): ThreadOutcomeSummary | null {
  const completionIndex = events.findIndex((event) => event.type === "turn/completed");
  if (completionIndex >= 0) {
    const completion = events[completionIndex]!;
    const data = record(completion.data);
    const status = data?.status;
    const nextCompletionOffset = events
      .slice(completionIndex + 1)
      .findIndex((event) => event.type === "turn/completed");
    const turnEnd = nextCompletionOffset < 0
      ? events.length
      : completionIndex + 1 + nextCompletionOffset;
    const turnEvents = events.slice(completionIndex, turnEnd);

    if (status === "interrupted") {
      const interruption = turnEvents.find((event) => event.type === "system/thread/interrupted");
      const reason = text(record(interruption?.data)?.reason);
      return {
        status,
        message: interruptionMessage(reason),
        reason,
        sequence: typeof completion.seq === "number" ? completion.seq : null,
        createdAt: typeof completion.createdAt === "number" ? completion.createdAt : null,
        error: null,
      };
    }

    if (status === "failed") {
      const error = latestThreadError(turnEvents);
      return {
        status,
        message: error?.detail ?? error?.message ?? "Thread failed without a recorded error message.",
        reason: null,
        sequence: typeof completion.seq === "number" ? completion.seq : null,
        createdAt: typeof completion.createdAt === "number" ? completion.createdAt : null,
        error,
      };
    }

    if (status === "completed") {
      return {
        status,
        message: "Thread completed without assistant output.",
        reason: null,
        sequence: typeof completion.seq === "number" ? completion.seq : null,
        createdAt: typeof completion.createdAt === "number" ? completion.createdAt : null,
        error: null,
      };
    }
  }

  const interruption = events.find((event) => event.type === "system/thread/interrupted");
  if (interruption) {
    const reason = text(record(interruption.data)?.reason);
    return {
      status: "interrupted",
      message: interruptionMessage(reason),
      reason,
      sequence: typeof interruption.seq === "number" ? interruption.seq : null,
      createdAt: typeof interruption.createdAt === "number" ? interruption.createdAt : null,
      error: null,
    };
  }

  const error = latestThreadError(events);
  return error
    ? {
        status: "failed",
        message: error.detail ?? error.message,
        reason: null,
        sequence: error.sequence,
        createdAt: error.createdAt,
        error,
      }
    : null;
}
