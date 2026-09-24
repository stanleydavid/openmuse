// LOCAL ADDITION (2026-09-24): send one prompt to the local OpenMuse agent and
// print the tool calls + assistant reply. Usage: node chat.mjs "<prompt>"
const base = "http://127.0.0.1:8787";
const prompt = process.argv.slice(2).join(" ") || "Check my email and summarize recent messages.";
const j = (s) => JSON.stringify(s).slice(0, 400);

const s = await (await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
const h = { authorization: `Bearer ${s.token}`, "content-type": "application/json" };
const mt = await (await fetch(`${base}/api/main-thread`, { headers: h })).json();
const body = {
  threadId: mt.threadId,
  runId: crypto.randomUUID(),
  state: {},
  messages: [{ id: crypto.randomUUID(), role: "user", content: prompt }],
  tools: [],
  context: [],
  forwardedProps: {},
};
console.log(`PROMPT: ${prompt}`);
console.log(`THREAD: ${mt.threadId}`);
const t = Date.now();
const res = await fetch(`${base}/api/copilotkit/agent/default/run`, { method: "POST", headers: h, body: JSON.stringify(body) });
console.log(`HTTP ${res.status} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
const raw = await res.text();
const text = new Map();
const tools = new Map();
let toolOrder = [];
for (const line of raw.split(/\r?\n/)) {
  if (!line.startsWith("data:")) continue;
  let ev;
  try {
    ev = JSON.parse(line.slice(5).trim());
  } catch {
    continue;
  }
  if (ev.type === "TEXT_MESSAGE_CONTENT" && ev.messageId) text.set(ev.messageId, (text.get(ev.messageId) ?? "") + (ev.delta ?? ""));
  if (ev.type === "TOOL_CALL_START") {
    tools.set(ev.toolCallId, { name: ev.toolCallName, args: "", result: null });
    toolOrder.push(ev.toolCallId);
  }
  if (ev.type === "TOOL_CALL_ARGS") {
    const c = tools.get(ev.toolCallId);
    if (c) c.args += ev.delta ?? "";
  }
  if (ev.type === "TOOL_CALL_RESULT") {
    const c = tools.get(ev.toolCallId);
    if (c) c.result = typeof ev.content === "string" ? ev.content : j(ev.content);
  }
}
console.log(`TOOL_CALLS: ${toolOrder.length}`);
for (const id of toolOrder) {
  const c = tools.get(id);
  console.log(`  - ${c.name}(${c.args.slice(0, 200)})`);
  if (c.result) console.log(`    result: ${c.result.slice(0, 500)}`);
}
console.log("ASSISTANT:");
for (const v of text.values()) console.log(v);
