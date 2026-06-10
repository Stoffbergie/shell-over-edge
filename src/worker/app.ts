import { Hono } from "hono";
import { PayloadTooLargeError, BadRequestError, textResponse } from "../shared/http";
import type { Env } from "./env";
import { createSessionResponse, registerSessionRoutes } from "./routes/sessions";

export const app = new Hono<{ Bindings: Env }>();

app.onError((error) => {
  if (error instanceof PayloadTooLargeError || error instanceof BadRequestError) {
    return textResponse(`${error.message}\n`, error instanceof PayloadTooLargeError ? 413 : 400);
  }
  return textResponse("Internal server error\n", 500);
});

app.use("*", async (c, next) => {
  await next();
  if (c.res.headers.get("Cache-Control") === "no-store") return;
  const headers = new Headers(c.res.headers);
  headers.set("Cache-Control", "no-store");
  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers
  });
});

app.get("/", (c) => createSessionResponse(c, "shell"));
app.get("/a.ps1", (c) => createSessionResponse(c, "powershell"));

registerSessionRoutes(app);

app.notFound(() => textResponse("Not found\n", 404));
