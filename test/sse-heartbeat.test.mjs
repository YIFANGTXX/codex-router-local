import assert from "node:assert/strict";
import test from "node:test";
import { SseFrameBoundary, LOCAL_SSE_HEARTBEAT } from "../src/sse-heartbeat.mjs";

test("heartbeat is a parsed extension event, not model content or a comment", () => {
  const payload = JSON.parse(LOCAL_SSE_HEARTBEAT.split("data: ")[1]);
  assert.deepEqual(payload, { type: "codex.router.keepalive" });
  assert.ok(LOCAL_SSE_HEARTBEAT.endsWith("\n\n"));
});

for (const eol of ["\n", "\r\n", "\r"]) {
  test(`frame tracker preserves bytes and handles fragmented ${JSON.stringify(eol)}`, async () => {
    const boundary = new SseFrameBoundary();
    const received = [];
    boundary.on("data", chunk => received.push(chunk));
    const first = 'event: response.output_text.delta' + eol + 'data: {"delta":"千';
    const last = '问"}' + eol + eol;
    const chunks = [...Buffer.from(first)].map(b => Buffer.from([b]));
    for (const chunk of chunks) {
      boundary.write(chunk);
    }
    assert.equal(boundary.atBoundary, false);
    for (const byte of Buffer.from(last)) boundary.write(Buffer.from([byte]));
    assert.equal(boundary.atBoundary, true);
    boundary.end();
    assert.equal(Buffer.concat(received).toString(), first + last);
  });
}
