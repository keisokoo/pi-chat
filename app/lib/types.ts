export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
}

export interface SessionTotals {
  tokensInput: number;
  tokensOutput: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export type UiBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      /** Final id, only available after tool_call (end). */
      toolCallId?: string;
      name: string;
      /** Final parsed args once toolcall_end arrives. */
      args?: unknown;
      /** Raw JSON text accumulated during toolcall_delta. */
      argsBuilding?: string;
      /** Set when tool_running arrives (epoch ms). */
      runningSince?: number;
      result?: string;
      partial?: string;
      isError?: boolean;
    };

export type UiMessage =
  | { id: string; role: "user"; text: string; timestamp: number }
  | {
      id: string;
      role: "assistant";
      blocks: UiBlock[];
      timestamp: number;
      usage?: UsageDelta;
    };

export type ServerEvent =
  | { type: "assistant_start"; id: string }
  | { type: "text_delta"; id: string; index: number; delta: string }
  | { type: "thinking_delta"; id: string; index: number; delta: string }
  | { type: "tool_call_start"; id: string; index: number; name: string }
  | { type: "tool_call_delta"; id: string; index: number; delta: string }
  | {
      type: "tool_call";
      id: string;
      index: number;
      toolCallId: string;
      name: string;
      args: unknown;
    }
  | { type: "tool_running"; toolCallId: string; startedAt: number }
  | { type: "tool_partial"; toolCallId: string; partial: string }
  | {
      type: "tool_result";
      toolCallId: string;
      result: string;
      isError: boolean;
    }
  | { type: "assistant_usage"; id: string; usage: UsageDelta }
  | { type: "session_totals"; totals: SessionTotals }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ChatRow {
  id: string;
  title: string;
  model: string;
  thinkingLevel: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
}
