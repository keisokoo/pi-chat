import type { Route } from "./+types/chat-index";

export function meta(_: Route.MetaArgs) {
  return [{ title: "Pi Chat Agent" }];
}

export default function ChatIndex() {
  return (
    <div className="h-full flex items-center justify-center text-sm text-neutral-500">
      Select a chat or create a new one.
    </div>
  );
}
