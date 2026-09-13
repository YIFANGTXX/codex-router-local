import { Transform } from "node:stream";

// SSE comments keep TCP active but do not yield an event to Codex's SSE
// parser, whose idle deadline surrounds the next parsed event. A data-bearing
// extension event resets that deadline without creating model/history items.
export const LOCAL_SSE_HEARTBEAT =
  'event: codex.router.keepalive\ndata: {"type":"codex.router.keepalive"}\n\n';

// Do not splice a heartbeat into a fragmented upstream data line. Track SSE
// line endings with constant memory and pass every upstream byte unchanged.
export class SseFrameBoundary extends Transform {
  atBoundary = true;
  lineHasData = false;
  previousCR = false;

  _transform(chunk, _encoding, callback) {
    for (const byte of chunk) {
      if (byte === 10 && this.previousCR) {
        this.previousCR = false;
        continue;
      }
      if (byte === 10 || byte === 13) {
        this.atBoundary = !this.lineHasData;
        this.lineHasData = false;
        this.previousCR = byte === 13;
      } else {
        this.atBoundary = false;
        this.lineHasData = true;
        this.previousCR = false;
      }
    }
    callback(null, chunk);
  }
}
