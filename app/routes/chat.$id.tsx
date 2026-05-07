import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/chat.$id";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import {
  AVAILABLE_MODELS,
  THINKING_LEVELS,
  workspaceFor,
} from "../lib/agent.server";
import { loadMessagesForChat } from "../lib/messages.server";
import { pickRunningPhrase } from "../lib/phrases";
import type { WorkspaceFile } from "./api.chats.$id.files";
import type {
  ServerEvent,
  SessionTotals,
  UiBlock,
  UiMessage,
  UsageDelta,
} from "../lib/types";

export async function loader({ params }: Route.LoaderArgs) {
  const id = params.id;
  if (!id) throw new Response("missing id", { status: 400 });
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) throw new Response("chat not found", { status: 404 });
  const messages = loadMessagesForChat(id);
  return {
    chat: {
      id: chat.id,
      title: chat.title,
      model: chat.model,
      thinkingLevel: chat.thinkingLevel,
    },
    totals: {
      tokensInput: chat.tokensInput,
      tokensOutput: chat.tokensOutput,
      cacheRead: chat.cacheRead,
      cacheWrite: chat.cacheWrite,
      costUsd: chat.costUsd,
    } satisfies SessionTotals,
    messages,
    workspace: workspaceFor(id),
    models: AVAILABLE_MODELS as unknown as { id: string; label: string }[],
    thinkingLevels: THINKING_LEVELS as readonly string[],
  };
}

export function meta({ data }: Route.MetaArgs) {
  return [{ title: data?.chat ? `${data.chat.title} · Pi Chat` : "Pi Chat" }];
}

interface OutletCtx {
  refreshChats: () => Promise<void>;
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureAssistantBlock(
  blocks: UiBlock[],
  index: number,
  fallback: UiBlock,
): UiBlock[] {
  const next = blocks.slice();
  while (next.length <= index) {
    next.push({ type: "text", text: "" });
  }
  if (next[index].type !== fallback.type) {
    next[index] = fallback;
  }
  return next;
}

export default function ChatDetail({ loaderData }: Route.ComponentProps) {
  const {
    chat,
    models,
    thinkingLevels,
    messages: initialMessages,
    totals: initialTotals,
    workspace,
  } = loaderData;
  const ctx = useOutletContext<OutletCtx>();
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [totals, setTotals] = useState<SessionTotals>(initialTotals);
  const [title, setTitle] = useState(chat.title);
  const [model, setModel] = useState(chat.model);
  const [thinking, setThinking] = useState(chat.thinkingLevel);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const chatId = chat.id;

  const refreshFiles = useCallback(async () => {
    try {
      const res = await fetch(`/api/chats/${chatId}/files`);
      if (!res.ok) return;
      const data = (await res.json()) as { files: WorkspaceFile[] };
      setFiles(data.files);
    } catch {
      // ignore
    }
  }, [chatId]);

  useEffect(() => {
    if (filesOpen) refreshFiles();
  }, [filesOpen, refreshFiles]);

  useEffect(() => {
    setMessages(initialMessages);
    setTotals(initialTotals);
    setTitle(chat.title);
    setModel(chat.model);
    setThinking(chat.thinkingLevel);
    setError(null);
  }, [
    chatId,
    chat.title,
    chat.model,
    chat.thinkingLevel,
    initialMessages,
    initialTotals,
  ]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    if (!isStreaming) inputRef.current?.focus();
  }, [isStreaming, chatId]);

  const modelLabel = useMemo(
    () => models.find((m) => m.id === model)?.label ?? model,
    [model, models],
  );

