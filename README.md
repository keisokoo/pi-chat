# Pi Chat Agent

[`@mariozechner/pi-coding-agent`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) SDK를 React Router 7로 감싼 채팅 에이전트 웹 앱. Anthropic Claude를 백엔드로 쓰고, 채팅별로 격리된 작업 디렉토리에서 read/bash/edit/write 도구를 실행한다.

## 스택

- **React Router v7** (framework mode, Vite, SSR)
- **TypeScript / Tailwind v4**
- **`@mariozechner/pi-coding-agent`** — 에이전트 코어. 모델/도구/세션 관리 일괄
- **`@mariozechner/pi-ai`** — 모델 레지스트리 (Anthropic Claude)
- **Drizzle ORM + better-sqlite3** — 채팅 메타데이터 저장
- **SDK 내장 JSONL 세션** — 에이전트 컨텍스트(메시지 트리)의 source of truth

## 기능

- 사이드바 채팅 목록, 새 채팅 생성/삭제
- 채팅별 모델 / thinking level 전환 (라이브 적용)
- 메시지 스트리밍: 텍스트, 생각, 툴 호출/결과를 SSE로 실시간 표시
- 채팅별 샌드박스 (`./data/workspaces/<chatId>`) 안에서만 도구 실행
- 새로고침/서버 재시작 후에도 대화 컨텍스트 복원 (JSONL 기반)
- 한글 IME 조합 중 Enter 무시 + 응답 끝나면 입력창 자동 포커스

## 빠른 시작

```bash
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
npm run dev
# → http://localhost:5173
```

`data/app.db`(SQLite), `data/sessions/`(JSONL), `data/workspaces/`(샌드박스)는 첫 실행에 자동 생성된다. `.gitignore`에 `data/` 포함됨.

## 환경 변수

| 이름 | 필수 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | Claude API 키. 실제 메시지 전송 시점에만 검증. |
| `PI_MODEL` | | 기본 모델 ID 오버라이드 (default: `claude-sonnet-4-6`). |

추가 모델은 [app/lib/agent.server.ts](app/lib/agent.server.ts)의 `AVAILABLE_MODELS` 배열에 등록.

## 프로젝트 구조

```
app/
├── db/
│   ├── schema.ts            # Drizzle 스키마 (chats 테이블)
│   └── index.server.ts      # SQLite 연결 + 부트스트랩 CREATE
├── lib/
│   ├── agent.server.ts      # createAgentSession 래퍼, 채팅별 세션 맵
│   ├── messages.server.ts   # JSONL → UI 메시지 변환
│   └── types.ts             # SSE 프로토콜, UI 메시지 타입 (공유)
├── routes/
│   ├── chat-layout.tsx      # 사이드바 + Outlet
│   ├── chat-index.tsx       # 빈 상태
│   ├── chat.$id.tsx         # 채팅 상세 (loader + UI + 스트리밍 클라이언트)
│   ├── api.chats.ts         # GET 목록 / POST 생성
│   ├── api.chats.$id.ts     # PATCH 메타 / DELETE
│   ├── api.chats.$id.messages.ts  # GET 메시지 (콜드 로드)
│   ├── api.chats.$id.message.ts   # POST 메시지 → SSE 스트리밍
│   └── well-known.chrome-devtools.ts  # 크롬 DevTools 404 침묵
├── routes.ts                # 라우트 트리
└── root.tsx
data/                        # 런타임 생성 (gitignored)
├── app.db
├── sessions/<sessionId>.jsonl
└── workspaces/<chatId>/
```

## 아키텍처: 하이브리드 영속화

DB 단일화는 SDK가 `SessionManager` 백엔드 교체 인터페이스를 안 노출해서 비현실적. 그래서 둘로 쪼갰다.

| 저장소 | 담당 |
|---|---|
| **SQLite (Drizzle)** | 채팅 ID, 제목, 모델, thinking level, 세션파일 경로, 작업디렉토리 경로, 타임스탬프 |
| **JSONL (`SessionManager`)** | 메시지/툴콜/툴결과 트리 — 모델에 보내는 컨텍스트 그 자체 |

