import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { Route } from "./+types/api.chats.$id.message";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import { getOrCreateSession } from "../lib/agent.server";
import type { ServerEvent } from "../lib/types";

function stringifyResult(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const chatId = params.id;
  if (!chatId) return new Response("missing id", { status: 400 });

  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat) return new Response("chat not found", { status: 404 });

  const body = (await request.json().catch(() => ({}))) as {
    message?: unknown;
  };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return Response.json({ error: "message required" }, { status: 400 });
  }

  let session;
  try {
    session = await getOrCreateSession(chatId);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  if (session.isStreaming) {
    return Response.json({ error: "session is busy" }, { status: 409 });
  }

  db.update(chats)
    .set({ updatedAt: new Date() })
    .where(eq(chats.id, chatId))
    .run();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const send = (event: ServerEvent) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      let currentAssistantId: string | null = null;
      const assistantIds = new Map<AssistantMessage, string>();

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_start") {
          if (event.message.role === "assistant") {
            currentAssistantId = randomUUID();
            assistantIds.set(event.message, currentAssistantId);
            send({ type: "assistant_start", id: currentAssistantId });
          }
        } else if (event.type === "message_end") {
          if (event.message.role === "assistant") {
            const id = assistantIds.get(event.message);
            const u = event.message.usage;
            if (id && u) {
              send({
                type: "assistant_usage",
                id,
                usage: {
                  input: u.input,
                  output: u.output,
                  cacheRead: u.cacheRead,
                  cacheWrite: u.cacheWrite,
                  total: u.totalTokens,
                  costUsd: u.cost.total,
                },
              });
            }
          }
        } else if (event.type === "message_update") {
          if (!currentAssistantId) return;
          const inner = event.assistantMessageEvent;
          if (inner.type === "text_delta") {
            send({
              type: "text_delta",
              id: currentAssistantId,
              index: inner.contentIndex,
              delta: inner.delta,
            });
          } else if (inner.type === "thinking_delta") {
            send({
              type: "thinking_delta",
              id: currentAssistantId,
              index: inner.contentIndex,
              delta: inner.delta,
            });
          } else if (inner.type === "toolcall_start") {
            const block = inner.partial.content[inner.contentIndex];
            const name =
              block && block.type === "toolCall" ? block.name : "";
            send({
              type: "tool_call_start",
              id: currentAssistantId,
              index: inner.contentIndex,
              name,
            });
          } else if (inner.type === "toolcall_delta") {
            send({
              type: "tool_call_delta",
              id: currentAssistantId,
              index: inner.contentIndex,
              delta: inner.delta,
            });
          } else if (inner.type === "toolcall_end") {
            send({
              type: "tool_call",
              id: currentAssistantId,
              index: inner.contentIndex,
              toolCallId: inner.toolCall.id,
              name: inner.toolCall.name,
              args: inner.toolCall.arguments,
            });
          }
        } else if (event.type === "tool_execution_start") {
          send({
            type: "tool_running",
            toolCallId: event.toolCallId,
            startedAt: Date.now(),
          });
        } else if (event.type === "tool_execution_update") {
          send({
            type: "tool_partial",
            toolCallId: event.toolCallId,
            partial: stringifyResult(event.partialResult),
          });
        } else if (event.type === "tool_execution_end") {
          send({
            type: "tool_result",
            toolCallId: event.toolCallId,
            result: stringifyResult(event.result),
            isError: event.isError,
          });
        } else if (event.type === "agent_end") {
          try {
            const stats = session.getSessionStats();
            const totals = {
              tokensInput: stats.tokens.input,
              tokensOutput: stats.tokens.output,
              cacheRead: stats.tokens.cacheRead,
              cacheWrite: stats.tokens.cacheWrite,
              costUsd: stats.cost,
            };
            db.update(chats)
              .set({ ...totals, updatedAt: new Date() })
              .where(eq(chats.id, chatId))
              .run();
            send({ type: "session_totals", totals });
          } catch {
            // stats unavailable; skip
          }
          send({ type: "done" });
          unsubscribe();
          close();
        }
      });

      request.signal.addEventListener("abort", () => {
        unsubscribe();
        session.abort().catch(() => {});
        close();
      });

      try {
        await session.prompt(message);
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        unsubscribe();
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
