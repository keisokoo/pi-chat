export type UiBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool";
      toolCallId: string;
      name: string;
      args: unknown;
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
    };

export type ServerEvent =
  | { type: "assistant_start"; id: string }
  | { type: "text_delta"; id: string; index: number; delta: string }
  | { type: "thinking_delta"; id: string; index: number; delta: string }
  | {
      type: "tool_call";
      id: string;
      index: number;
      toolCallId: string;
      name: string;
      args: unknown;
    }
  | { type: "tool_partial"; toolCallId: string; partial: string }
  | {
      type: "tool_result";
      toolCallId: string;
      result: string;
      isError: boolean;
    }
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