채팅을 열 때:
1. 라우트 loader가 DB에서 `chat` 조회
2. `sessionFile`이 있으면 `SessionManager.open()`으로 JSONL을 메모리에 펼치고 → `buildSessionContext()` → UI 메시지 변환 (콜드 로드)
3. 사용자가 첫 메시지를 보내는 시점에 `getOrCreateSession`이 `createAgentSession()`으로 에이전트 인스턴스화 (메모리 맵에 보관)
4. `agent.sessionFile`을 DB에 기록 (첫 turn 후)

서버 재시작 = 메모리 맵 비워짐 + 디스크 그대로 → 다음 메시지 때 자동 재구성.

## 스트리밍 프로토콜

POST `/api/chats/:id/message` → `text/event-stream`. 각 이벤트는 `data: {...}\n\n`. 타입은 [app/lib/types.ts](app/lib/types.ts)의 `ServerEvent`:

| 타입 | 페이로드 | 설명 |
|---|---|---|
| `assistant_start` | `{ id }` | 새 어시스턴트 메시지 시작 (멀티턴이면 여러 번) |
| `text_delta` | `{ id, index, delta }` | 텍스트 청크. `index`는 어시스턴트 메시지 내 블록 위치 |
| `thinking_delta` | `{ id, index, delta }` | extended thinking 청크 |
| `tool_call` | `{ id, index, toolCallId, name, args }` | LLM이 툴 호출 결정 |
| `tool_partial` | `{ toolCallId, partial }` | 툴 실행 중 부분 결과 (예: bash stdout) |
| `tool_result` | `{ toolCallId, result, isError }` | 툴 완료 |
| `done` | — | agent_end. 클라이언트 스트림 종료 |
| `error` | `{ message }` | API 에러 등 |

서버 측 매핑은 [app/routes/api.chats.$id.message.ts](app/routes/api.chats.$id.message.ts)에서 SDK의 `AgentSessionEvent` → SSE 변환 한 곳에 집중.

## 도구 추가

```ts
// app/lib/tools/web-search.ts
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export const webSearch = defineTool({
  name: "web_search",
  label: "Web search",
  description: "Search the web for current information beyond the model's training cutoff.",
  promptSnippet: "web_search(query): live web results",
  parameters: Type.Object({
    query: Type.String(),
    max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  }),
  executionMode: "parallel",
  async execute(_id, params, signal, onUpdate) {
    onUpdate?.({ content: [{ type: "text", text: `searching: ${params.query}` }], details: {} });
    const res = await fetch("https://api.tavily.com/search", { signal, /* ... */ });
    const data = await res.json();
    return {
      content: [{ type: "text", text: formatResults(data) }],
      details: { count: data.results.length },
    };
  },
});
```

[app/lib/agent.server.ts](app/lib/agent.server.ts)의 `createAgentSession({...})`에 `customTools: [webSearch]`만 추가하면 끝. 빌트인 도구는 그대로 살아있고, 모델 system prompt의 도구 섹션에도 자동 합류.

도구 설계 시:
- `description`은 LLM이 읽음 — 언제 써야 하는지 명확히
- `signal`을 fetch에 전달해야 사용자 Stop 버튼이 도구까지 끊음
- `onUpdate(partial)`은 `tool_execution_update` → 클라이언트 `tool_partial` SSE → UI 자동 펼침
- `content`만 LLM에 들어감, `details`는 UI/로그 전용

## 스크립트

```bash
npm run dev          # vite + RR 개발 서버
npm run build        # 프로덕션 빌드
npm run start        # 빌드된 서버 실행
npm run typecheck    # react-router typegen + tsc
```

## 알려진 한계

- 다중 사용자/인증 없음 (로컬 단일 사용자 가정)
- 채팅 제목 자동 생성 미구현 (수동 편집)
- 도구 화이트리스트 UI 미구현 (전 채팅 동일하게 read/bash/edit/write)
- 첨부 이미지 미지원 (SDK는 지원, UI 미구현)
