// The `--import` preload. Not imported by the app, and it does not import the
// app: the ESM loader hook must be in place before Fastify is resolved, and
// pulling `./server.js` in here would resolve it first.
// The name matches `SERVICE` in `./server.ts`, deliberately duplicated rather
// than imported for that reason.
import { startTelemetry } from "@finance-planner/telemetry";

await startTelemetry("calc");
