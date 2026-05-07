import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { basename, relative, resolve } from "node:path";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/api.chats.$id.files.serve";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import { workspaceFor } from "../lib/agent.server";

const MIME: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  ts: "text/plain; charset=utf-8",
  tsx: "text/plain; charset=utf-8",
  jsx: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
  yml: "application/yaml; charset=utf-8",
  toml: "application/toml; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  py: "text/plain; charset=utf-8",
  sh: "text/plain; charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
};

function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function quoteHeader(value: string): string {
  return value.replace(/[\\\\"]/g, "\\$&");
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const id = params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) return new Response("chat not found", { status: 404 });

  const splat = (params as Record<string, unknown>)["*"];
  const sub = typeof splat === "string" ? splat : "";
  if (!sub) return new Response("missing path", { status: 400 });

  const workspace = workspaceFor(id);
  const target = resolve(workspace, sub);
  const rel = relative(workspace, target);
  if (rel === "" || rel.startsWith("..") || rel.includes("\0")) {
    return new Response("forbidden", { status: 403 });
  }
  if (!existsSync(target)) return new Response("not found", { status: 404 });
  const st = statSync(target);
  if (!st.isFile()) return new Response("not a file", { status: 400 });

  const url = new URL(request.url);
  const wantsDl = url.searchParams.has("dl");
  const name = basename(target);
  const disposition = `${wantsDl ? "attachment" : "inline"}; filename="${quoteHeader(name)}"`;

  const stream = Readable.toWeb(
    createReadStream(target),
  ) as ReadableStream<Uint8Array>;

  return new Response(stream, {
    headers: {
      "Content-Type": mimeOf(name),
      "Content-Length": String(st.size),
      "Content-Disposition": disposition,
      "Cache-Control": "private, max-age=0",
    },
  });
}
