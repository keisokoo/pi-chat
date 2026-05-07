# CLAUDE.md

Guidance for Claude Code working on this repo. Keep this file short — read [README.md](README.md) for full context.

## What this is

A web chat UI for `@mariozechner/pi-coding-agent` (Anthropic Claude SDK with built-in coding tools). React Router 7 framework mode, TypeScript, Tailwind v4. Persistence is hybrid: Drizzle/SQLite for chat metadata, SDK's JSONL files for the agent's conversation tree.

## Architecture in one breath

- `app/db/` — SQLite via Drizzle. One table: `chats`. Bootstrapped via `CREATE TABLE IF NOT EXISTS` in `index.server.ts` — no migrations.
- `app/lib/agent.server.ts` — `Map<chatId, Promise<AgentSession>>`. `getOrCreateSession` is the only entry; it lazily creates the SDK session, opening or creating a JSONL session file under `data/sessions/`. Each chat's `cwd` is its sandbox at `data/workspaces/<chatId>/` — never `process.cwd()`.
- `app/lib/messages.server.ts` — Cold-load: read JSONL via `SessionManager.open(path).buildSessionContext()` → convert `AgentMessage[]` to `UiMessage[]`. Independent of agent instantiation (no API key needed for cold load).
- `app/routes/api.chats.$id.message.ts` — The streaming endpoint. Subscribes to `AgentSessionEvent` and emits the SSE `ServerEvent` protocol defined in `app/lib/types.ts`.
- `app/routes/chat.$id.tsx` — Loader hits DB + cold-load. Client maintains `UiMessage[]` and applies SSE events (`applyEvent`) to incrementally fill blocks at the right `contentIndex`.

## Conventions / don't break

- **Server-only modules end in `.server.ts`** — RR7 strips them from the client bundle. `app/db/index.server.ts`, `app/lib/agent.server.ts`, `app/lib/messages.server.ts`. If a module imports `node:fs` or `better-sqlite3`, it must be `.server`.
- **Drizzle better-sqlite3 is synchronous** — no `await` on `.get()`, `.run()`, `.all()`. Don't add it.
- **Sandbox cwd is non-negotiable.** Tools (read/bash/edit/write) run under `chat.workspace`. Never let `cwd` fall back to `process.cwd()` — that exposes the app source.
- **SSE protocol is in [app/lib/types.ts](app/lib/types.ts)** (`ServerEvent`). Both server emit and client `applyEvent` reduce over it. If you add a new event type, update both sides plus the README protocol table.
- **Block ordering uses `contentIndex` from the SDK's `AssistantMessageEvent`.** Multiple turns produce multiple `assistant_start` events with separate `id`s; tool results are matched by `toolCallId` across blocks. Don't collapse turns into one bubble.
- **IME composition handling** in [app/routes/chat.$id.tsx](app/routes/chat.$id.tsx) uses three guards (`isComposing`, `keyCode !== 229`, `composingRef`). All three are needed for cross-browser Korean IME — don't simplify.
- **No comments** describing what code does. The codebase follows the parent guideline. Keep additions in that style.

## Verifying changes

```bash
npm run typecheck    # required before claiming done
npm run dev          # http://localhost:5173

# Smoke tests without an API key (errors should flow through SSE, not crash):
curl -s -X POST localhost:5173/api/chats -H 'content-type: application/json' -d '{}'
curl -s -N -X POST localhost:5173/api/chats/<id>/message \
  -H 'content-type: application/json' -d '{"message":"hi"}' --max-time 5
```

UI changes: actually open the browser and test streaming + tool execution + IME (한글로 enter). Typecheck doesn't catch UX regressions.

## Adding a tool

1. Create `app/lib/tools/<name>.ts` exporting `defineTool({...})` from `@mariozechner/pi-coding-agent` with a `typebox` schema.
2. Add to the `customTools: [...]` array in `createAgentSession()` inside [app/lib/agent.server.ts](app/lib/agent.server.ts).
3. Pass `signal` to all `fetch` calls so user Stop cancels the tool.
4. Call `onUpdate({ content, details })` for streaming progress — it routes to `tool_partial` → UI auto-expands the tool block.
5. Only `content` is sent to the LLM; `details` is UI/logs only.

See README "도구 추가" section for the full pattern.

## Things I keep almost forgetting

- `getOrCreateSession` returns a `Promise<AgentSession>` already in the map; do not double-wrap.
- `session.sessionFile` becomes available only after the first turn — write to `chats.sessionFile` only when it's defined and differs from the DB row.
- Cold load (`loadMessagesForChat`) does NOT spin up an agent and does NOT need `ANTHROPIC_API_KEY`. Don't add a key check there.
- `application/x-ndjson` is tempting but the client's SSE parser expects `data: ...\n\n` framing — keep it SSE.
