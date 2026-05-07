import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/api.chats.$id.files";
import { db } from "../db/index.server";
import { chats } from "../db/schema";
import { workspaceFor } from "../lib/agent.server";

export interface WorkspaceFile {
  path: string;
  size: number;
  modified: number;
}

export async function loader({ params }: Route.LoaderArgs) {
  const id = params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const chat = db.select().from(chats).where(eq(chats.id, id)).get();
  if (!chat) return new Response("chat not found", { status: 404 });

  const workspace = workspaceFor(id);
  if (!existsSync(workspace)) return Response.json({ files: [] });

  const files: WorkspaceFile[] = [];

  function walk(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      // never follow symlinks — they could escape the workspace
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        try {
          const st = statSync(full);
          files.push({
            path: relative(workspace, full),
            size: st.size,
            modified: st.mtimeMs,
          });
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }

  walk(workspace);
  files.sort((a, b) => b.modified - a.modified);
  return Response.json({ files });
}
