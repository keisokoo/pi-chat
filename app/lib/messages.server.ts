import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  AssistantMessage,
  TextContent,
  ImageContent,
  Message,
  UserMessage,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import type { UiBlock, UiMessage } from "./types";

function textFromContent(
  content: string | (TextContent | ImageContent)[],
): string {
  if (typeof content === "string") return content;
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function isMessage(m: unknown): m is Message {
  return (
    typeof m === "object" &&
    m !== null &&
    "role" in m &&
    typeof (m as { role: unknown }).role === "string"
  );
}

export function toUiMessages(agentMessages: unknown[]): UiMessage[] {
  const out: UiMessage[] = [];
  let counter = 0;
  for (const raw of agentMessages) {
    if (!isMessage(raw)) continue;
    const m = raw as Message;
    if (m.role === "user") {
      const um = m as UserMessage;
      out.push({
        id: `u-${um.timestamp}-${counter++}`,
        role: "user",
        text: textFromContent(um.content),
        timestamp: um.timestamp,
      });
    } else if (m.role === "assistant") {
      const am = m as AssistantMessage;
      const blocks: UiBlock[] = [];
      for (const c of am.content) {
        if (c.type === "text") {
          blocks.push({ type: "text", text: c.text });
        } else if (c.type === "thinking") {
          blocks.push({ type: "thinking", text: c.thinking });
        } else if (c.type === "toolCall") {
          blocks.push({
            type: "tool",
            toolCallId: c.id,
            name: c.name,
            args: c.arguments,
          });
        }
      }
      const u = am.usage;
      out.push({
        id: `a-${am.timestamp}-${counter++}`,
        role: "assistant",
        blocks,
        timestamp: am.timestamp,
        usage: u
          ? {
              input: u.input,
              output: u.output,
              cacheRead: u.cacheRead,
              cacheWrite: u.cacheWrite,
              total: u.totalTokens,
              costUsd: u.cost?.total ?? 0,
            }
          : undefined,
      });
    } else if (m.role === "toolResult") {
      const tr = m as ToolResultMessage;
      for (let i = out.length - 1; i >= 0; i--) {
        const prior = out[i];
        if (prior.role !== "assistant") continue;
        const block = prior.blocks.find(
          (b) => b.type === "tool" && b.toolCallId === tr.toolCallId,
        );
        if (block && block.type === "tool") {
          block.result = textFromContent(tr.content);
          block.isError = tr.isError;
        }
        break;
      }
    }
  }
  return out;
}

export function loadMessagesForChat(chatId: string): UiMessage[] {
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat || !chat.sessionFile || !existsSync(chat.sessionFile)) return [];
  const sm = SessionManager.open(chat.sessionFile);
  const ctx = sm.buildSessionContext();
  return toUiMessages(ctx.messages as unknown[]);
}
