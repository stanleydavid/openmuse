/**
 * PersistentAgentRunner — LOCAL ADDITION (2026-09-24).
 *
 * CopilotKit's OSS runtime ships only two runners: `InMemoryAgentRunner`
 * (thread history dies with the process) and the hosted Intelligence runner
 * (thread history lives in CopilotKit's cloud). Stanley wants a FULLY LOCAL
 * deployment whose conversation threads survive an API restart, so this runner
 * keeps the exact same in-process semantics as `InMemoryAgentRunner` but writes
 * every completed run to the app's own PGlite store and rehydrates on boot.
 *
 * Storage model (records table, kind="copilot-threads", id=threadId):
 *   { id, createdAt, updatedAt, agentId, messages: Message[], runs: [{
 *        runId, agentId, parentRunId, createdAt, events: BaseEvent[] }] }
 *
 * `messages` is the latest full snapshot (input + generated) from the agent,
 * `runs[].events` are the compacted per-run AG-UI events. `getThreadEvents`
 * re-compacts across runs so the replay matches the in-memory semantics.
 */
import "./config.ts";
import type { AbstractAgent, Message } from "@ag-ui/client";
import { compactEvents, EventType } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  finalizeRunEvents,
} from "@copilotkit/runtime/v2";
import { type Observable, ReplaySubject } from "rxjs";
import type { Store } from "./db.ts";
import { backgroundFailure } from "./log.ts";

/** Narrowed view of a RUN_STARTED event (the AG-UI enum discriminant does not
 * survive `Extract`, so we model just the fields we touch). */
type RunStartedEvent = { type: string; input?: RunAgentInput };

const KIND = "copilot-threads";
// Records are keyed by (owner, kind, id); the local runner is single-tenant, so
// one constant owner namespaces every persisted thread.
const OWNER = "local-user";

interface StoredRun {
  runId: string;
  agentId: string;
  parentRunId: string | null;
  createdAt: number;
  events: BaseEvent[];
}

interface StoredThread {
  id: string;
  createdAt: number;
  updatedAt: number;
  agentId: string;
  messages: Message[];
  runs: StoredRun[];
}

interface LiveThread extends StoredThread {
  isRunning: boolean;
  currentRunId: string | null;
  agent: AbstractAgent | null;
  subject: ReplaySubject<BaseEvent> | null;
  runSubject: ReplaySubject<BaseEvent> | null;
  stopRequested: boolean;
  activeFinalize: { stopRequested: boolean } | null;
  currentEvents: BaseEvent[] | null;
}

function emptyThread(id: string): LiveThread {
  return {
    id,
    createdAt: 0,
    updatedAt: 0,
    agentId: "default",
    messages: [],
    runs: [],
    isRunning: false,
    currentRunId: null,
    agent: null,
    subject: null,
    runSubject: null,
    stopRequested: false,
    activeFinalize: null,
    currentEvents: null,
  };
}

export class PersistentAgentRunner extends AgentRunner {
  // CopilotKit's runtime type guard looks for this exact (unicode-named) marker.
  // Written with an escape so the source file stays pure ASCII.
  ["\u0275supportsLocalThreadEndpoints"] = true as const;

  private readonly threads = new Map<string, LiveThread>();
  /** Serializes writes per thread so a later run can never be clobbered by an earlier one. */
  private readonly writeChain = new Map<string, Promise<void>>();

  constructor(private readonly db: Store) {
    super();
  }

  /** Load every persisted thread into memory. Call before serving requests. */
  async hydrate(): Promise<void> {
    const rows = await this.db.scan<StoredThread>(KIND);
    for (const { value } of rows) {
      if (!value || typeof value.id !== "string") continue;
      const live = emptyThread(value.id);
      live.createdAt = value.createdAt ?? 0;
      live.updatedAt = value.updatedAt ?? 0;
      live.agentId = value.agentId ?? "default";
      live.messages = Array.isArray(value.messages) ? value.messages : [];
      live.runs = Array.isArray(value.runs) ? value.runs : [];
      this.threads.set(value.id, live);
    }
  }

  private getOrCreate(threadId: string): LiveThread {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const created = emptyThread(threadId);
    this.threads.set(threadId, created);
    return created;
  }

