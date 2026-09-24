// Dump the raw SSE for one prompt (diagnostics). Usage: node chat-raw.mjs "<prompt>"
const base = "http://127.0.0.1:8787";
const prompt = process.argv.slice(2).join(" ") || "hi";
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
const res = await fetch(`${base}/api/copilotkit/agent/default/run`, { method: "POST", headers: h, body: JSON.stringify(body) });
const raw = await res.text();
console.log(`HTTP ${res.status} bytes=${raw.length}`);
for (const line of raw.split(/\r?\n/)) {
  if (!line.startsWith("data:")) continue;
  let ev;
  try {
    ev = JSON.parse(line.slice(5).trim());
  } catch {
    continue;
  }
  if (ev.type === "TEXT_MESSAGE_CONTENT") continue; // summarised below
  console.log(JSON.stringify(ev).slice(0, 600));
}
