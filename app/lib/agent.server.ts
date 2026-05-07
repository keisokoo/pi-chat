import { existsSync, mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { eq } from "drizzle-orm";
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import { createShareFileTool } from "./tools/share-file.server";

const sessions = new Map<string, Promise<AgentSession>>();

const DATA_DIR = resolve(process.cwd(), "data");
export const SESSIONS_DIR = resolve(DATA_DIR, "sessions");
const WORKSPACES_DIR = resolve(DATA_DIR, "workspaces");

mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(WORKSPACES_DIR, { recursive: true });

export const AVAILABLE_MODELS = [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
] as const;

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_THINKING: ThinkingLevel = "off";

export function workspaceFor(chatId: string): string {
  return resolve(WORKSPACES_DIR, chatId);
}

export function resolveSessionFile(sessionFile: string | null): string | null {
  if (!sessionFile) return null;
  return resolve(SESSIONS_DIR, sessionFile);
}

export async function getOrCreateSession(
  chatId: string,
): Promise<AgentSession> {
  const existing = sessions.get(chatId);
  if (existing) return existing;

  const promise = (async () => {
    const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
    if (!chat) throw new Error(`Chat ${chatId} not found`);

    const workspace = workspaceFor(chatId);
    mkdirSync(workspace, { recursive: true });

    const absSessionFile = resolveSessionFile(chat.sessionFile);
    const sessionManager =
      absSessionFile && existsSync(absSessionFile)
        ? SessionManager.open(absSessionFile, SESSIONS_DIR, workspace)
        : SessionManager.create(workspace, SESSIONS_DIR);

    const { session } = await createAgentSession({
      cwd: workspace,
      model: getModel(
        "anthropic",
        chat.model as (typeof AVAILABLE_MODELS)[number]["id"],
      ),
      thinkingLevel: chat.thinkingLevel as ThinkingLevel,
      sessionManager,
      customTools: [createShareFileTool(chatId, workspace)],
    });

    if (session.sessionFile) {
      const base = basename(session.sessionFile);
      if (base !== chat.sessionFile) {
        db.update(chats)
          .set({ sessionFile: base, updatedAt: new Date() })
          .where(eq(chats.id, chatId))
          .run();
      }
    }

    return session;
  })();

  sessions.set(chatId, promise);
  try {
    return await promise;
  } catch (err) {
    sessions.delete(chatId);
    throw err;
  }
}

export async function disposeSession(chatId: string): Promise<void> {
  const entry = sessions.get(chatId);
  if (!entry) return;
  sessions.delete(chatId);
  try {
    const session = await entry;
    session.dispose();
  } catch {
    // ignore
  }
}

export async function updateSessionModel(
  chatId: string,
  modelId: string,
): Promise<void> {
  const session = await getOrCreateSession(chatId);
  await session.setModel(
    getModel("anthropic", modelId as (typeof AVAILABLE_MODELS)[number]["id"]),
  );
}

export async function updateSessionThinking(
  chatId: string,
  level: ThinkingLevel,
): Promise<void> {
  const session = await getOrCreateSession(chatId);
  session.setThinkingLevel(level);
}
