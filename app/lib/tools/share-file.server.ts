import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const DESCRIPTION = `Generate a shareable URL for a file in the workspace so the user can preview or download it from the chat UI.

WHEN TO USE:
- After creating, modifying, or generating a file the user might want to retrieve (reports, scripts, images, archives, data exports, build artifacts).
- After the user explicitly asks for a download link.

WHEN NOT TO USE:
- For trivial output that fits in a few lines — paste the content directly in your response instead.
- For files outside the working directory.

Path can be relative to cwd or absolute (must resolve inside the workspace). Set force_download=true to force the browser to save the file rather than render it inline.

The returned URL is plain HTTP relative to this app's origin; quote it verbatim in your response and the user's chat client will render it as a clickable link.`;

const ParamsSchema = Type.Object({
  file_path: Type.String({
    description:
      "Path to the file. Relative to the working directory, or absolute (inside the workspace).",
  }),
  force_download: Type.Optional(
    Type.Boolean({
      description:
        "If true, append ?dl so the browser downloads instead of previewing. Default false.",
    }),
  ),
});

interface ShareFileDetails {
  url?: string;
  path?: string;
  size?: number;
  error?: "outside_workspace" | "not_found" | "not_a_file";
  attempted?: string;
}

export function createShareFileTool(chatId: string, workspace: string) {
  return defineTool<typeof ParamsSchema, ShareFileDetails>({
    name: "share_file",
    label: "Share file",
    description: DESCRIPTION,
    promptSnippet:
      "share_file(file_path, force_download?): make a workspace file downloadable as a URL",
    parameters: ParamsSchema,
    executionMode: "parallel",
    async execute(_id, params) {
      const input = params.file_path;
      const target = isAbsolute(input)
        ? resolve(input)
        : resolve(workspace, input);
      const rel = relative(workspace, target);

      if (rel === "" || rel.startsWith("..") || rel.includes("\0")) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${input} is outside the workspace and cannot be shared.`,
            },
          ],
          details: { error: "outside_workspace", attempted: input },
        };
      }
      if (!existsSync(target)) {
        return {
          content: [
            { type: "text", text: `Error: file not found at ${input}.` },
          ],
          details: { error: "not_found", attempted: input },
        };
      }
      const st = statSync(target);
      if (!st.isFile()) {
        return {
          content: [
            { type: "text", text: `Error: ${input} is not a regular file.` },
          ],
          details: { error: "not_a_file", attempted: input },
        };
      }

      const encoded = rel.split("/").map(encodeURIComponent).join("/");
      const base = `/api/chats/${encodeURIComponent(chatId)}/files/${encoded}`;
      const url = params.force_download ? `${base}?dl` : base;

      return {
        content: [
          {
            type: "text",
            text: `Share URL: ${url}\nFile: ${rel} (${st.size} bytes)\nQuote the URL above in your reply so the user can click it.`,
          },
        ],
        details: { url, path: rel, size: st.size },
      };
    },
  });
}
