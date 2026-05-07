import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router";

interface ChatRow {
  id: string;
  title: string;
  model: string;
  thinkingLevel: string;
  updatedAt: number;
}

interface ChatsResponse {
  chats: ChatRow[];
  models: { id: string; label: string }[];
}

export default function ChatLayout() {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const params = useParams();

  async function refresh() {
    const res = await fetch("/api/chats");
    if (res.ok) {
      const data = (await res.json()) as ChatsResponse;
      setChats(data.chats);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function createChat() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      const chat = (await res.json()) as ChatRow;
      await refresh();
      navigate(`/chat/${chat.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function deleteChat(id: string) {
    if (!confirm("Delete this chat?")) return;
    const res = await fetch(`/api/chats/${id}`, { method: "DELETE" });
    if (!res.ok) return;
    await refresh();
    if (params.id === id) navigate("/");
  }

  return (
    <div className="flex h-screen bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <aside className="w-72 shrink-0 border-r border-neutral-200 dark:border-neutral-800 flex flex-col">
        <div className="p-3 border-b border-neutral-200 dark:border-neutral-800">
          <Link
            to="/"
            className="block text-sm font-semibold tracking-tight mb-2"
          >
            Pi Chat Agent
          </Link>
          <button
            type="button"
            onClick={createChat}
            disabled={creating}
            className="w-full text-sm rounded-md bg-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 text-white py-2 px-3 disabled:opacity-50"
          >
            + New chat
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {chats.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">
              No chats yet
            </div>
          )}
          {chats.map((c) => (
            <div key={c.id} className="group relative">
              <NavLink
                to={`/chat/${c.id}`}
                className={({ isActive }) =>
                  "block px-3 py-2 text-sm truncate hover:bg-neutral-100 dark:hover:bg-neutral-900 " +
                  (isActive
                    ? "bg-neutral-100 dark:bg-neutral-900 font-medium"
                    : "")
                }
              >
                <div className="truncate">{c.title}</div>
                <div className="text-xs text-neutral-500 truncate">
                  {c.model}
                </div>
              </NavLink>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  deleteChat(c.id);
                }}
                className="absolute right-2 top-2 hidden group-hover:block text-xs text-neutral-500 hover:text-red-500"
                aria-label="Delete chat"
              >
                ✕
              </button>
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1 min-w-0 flex flex-col">
        <Outlet context={{ refreshChats: refresh }} />
      </main>
    </div>
  );
}
