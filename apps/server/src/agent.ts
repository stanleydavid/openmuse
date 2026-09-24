import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentRunner,
  type AgentsFactory,
  type CopilotKitIntelligence,
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          config.model &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY),
        ))
  );
}
export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  // LOCAL PATCH (2026-09-24): optional. When absent the runtime runs fully
  // locally on the in-memory runner (threads live in this process only).
  intelligence?: CopilotKitIntelligence,
  // LOCAL PATCH (2026-09-24): optional PGlite-backed runner. When supplied, the
  // local runtime persists conversation threads across API restarts.
  runner?: AgentRunner,
) {
  const agents: AgentsFactory = async ({ request }) => ({
    default:
      config.agentBackend === "sample"
        ? new ConversationAgent(
            config,
            service,
            await auth.owner(request.headers.get("authorization") ?? undefined),
          )
        : config.agentBackend === "agui"
          ? new HttpAgent({
              url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
              headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
            })
          : new ConversationAgent(
              config,
              service,
              await auth.owner(request.headers.get("authorization") ?? undefined),
            ),
  });
  // LOCAL PATCH (2026-09-24): two explicit branches. The hosted Intelligence
  // runtime wants identifyUser; the local OSS runtime takes a runner instead and
  // rejects identifyUser. Mixing them in one spread breaks overload resolution.
  if (!intelligence)
    return createCopilotHonoHandler({
      runtime: new CopilotRuntime({ agents, runner: runner ?? new InMemoryAgentRunner() }),
      basePath: "/api/copilotkit",
    });
  const runtime = new CopilotRuntime({
    agents,
    intelligence,
    identifyUser: async (request) => ({
      id: await auth.owner(request.headers.get("authorization") ?? undefined),
      name: "OpenMuse user",
    }),
    generateThreadNames: false,
  });
  return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
}
