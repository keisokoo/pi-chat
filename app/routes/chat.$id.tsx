import { useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/chat.$id";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import {
  AVAILABLE_MODELS,
  THINKING_LEVELS,
} from "../lib/agent.server";
import { loadMessagesForChat } from "../lib/messages.server";
import type { ServerEvent, UiBlock, UiMessage } from "../lib/types";

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
    messages,
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
  const { chat, models, thinkingLevels, messages: initialMessages } = loaderData;
  const ctx = useOutletContext<OutletCtx>();
  const [messages, setMessages] = useState<UiMessage[]>(initialMessages);
  const [title, setTitle] = useState(chat.title);
  const [model, setModel] = useState(chat.model);
  const [thinking, setThinking] = useState(chat.thinkingLevel);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const chatId = chat.id;

  useEffect(() => {
    setMessages(initialMessages);
    setTitle(chat.title);
    setModel(chat.model);
    setThinking(chat.thinkingLevel);
    setError(null);
  }, [chatId, chat.title, chat.model, chat.thinkingLevel, initialMessages]);

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
      if (event.type === "tool_call") {
        return prev.map((m) => {
          if (m.id !== event.id || m.role !== "assistant") return m;
          const blocks = ensureAssistantBlock(m.blocks, event.index, {
            type: "tool",
            toolCallId: event.toolCallId,
            name: event.name,
            args: event.args,
          });
          blocks[event.index] = {
            type: "tool",
            toolCallId: event.toolCallId,
            name: event.name,
            args: event.args,
          };
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
    <div className="flex flex-col h-full">
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
  );
}

function MessageBubble({
  message,
  modelLabel,
}: {
  message: UiMessage;
  modelLabel: string;
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
          <BlockView key={i} block={b} />
        ))}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: UiBlock }) {
  if (block.type === "text") {
    return <div className="whitespace-pre-wrap">{block.text}</div>;
  }
  if (block.type === "thinking") {
    return (
      <details className="text-xs text-neutral-500">
        <summary className="cursor-pointer">thinking</summary>
        <pre className="whitespace-pre-wrap mt-1">{block.text}</pre>
      </details>
    );
  }
  return (
    <details
      className={
        "rounded border text-xs " +
        (block.isError
          ? "border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40"
          : "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950")
      }
      open={!block.result && !!block.partial}
    >
      <summary className="cursor-pointer px-2 py-1 font-mono">
        <span className="font-semibold">{block.name}</span>
        {block.result ? "" : block.partial ? "  ⏳" : "  …"}
        {block.isError ? "  ⚠️" : ""}
      </summary>
      <div className="px-2 py-2 space-y-2">
        <div>
          <div className="text-neutral-500 mb-1">args</div>
          <pre className="whitespace-pre-wrap font-mono">
            {JSON.stringify(block.args, null, 2)}
          </pre>
        </div>
        {(block.result ?? block.partial) && (
          <div>
            <div className="text-neutral-500 mb-1">
              {block.result ? "result" : "partial"}
            </div>
            <pre className="whitespace-pre-wrap font-mono">
              {block.result ?? block.partial}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}
