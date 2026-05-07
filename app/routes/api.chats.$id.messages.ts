import type { Route } from "./+types/api.chats.$id.messages";
import { loadMessagesForChat } from "../lib/messages.server";

export async function loader({ params }: Route.LoaderArgs) {
  const id = params.id;
  if (!id) return new Response("missing id", { status: 400 });
  const messages = loadMessagesForChat(id);
  return Response.json({ messages });
}
