# OpenMuse — local-only patch (no CopilotKit Intelligence)

Applied 2026-09-24 on the local clone `C:\EIAdminBot\data\workspace\openmuse`
(upstream = `stanleydavid/openmuse`, fork of `CopilotKit/openmuse`).

## Goal
Run OpenMuse with **zero hosted CopilotKit dependency**: no project key, no
cloud thread storage. Model inference still goes to the configured
OpenAI-compatible endpoint (`OPENAI_BASE_URL`, i.e. Zeno).

## What changed (3 files)

| File | Change |
|---|---|
| `apps/server/src/config.ts` | `CPK_INTELLIGENCE_API_KEY` is no longer `required()` at boot — empty/absent is valid and yields `intelligenceApiKey: undefined`. |
| `apps/server/src/agent.ts` | `makeRuntime(..., intelligence?)` — optional. Two explicit branches: with `intelligence` → hosted Rich Threads runtime (needs `identifyUser`); without → OSS runtime `new CopilotRuntime({ agents, runner: new InMemoryAgentRunner() })`. Do **not** merge the two shapes with a spread: the overloads are exclusive and a spread union fails typecheck. |
| `apps/server/src/app.ts` | Dropped the `assertApiDeploymentConfig()` call; builds `CopilotKitIntelligence` only when a key exists; `/api/main-thread` skips `getOrCreateThread()` when there is no Intelligence client. |

`InMemoryAgentRunner` is exported from `@copilotkit/runtime/v2` and sets
`supportsLocalThreadEndpoints = true`, so the local runtime serves
`GET /threads`, `/threads/:id/messages`, `/threads/:id/events`,
`/threads/:id/state` and `POST /threads/clear` from process memory.

## Runtime contract (verified)
- API routes live under `basePath` `/api/copilotkit`, multi-route mode.
- Agent run endpoint: `POST /api/copilotkit/agent/<agentId>/run` (here `<agentId>` = `default`), body = AG-UI `RunAgentInput`, response = `text/event-stream`.
- All API routes except `/api/health` need `Authorization: Bearer <session token>` from `POST /api/session` (sample mode needs no access key).
- Verified end-to-end: session → main thread → run → SSE containing the assistant reply, and `GET /api/copilotkit/threads` listing the thread.

## Trade-offs
- **Threads are in-process memory only.** They are lost on API restart. Durable local history would need a custom `AgentRunner` on top of the app's own store (the package ships only `InMemoryAgentRunner` and the hosted `IntelligenceAgentRunner`).
- Hosted-only features are gone: server-side thread rename/archive/replay persistence, User Memory, Automatic Learning, Product Analytics.
- `apps/server/src/demo/entry.ts` (AI-mock demo) still requires the key; it is a separate entry point and was left untouched.

## Reverting to hosted Rich Threads
Set `CPK_INTELLIGENCE_API_KEY` in `.env` and restart the API. The code keeps the hosted path intact — `git diff` on the three files shows exactly what to restore if upstream is updated.