  async function patchChat(update: {
    title?: string;
    model?: string;
    thinkingLevel?: string;
  }) {
    const res = await fetch(`/api/chats/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(typeof body.error === "string" ? body.error : "update failed");
      return;
    }
    await ctx.refreshChats();
  }

  function applyEvent(event: ServerEvent) {
    if (event.type === "session_totals") {
      setTotals(event.totals);
      return;
    }
    if (event.type === "assistant_usage") {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === event.id && m.role === "assistant"
            ? { ...m, usage: event.usage }
            : m,
        ),
      );
      return;
    }
    setMessages((prev) => {
      if (event.type === "assistant_start") {
        return [
          ...prev,
          {
            id: event.id,
            role: "assistant",
            blocks: [],
            timestamp: Date.now(),
          },
        ];
      }
      if (event.type === "text_delta") {
        return prev.map((m) => {
          if (m.id !== event.id || m.role !== "assistant") return m;
          const blocks = ensureAssistantBlock(m.blocks, event.index, {
            type: "text",
            text: "",
          });
          const block = blocks[event.index];
          if (block.type === "text") {
            blocks[event.index] = {
              type: "text",
              text: block.text + event.delta,
            };
          }
          return { ...m, blocks };
        });
      }
      if (event.type === "thinking_delta") {
        return prev.map((m) => {
          if (m.id !== event.id || m.role !== "assistant") return m;
          const blocks = ensureAssistantBlock(m.blocks, event.index, {
            type: "thinking",
            text: "",
          });
          const block = blocks[event.index];
          if (block.type === "thinking") {
            blocks[event.index] = {
              type: "thinking",
              text: block.text + event.delta,
            };
          }
          return { ...m, blocks };
        });
      }
      if (event.type === "tool_call_start") {
        return prev.map((m) => {
          if (m.id !== event.id || m.role !== "assistant") return m;
          const blocks = ensureAssistantBlock(m.blocks, event.index, {
            type: "tool",
            name: event.name,
            argsBuilding: "",
          });
          blocks[event.index] = {
            type: "tool",
            name: event.name,
            argsBuilding: "",
          };
          return { ...m, blocks };
        });
      }
      if (event.type === "tool_call_delta") {
        return prev.map((m) => {
          if (m.id !== event.id || m.role !== "assistant") return m;
          const blocks = ensureAssistantBlock(m.blocks, event.index, {
            type: "tool",
            name: "",
            argsBuilding: "",
          });
          const block = blocks[event.index];
          if (block.type === "tool") {
            blocks[event.index] = {
              ...block,
              argsBuilding: (block.argsBuilding ?? "") + event.delta,
            };
          }
          return { ...m, blocks };
        });
      }
      if (event.type === "tool_call") {
        return prev.map((m) => {
          if (m.id !== event.id || m.role !== "assistant") return m;
          const blocks = ensureAssistantBlock(m.blocks, event.index, {
            type: "tool",
            toolCallId: event.toolCallId,
            name: event.name,
          });
          const prior = blocks[event.index];
          blocks[event.index] = {
            type: "tool",
            toolCallId: event.toolCallId,
            name: event.name,
            args: event.args,
            argsBuilding: undefined,
            runningSince:
              prior.type === "tool" ? prior.runningSince : undefined,
            partial: prior.type === "tool" ? prior.partial : undefined,
          };
          return { ...m, blocks };
        });
      }
      if (event.type === "tool_running") {
        return prev.map((m) => {
          if (m.role !== "assistant") return m;
          const idx = m.blocks.findIndex(
            (b) => b.type === "tool" && b.toolCallId === event.toolCallId,
          );
          if (idx < 0) return m;
          const blocks = m.blocks.slice();
          const b = blocks[idx];
          if (b.type === "tool") {
            blocks[idx] = {
              ...b,
              runningSince: event.startedAt,
              runningPhrase: b.runningPhrase ?? pickRunningPhrase(),
            };
          }
          return { ...m, blocks };
        });
      }
      if (event.type === "tool_partial") {
        return prev.map((m) => {
          if (m.role !== "assistant") return m;
          const idx = m.blocks.findIndex(
            (b) => b.type === "tool" && b.toolCallId === event.toolCallId,
          );
          if (idx < 0) return m;
          const blocks = m.blocks.slice();
          const b = blocks[idx];
          if (b.type === "tool") {
            blocks[idx] = { ...b, partial: event.partial };
          }
          return { ...m, blocks };
        });
      }
      if (event.type === "tool_result") {
        return prev.map((m) => {
          if (m.role !== "assistant") return m;
          const idx = m.blocks.findIndex(
            (b) => b.type === "tool" && b.toolCallId === event.toolCallId,
          );
          if (idx < 0) return m;
          const blocks = m.blocks.slice();
          const b = blocks[idx];
          if (b.type === "tool") {
            blocks[idx] = {
              ...b,
              result: event.result,
              isError: event.isError,
              partial: undefined,
              runningSince: undefined,
            };
          }
          return { ...m, blocks };
        });
      }
      return prev;
    });
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setError(null);
    setMessages((prev) => [
      ...prev,
      {
        id: makeId(),
        role: "user",
        text: trimmed,
        timestamp: Date.now(),
      },
    ]);
    setInput("");
    setIsStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/chats/${chatId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Request failed: ${res.status} ${res.statusText}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const evt of events) {
          const line = evt.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let data: ServerEvent;
          try {
            data = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (data.type === "error") {
            setError(data.message);
          } else {
            applyEvent(data);
            if (data.type === "tool_result" && filesOpen) {
              refreshFiles();
            }
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      ctx.refreshChats();
      if (filesOpen) refreshFiles();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  async function saveTitle() {
    const next = title.trim();
    if (!next || next === chat.title) return;
    await patchChat({ title: next });
  }

  return (
    <div className="flex h-full min-w-0">
    <div className="flex flex-col h-full flex-1 min-w-0">
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 flex items-center gap-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="flex-1 min-w-0 bg-transparent font-semibold tracking-tight text-sm focus:outline-none"
        />
        <select
          value={model}
          onChange={async (e) => {
            const next = e.target.value;
            setModel(next);
            await patchChat({ model: next });
          }}
          disabled={isStreaming}
          className="text-xs rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={thinking}
          onChange={async (e) => {
            const next = e.target.value;
            setThinking(next);
            await patchChat({ thinkingLevel: next });
          }}
          disabled={isStreaming}
          className="text-xs rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1"
          title="thinking level"
        >
          {thinkingLevels.map((t) => (
            <option key={t} value={t}>
              think: {t}
            </option>
          ))}
        </select>
        <UsageBadge totals={totals} />
        <button
          type="button"
          onClick={() => setFilesOpen((v) => !v)}
          className={
            "text-xs rounded border px-2 py-1 " +
            (filesOpen
              ? "bg-neutral-900 text-white border-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 dark:border-neutral-100"
              : "border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900")
          }
          title="workspace files"
        >
          📁 {files.length > 0 && filesOpen ? files.length : "Files"}
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.length === 0 && (
            <div className="text-sm text-neutral-500">
              Send a message to start. The agent has read/bash/edit/write tools
              scoped to <code>data/workspaces/{chatId.slice(0, 8)}…</code>.
            </div>
          )}
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              modelLabel={modelLabel}
              chatId={chatId}
              workspace={workspace}
            />
          ))}
          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-900 px-3 py-2 text-sm text-red-700 dark:text-red-300">
              {error}
            </div>
          )}
        </div>
      </div>

      <form
        className="border-t border-neutral-200 dark:border-neutral-800 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <div className="mx-auto max-w-3xl flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                !composingRef.current &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Send a message... (Shift+Enter for newline)"
            rows={2}
            className="flex-1 resize-none rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400"
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={stop}
              className="rounded-md bg-red-600 hover:bg-red-700 text-white px-4 py-2 text-sm"
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!input.trim()}
              className="rounded-md bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 text-white px-4 py-2 text-sm disabled:opacity-40"
            >
              Send
            </button>
          )}
        </div>
      </form>
    </div>
    {filesOpen && (
      <FilesPanel
        chatId={chatId}
        files={files}
        onRefresh={refreshFiles}
        onClose={() => setFilesOpen(false)}
      />
    )}
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function UsageBadge({ totals }: { totals: SessionTotals }) {
  const empty =
    totals.tokensInput === 0 &&
    totals.tokensOutput === 0 &&
    totals.cacheRead === 0 &&
    totals.cacheWrite === 0;
  if (empty) return null;
  return (
    <div
      className="text-[11px] font-mono text-neutral-600 dark:text-neutral-400 flex items-center gap-2 px-2 py-1 rounded border border-neutral-200 dark:border-neutral-800"
      title={`input ${totals.tokensInput} · output ${totals.tokensOutput} · cache r ${totals.cacheRead} · cache w ${totals.cacheWrite} · ${formatCost(totals.costUsd)}`}
    >
      <span>↑{formatNumber(totals.tokensInput)}</span>
      <span>↓{formatNumber(totals.tokensOutput)}</span>
      {totals.cacheRead > 0 && (
        <span className="text-emerald-600 dark:text-emerald-400">
          ⚡{formatNumber(totals.cacheRead)}
        </span>
      )}
      <span className="text-neutral-900 dark:text-neutral-200 font-semibold">
        {formatCost(totals.costUsd)}
      </span>
    </div>
  );
}

function formatFileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function FilesPanel({
  chatId,
  files,
  onRefresh,
  onClose,
}: {
  chatId: string;
  files: WorkspaceFile[];
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="w-80 shrink-0 border-l border-neutral-200 dark:border-neutral-800 flex flex-col bg-neutral-50 dark:bg-neutral-950">
      <div className="px-3 py-2 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-2">
        <span className="text-xs font-semibold tracking-wide">
          WORKSPACE FILES
        </span>
        <span className="text-xs text-neutral-500">{files.length}</span>
        <button
          type="button"
          onClick={onRefresh}
          className="ml-auto text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          title="refresh"
        >
          ↻
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          title="close"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {files.length === 0 && (
          <div className="px-3 py-4 text-xs text-neutral-500">
            No files yet. Ask the agent to create one.
          </div>
        )}
        {files.map((f) => {
          const encoded = f.path.split("/").map(encodeURIComponent).join("/");
          const view = `/api/chats/${encodeURIComponent(chatId)}/files/${encoded}`;
          return (
            <div
              key={f.path}
              className="group px-3 py-2 border-b border-neutral-100 dark:border-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              <div className="flex items-center gap-2 min-w-0">
                <a
                  href={view}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 min-w-0 truncate text-xs font-mono hover:underline"
                  title={f.path}
                >
                  {f.path}
                </a>
                <a
                  href={`${view}?dl`}
                  className="text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 text-xs"
                  title="download"
                >
                  ⬇
                </a>
              </div>
              <div className="mt-0.5 flex gap-2 text-[10px] text-neutral-500 font-mono">
                <span>{formatFileSize(f.size)}</span>
                <span>·</span>
                <span>{formatRelative(f.modified)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function MessageUsage({ usage }: { usage: UsageDelta }) {
  return (
    <div
      className="text-[10px] font-mono text-neutral-400 flex gap-3 pt-1 border-t border-neutral-100 dark:border-neutral-800"
      title={`input ${usage.input} · output ${usage.output} · cache r ${usage.cacheRead} · cache w ${usage.cacheWrite}`}
    >
      <span>↑{formatNumber(usage.input)}</span>
      <span>↓{formatNumber(usage.output)}</span>
      {usage.cacheRead > 0 && (
        <span className="text-emerald-500">⚡{formatNumber(usage.cacheRead)}</span>
      )}
      <span>{formatCost(usage.costUsd)}</span>
    </div>
  );
}

function MessageBubble({
  message,
  modelLabel,
  chatId,
  workspace,
}: {
  message: UiMessage;
  modelLabel: string;
  chatId: string;
  workspace: string;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full rounded-lg px-4 py-3 text-sm bg-white border border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 space-y-2">
        <div className="text-[10px] uppercase tracking-wider text-neutral-400">
          {modelLabel}
        </div>
        {message.blocks.length === 0 && (
          <span className="text-neutral-400 italic">…</span>
        )}
        {message.blocks.map((b, i) => (
          <BlockView
            key={i}
            block={b}
            chatId={chatId}
            workspace={workspace}
          />
        ))}
        {message.usage && <MessageUsage usage={message.usage} />}
      </div>
    </div>
  );
}

function summarizeToolCall(name: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  switch (name) {
    case "bash": {
      const cmd = typeof a.command === "string" ? a.command : "";
      return cmd ? `$ ${cmd.split("\n")[0].slice(0, 120)}` : null;
    }
    case "read":
      return typeof a.file_path === "string" ? `read ${a.file_path}` : null;
    case "write":
      return typeof a.file_path === "string" ? `write ${a.file_path}` : null;
    case "edit":
      return typeof a.file_path === "string" ? `edit ${a.file_path}` : null;
    case "ls":
      return typeof a.path === "string" ? `ls ${a.path}` : null;
    case "find":
      return typeof a.pattern === "string" ? `find ${a.pattern}` : null;
    case "grep":
      return typeof a.pattern === "string" ? `grep ${a.pattern}` : null;
    default:
      return null;
  }
}

function ElapsedSince({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const ms = Math.max(0, now - since);
  const s = Math.floor(ms / 1000);
  return <span className="tabular-nums">{s}s</span>;
}

function clipToLastLines(s: string, n: number): string {
  const lines = s.split("\n");
  if (lines.length <= n) return s;
  return `…\n${lines.slice(-n).join("\n")}`;
}

const URL_RE = /(https?:\/\/[^\s<>"'`]+|\/api\/chats\/[^\s<>"'`]+)/g;

function LinkifiedText({ text }: { text: string }) {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    let url = m[0];
    let trailing = "";
    while (url.length > 0 && /[.,;:!?)\]}'"`]/.test(url.slice(-1))) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    if (url.length > 0) {
      nodes.push(
        <a
          key={`${m.index}-${url}`}
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 dark:text-blue-400 underline underline-offset-2 hover:text-blue-700 dark:hover:text-blue-300 break-all"
        >
          {url}
        </a>,
      );
    }
    if (trailing) nodes.push(trailing);
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

function fileDownloadUrl(
  chatId: string,
  workspace: string,
  filePath: string,
): string | null {
  if (!filePath) return null;
  let rel: string;
  if (filePath.startsWith("/")) {
    if (filePath === workspace) return null;
    if (!filePath.startsWith(workspace + "/")) return null;
    rel = filePath.slice(workspace.length + 1);
  } else {
    rel = filePath;
  }
  if (!rel || rel.startsWith("..") || rel.includes("\0")) return null;
  const encoded = rel.split("/").map(encodeURIComponent).join("/");
  return `/api/chats/${encodeURIComponent(chatId)}/files/${encoded}`;
}

function extractFilePath(name: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (name === "read" || name === "write" || name === "edit") {
    return typeof a.file_path === "string" ? a.file_path : null;
  }
  return null;
}

function BlockView({
  block,
  chatId,
  workspace,
}: {
  block: UiBlock;
  chatId: string;
  workspace: string;
}) {
  if (block.type === "text") {
    return (
      <div className="whitespace-pre-wrap">
        <LinkifiedText text={block.text} />
      </div>
    );
  }
  if (block.type === "thinking") {
    return (
      <details className="text-xs text-neutral-500">
        <summary className="cursor-pointer">thinking</summary>
        <pre className="whitespace-pre-wrap mt-1">{block.text}</pre>
      </details>
    );
  }

  const summary =
    summarizeToolCall(block.name, block.args) ??
    (block.argsBuilding ? block.argsBuilding.split("\n")[0].slice(0, 120) : "");
  const phase: "preparing" | "running" | "done" =
    block.result !== undefined
      ? "done"
      : block.runningSince
        ? "running"
        : "preparing";
  const indicator =
    phase === "done" ? "" : phase === "running" ? "▶" : "✎";

  return (
    <details
      className={
        "rounded border text-xs " +
        (block.isError
          ? "border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40"
          : "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950")
      }
    >
      <summary className="cursor-pointer px-2 py-1 font-mono flex items-center gap-2">
        {phase !== "done" && (
          <span className="text-neutral-400 animate-pulse">{indicator}</span>
        )}
        <span className="font-semibold">{block.name || "tool"}</span>
        {summary && (
          <span className="text-neutral-500 truncate min-w-0">{summary}</span>
        )}
        <span className="ml-auto flex items-center gap-2 text-neutral-400 shrink-0">
          {phase === "running" && (
            <span className="italic text-neutral-500">
              {block.runningPhrase ?? "실행 중"}
            </span>
          )}
          {phase === "running" && block.runningSince && (
            <ElapsedSince since={block.runningSince} />
          )}
          {block.isError && <span>⚠️</span>}
          {phase === "done" &&
            !block.isError &&
            (() => {
              const fp = extractFilePath(block.name, block.args);
              const href = fp ? fileDownloadUrl(chatId, workspace, fp) : null;
              if (!href) return null;
              return (
                <span className="flex items-center gap-1">
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="hover:text-neutral-700 dark:hover:text-neutral-200"
                    title="open in new tab"
                  >
                    ↗
                  </a>
                  <a
                    href={`${href}?dl`}
                    onClick={(e) => e.stopPropagation()}
                    className="hover:text-neutral-700 dark:hover:text-neutral-200"
                    title="download"
                  >
                    ⬇
                  </a>
                </span>
              );
            })()}
        </span>
      </summary>
      <div className="px-2 py-2 space-y-2">
        <div>
          <div className="text-neutral-500 mb-1">
            {block.args === undefined ? "args (streaming)" : "args"}
          </div>
          <pre className="whitespace-pre-wrap font-mono">
            {block.args !== undefined
              ? JSON.stringify(block.args, null, 2)
              : (block.argsBuilding ?? "")}
            {block.args === undefined && (
              <span className="text-neutral-400 animate-pulse">▍</span>
            )}
          </pre>
        </div>
        {(block.result ?? block.partial) && (
          <div>
            <div className="text-neutral-500 mb-1">
              {block.result
                ? "result"
                : `output (streaming, last 5 lines)`}
            </div>
            <pre className="whitespace-pre-wrap font-mono">
              <LinkifiedText
                text={
                  block.result
                    ? block.result
                    : clipToLastLines(block.partial as string, 5)
                }
              />
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
