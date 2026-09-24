/**
 * LOCAL ADDITION (2026-09-24): force the OpenAI **Chat Completions** API.
 *
 * CopilotKit's `BuiltInAgent` resolves the string spec `openai/<model>` through
 * `resolveModel()`, which in @ai-sdk/openai v3 builds the provider's *default*
 * model — the **Responses API** (`openai.responses`). That path breaks against
 * vLLM/LiteLLM backends: once the agent sends a tool result back, the next turn
 * dies with HTTP 500 `'role'` (raw vLLM's Responses handler cannot map the tool
 * output). The same backend serves tools correctly over `/v1/chat/completions`.
 *
 * `resolveModel()` returns any NON-string spec unchanged, so passing a
 * LanguageModel instance from `provider.chat(id)` switches the whole agent loop
 * to chat completions while leaving everything else untouched.
 *
 * `@ai-sdk/openai` is a transitive dependency of the CopilotKit runtime and is
 * not linked at the workspace root, so we resolve it through the runtime's own
 * module graph instead of adding a duplicate root dependency.
 */
import { createRequire } from "node:module";

interface ChatProviderFactory {
  (options: { apiKey?: string; baseURL?: string; name?: string }): {
    chat: (modelId: string) => unknown;
  };
}

export const MODEL_CHAT_PATCH_NOTE =
  "OpenMuse runs models on the Chat Completions API (see llm.ts) for vLLM compatibility.";

export function chatModel(spec: string | undefined): unknown {
  const raw = (spec ?? "openai/unconfigured").trim();
  const modelId = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1).trim() : raw;
  const require = createRequire(import.meta.resolve("@copilotkit/runtime/v2"));
  const { createOpenAI } = require("@ai-sdk/openai") as { createOpenAI: ChatProviderFactory };
  const provider = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
  });
  return provider.chat(modelId);
}