  private persist(threadId: string): Promise<void> {
    const previous = this.writeChain.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const live = this.threads.get(threadId);
        if (!live) return;
        const record: StoredThread = {
          id: live.id,
          createdAt: live.createdAt,
          updatedAt: live.updatedAt,
          agentId: live.agentId,
          messages: live.messages,
          runs: live.runs,
        };
        await this.db.put(OWNER, KIND, record);
      })
      .catch((error) => backgroundFailure("persist copilot thread", error));
    this.writeChain.set(threadId, next);
    return next;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const store = this.getOrCreate(request.threadId);
    if (store.isRunning || store.stopRequested) throw new Error("Thread already running");
    store.isRunning = true;
    store.currentRunId = request.input.runId;
    store.agent = request.agent;
    store.stopRequested = false;
    const finalizeControl = { stopRequested: false };
    store.activeFinalize = finalizeControl;
    const currentRunEvents: BaseEvent[] = [];
    store.currentEvents = currentRunEvents;

    // Messages already known to the thread (from earlier runs) so RUN_STARTED
    // does not resend prior turns back into the model.
    const historicMessageIds = new Set<string>();
    for (const run of store.runs)
      for (const event of run.events) {
        if ("messageId" in event && typeof event.messageId === "string")
          historicMessageIds.add(event.messageId as string);
        if (event.type === EventType.RUN_STARTED) {
          const input = (event as RunStartedEvent).input;
          for (const message of input?.messages ?? []) historicMessageIds.add(message.id);
        }
      }
    for (const message of store.messages) historicMessageIds.add(message.id);

    const nextSubject = new ReplaySubject<BaseEvent>(Number.POSITIVE_INFINITY);
    store.subject = nextSubject;
    const runSubject = new ReplaySubject<BaseEvent>(Number.POSITIVE_INFINITY);
    store.runSubject = runSubject;

    const runAgent = async () => {
      const parentRunId = store.runs[store.runs.length - 1]?.runId ?? null;
      let persisted = false;
      const finalizeRun = (opts: { interruptionMessage?: string }): void => {
        const isError = opts.interruptionMessage !== undefined;
        const preFinalizeEventCount = currentRunEvents.length;
        const appendedEvents = finalizeRunEvents(currentRunEvents, {
          stopRequested: finalizeControl.stopRequested,
          ...(isError ? { interruptionMessage: opts.interruptionMessage } : {}),
        });
        for (const event of appendedEvents) {
          runSubject.next(event);
          nextSubject.next(event);
        }
        const ownsThread = store.currentRunId === request.input.runId;
        if (ownsThread && (!isError || preFinalizeEventCount > 0)) {
          const compactedEvents = compactEvents(currentRunEvents);
          const messages = Array.isArray(request.agent.messages) ? [...request.agent.messages] : [];
          if (store.createdAt === 0) store.createdAt = Date.now();
          store.updatedAt = Date.now();
          store.agentId = request.agent.agentId ?? "default";
          if (messages.length > 0) store.messages = messages;
          store.runs.push({
            runId: request.input.runId,
            agentId: request.agent.agentId ?? "default",
            parentRunId,
            createdAt: Date.now(),
            events: compactedEvents,
          });
          persisted = true;
        }
        if (ownsThread) {
          store.currentEvents = null;
          store.currentRunId = null;
          store.agent = null;
          store.runSubject = null;
          store.stopRequested = false;
          store.isRunning = false;
          store.activeFinalize = null;
        }
        runSubject.complete();
        nextSubject.complete();
        if (store.subject === nextSubject) store.subject = null;
      };
      try {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            let processedEvent: BaseEvent = event;
            if (event.type === EventType.RUN_STARTED) {
              const runStarted = event as RunStartedEvent;
              if (!runStarted.input) {
                const sanitized = request.input.messages
                  ? request.input.messages.filter((message) => !historicMessageIds.has(message.id))
                  : undefined;
                runStarted.input = {
                  ...request.input,
                  ...(sanitized !== undefined ? { messages: sanitized } : {}),
                };
                processedEvent = runStarted as unknown as BaseEvent;
              }
            }
            runSubject.next(processedEvent);
            nextSubject.next(processedEvent);
            currentRunEvents.push(processedEvent);
          },
        });
        finalizeRun({});
      } catch (error) {
        finalizeRun({
          interruptionMessage: error instanceof Error ? error.message : String(error),
        });
      }
      if (persisted) await this.persist(request.threadId);
    };
    void runAgent();
    return runSubject.asObservable();
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const store = this.threads.get(request.threadId);
    const connectionSubject = new ReplaySubject<BaseEvent>(Number.POSITIVE_INFINITY);
    if (!store) {
      connectionSubject.complete();
      return connectionSubject.asObservable();
    }
    const allHistoricEvents: BaseEvent[] = [];
    for (const run of store.runs) allHistoricEvents.push(...run.events);
    const compacted = compactEvents(allHistoricEvents);
    const emittedMessageIds = new Set<string>();
    for (const event of compacted) {
      connectionSubject.next(event);
      if ("messageId" in event && typeof event.messageId === "string")
        emittedMessageIds.add(event.messageId as string);
    }
    if (store.subject && (store.isRunning || store.stopRequested)) {
      store.subject.subscribe({
        next: (event) => {
          if (
            "messageId" in event &&
            typeof event.messageId === "string" &&
            emittedMessageIds.has(event.messageId as string)
          )
            return;
          connectionSubject.next(event);
        },
        complete: () => connectionSubject.complete(),
        error: (error) => connectionSubject.error(error),
      });
    } else {
      connectionSubject.complete();
    }
    return connectionSubject.asObservable();
  }

  isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    return Promise.resolve(this.threads.get(request.threadId)?.isRunning ?? false);
  }

  stop(request: AgentRunnerStopRequest): Promise<boolean | undefined> {
    const store = this.threads.get(request.threadId);
    if (!store?.isRunning) return Promise.resolve(false);
    if (request.runId !== undefined && store.currentRunId !== request.runId)
      return Promise.resolve(false);
    if (store.stopRequested) return Promise.resolve(false);
    store.stopRequested = true;
    store.isRunning = false;
    if (store.activeFinalize) store.activeFinalize.stopRequested = true;
    const agent = store.agent;
    if (!agent) {
      store.stopRequested = false;
      store.isRunning = false;
      if (store.activeFinalize) store.activeFinalize.stopRequested = false;
      return Promise.resolve(false);
    }
    try {
      agent.abortRun();
      return Promise.resolve(true);
    } catch (error) {
      console.error("Failed to abort agent run", error);
      store.stopRequested = false;
      store.isRunning = true;
      if (store.activeFinalize) store.activeFinalize.stopRequested = false;
      return Promise.resolve(false);
    }
  }

  listThreads() {
    const threads: {
      id: string;
      name: string | null;
      agentId: string;
      organizationId: string;
      createdById: string;
      archived: boolean;
      createdAt: string;
      updatedAt: string;
    }[] = [];
    for (const store of this.threads.values()) {
      if (store.runs.length === 0) continue;
      threads.push({
        id: store.id,
        name: null,
        agentId: store.agentId,
        organizationId: "",
        createdById: "",
        archived: false,
        createdAt: new Date(store.createdAt || store.updatedAt).toISOString(),
        updatedAt: new Date(store.updatedAt).toISOString(),
      });
    }
    return threads.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  getThreadMessages(threadId: string): Message[] {
    const store = this.threads.get(threadId);
    return store ? [...store.messages] : [];
  }

  getThreadEvents(threadId: string): BaseEvent[] {
    const store = this.threads.get(threadId);
    if (!store || store.runs.length === 0) return [];
    const all: BaseEvent[] = [];
    for (const run of store.runs) all.push(...run.events);
    return compactEvents(all);
  }

  getThreadState(threadId: string): Record<string, unknown> | null {
    const events = this.getThreadEvents(threadId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.type === EventType.STATE_SNAPSHOT) {
        const snapshot = (event as { snapshot?: unknown }).snapshot;
        if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot))
          return { ...(snapshot as Record<string, unknown>) };
        return null;
      }
    }
    return null;
  }

  clearThreads(): void {
    const ids = [...this.threads.keys()];
    this.threads.clear();
    for (const id of ids)
      void this.db.remove(OWNER, KIND, id).catch((error) => {
        backgroundFailure("clear copilot thread", error);
      });
  }
}
