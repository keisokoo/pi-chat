import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/api.chats.$id";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import {
  AVAILABLE_MODELS,
  THINKING_LEVELS,
  disposeSession,
  resolveSessionFile,
  updateSessionModel,
  updateSessionThinking,
  workspaceFor,
} from "../lib/agent.server";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export async function action({ request, params }: Route.ActionArgs) {
  const id = params.id;
  if (!id) return new Response("missing id", { status: 400 });

  if (request.method === "DELETE") {
    const chat = db.select().from(chats).where(eq(chats.id, id)).get();
    if (!chat) return new Response("not found", { status: 404 });
    await disposeSession(id);
    db.delete(chats).where(eq(chats.id, id)).run();
    try {
      const sessionPath = resolveSessionFile(chat.sessionFile);
      if (sessionPath) rmSync(sessionPath, { force: true });
      rmSync(workspaceFor(id), { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    return Response.json({ ok: true });
  }

  if (request.method !== "PATCH") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    title?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
  };
  const update: Partial<typeof chats.$inferInsert> = {};
  if (typeof body.title === "string") update.title = body.title;
  if (
    typeof body.model === "string" &&
    AVAILABLE_MODELS.some((m) => m.id === body.model)
  ) {
    update.model = body.model;
  }
  if (
    typeof body.thinkingLevel === "string" &&
    THINKING_LEVELS.includes(body.thinkingLevel as ThinkingLevel)
  ) {
    update.thinkingLevel = body.thinkingLevel;
  }

  if (Object.keys(update).length === 0) {
    return new Response("no fields to update", { status: 400 });
  }

  update.updatedAt = new Date();
  db.update(chats).set(update).where(eq(chats.id, id)).run();

  try {
    if (update.model) await updateSessionModel(id, update.model);
    if (update.thinkingLevel)
      await updateSessionThinking(id, update.thinkingLevel as ThinkingLevel);
  } catch (err) {
    return Response.json(
      {
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  const row = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!row) return new Response("not found", { status: 404 });
  return Response.json({
    id: row.id,
    title: row.title,
    model: row.model,
    thinkingLevel: row.thinkingLevel,
    updatedAt: row.updatedAt.getTime(),
  });
}
