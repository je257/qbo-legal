// Summarises `wrangler tail --format json` output: one line per request, no headers, no addresses.
// Usage: node tail-summary.mjs <file> [<file> ...]
import { readFileSync } from "node:fs";

function* objects(raw) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        yield raw.slice(start, i + 1);
        start = -1;
      }
    }
  }
}

let count = 0;
for (const file of process.argv.slice(2)) {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const text of objects(raw)) {
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (!event.event?.request) continue;
    count++;
    const request = event.event.request;
    const url = new URL(request.url);
    const agent = (request.headers?.["user-agent"] ?? "").slice(0, 28);
    const logs = (event.logs ?? []).map((log) => log.message.map(String).join(" ")).join(" | ").slice(0, 220);
    const errors = (event.exceptions ?? []).map((e) => `${e.name}: ${e.message}`).join(" | ").slice(0, 200);
    console.log(
      [
        new Date(event.eventTimestamp).toTimeString().slice(0, 8),
        request.method.padEnd(4),
        url.pathname.padEnd(44),
        `http ${event.event.response?.status ?? "-"}`,
        `cpu ${event.cpuTime}ms`,
        `wall ${event.wallTime}ms`,
        event.outcome,
        `[${agent}]`,
        logs,
        errors,
      ].join("  "),
    );
  }
}
console.log(`${count} requests`);
