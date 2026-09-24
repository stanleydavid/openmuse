// LOCAL ADDITION (2026-09-24): verify OpenMuse conversation threads survive an
// API restart. Usage: node verify-thread-persistence.mjs create | check
const base = "http://127.0.0.1:8787";
const mode = process.argv[2] ?? "check";

async function session() {
  const r = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!r.ok) throw new Error(`session HTTP ${r.status}`);
  const j = await r.json();
  return j.token;
}

async function main() {
  const token = await session();
  const h = { authorization: `Bearer ${token}` };
  const mtRes = await fetch(`${base}/api/main-thread`, { headers: h });
  if (!mtRes.ok) throw new Error(`main-thread HTTP ${mtRes.status}`);
  const mt = await mtRes.json();
  console.log(`main-thread: ${JSON.stringify(mt)}`);

  if (mode === "create") {
    const body = {
      threadId: mt.threadId,
      runId: crypto.randomUUID(),
      state: {},
      messages: [
        { id: crypto.randomUUID(), role: "user", content: "Reply with exactly: PERSIST_OK" },
      ],
      tools: [],
      context: [],
      forwardedProps: {},
    };
    const r = await fetch(`${base}/api/copilotkit/agent/default/run`, {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    console.log(`run: HTTP ${r.status} bytes=${text.length}`);
    console.log(
      /PERSIST_OK/.test(text) ? "ASSISTANT_REPLY_OK" : `NO_MATCH head=${text.slice(0, 400)}`,
    );
  }

  const listRes = await fetch(`${base}/api/copilotkit/threads`, { headers: h });
  const listText = await listRes.text();
  let threads = [];
  try {
    const parsed = JSON.parse(listText);
    threads = Array.isArray(parsed) ? parsed : (parsed.threads ?? []);
  } catch {}
  console.log(`threads: HTTP ${listRes.status} count=${threads.length}`);
  const match = threads.find((t) => t.id === mt.threadId);
  console.log(match ? `THREAD_PRESENT ${mt.threadId}` : `THREAD_MISSING ${mt.threadId}`);

  const msgRes = await fetch(`${base}/api/copilotkit/threads/${mt.threadId}/messages`, {
    headers: h,
  });
  const msgText = await msgRes.text();
  let msgs = [];
  try {
    const parsed = JSON.parse(msgText);
    msgs = Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
  } catch {}
  const assistant = msgs.filter((m) => m.role === "assistant").length;
  console.log(`messages: HTTP ${msgRes.status} count=${msgs.length} assistant=${assistant}`);
  console.log(msgs.length > 0 ? "MESSAGES_PERSISTED" : "MESSAGES_EMPTY");
}

main().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});
