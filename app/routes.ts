import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  layout("routes/chat-layout.tsx", [
    index("routes/chat-index.tsx"),
    route("chat/:id", "routes/chat.$id.tsx"),
  ]),
  route("api/chats", "routes/api.chats.ts"),
  route("api/chats/:id", "routes/api.chats.$id.ts"),
  route("api/chats/:id/messages", "routes/api.chats.$id.messages.ts"),
  route("api/chats/:id/message", "routes/api.chats.$id.message.ts"),
  route("api/chats/:id/files", "routes/api.chats.$id.files.ts"),
  route("api/chats/:id/files/*", "routes/api.chats.$id.files.serve.ts"),
  route(
    ".well-known/appspecific/com.chrome.devtools.json",
    "routes/well-known.chrome-devtools.ts",
  ),
] satisfies RouteConfig;
