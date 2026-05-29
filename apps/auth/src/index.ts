import { buildServer } from "./server.js";

const port = Number(process.env.AUTH_PORT ?? 4001);
const host = process.env.HOST ?? "0.0.0.0";

const app = buildServer();

app.listen({ port, host }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
