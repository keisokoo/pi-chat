import { desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Route } from "./+types/api.chats";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
} from "../lib/agent.server";

export async function loader(_: Route.LoaderArgs) {
  const rows = db.select().from(chats).orderBy(desc(chats.updatedAt)).all();
  return Response.json({
    chats: rows.map((r) => ({
      id: r.id,
      title: r.title,
      model: r.model,
      thinkingLevel: r.thinkingLevel,
      tokensInput: r.tokensInput,
      tokensOutput: r.tokensOutput,
      cacheRead: r.cacheRead,
      cacheWrite: r.cacheWrite,
      costUsd: r.costUsd,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
    })),
    models: AVAILABLE_MODELS,
  });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    title?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
  };
  const id = randomUUID();
  const now = new Date();
  const title = typeof body.title === "string" ? body.title : "New chat";
  const model =
    typeof body.model === "string" &&
    AVAILABLE_MODELS.some((m) => m.id === body.model)
      ? (body.model as string)
      : DEFAULT_MODEL;
  const thinkingLevel =
    typeof body.thinkingLevel === "string"
      ? (body.thinkingLevel as string)
      : DEFAULT_THINKING;

  db.insert(chats)
    .values({
      id,
      title,
      model,
      thinkingLevel,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return Response.json({
    id,
    title,
    model,
    thinkingLevel,
    tokensInput: 0,
    tokensOutput: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    createdAt: now.getTime(),
    updatedAt: now.getTime(),
  });
}
