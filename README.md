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
- **토큰/비용 추적** — 메시지별 + 누적 (`input/output/cache read/write`, USD). DB에 영속, 헤더와 어시스턴트 버블에 표시
- 채팅별 작업 디렉토리 (`./data/workspaces/<chatId>`) — Docker 안에선 추가로 컨테이너 격리
- 새로고침/서버 재시작 후에도 대화 컨텍스트 복원 (JSONL 기반)
- 한글 IME 조합 중 Enter 무시 + 응답 끝나면 입력창 자동 포커스

## 빠른 시작 — Docker (권장)

에이전트의 `bash`/`edit`/`write` 도구는 cwd 샌드박스 밖으로도 나갈 수 있다 (`cd ..`, 절대경로). 따라서 **호스트에서 직접 띄우면 진짜로 시스템을 건드릴 수 있음.** Docker로 격리하는 것이 정상 사용법.

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env
docker compose up --build      # 첫 실행 (이미지 빌드 포함)
docker compose up              # 이후 실행
# → http://localhost:3000
```

- `./data` 가 컨테이너의 `/app/data`로 마운트됨 (SQLite + JSONL 세션 + 채팅별 샌드박스)
- 컨테이너 내부의 다른 경로(`/usr`, `/etc` 등)는 ephemeral — 도구가 망가뜨려도 재기동 시 복구
- 단, 도구가 마운트된 `/app/data`는 손댈 수 있음 (호스트 `./data` 그대로 반영). 채팅 데이터를 잃기 싫으면 가끔 백업.

## 빠른 시작 — 로컬 개발 (UI 작업용)

UI/스타일만 손볼 거면 호스트에서 dev 서버를 띄워도 무방. **단, 이 모드에서는 LLM에 메시지를 보내지 말 것.** 도구가 호스트를 만짐.

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
npm run dev                      # vite + RR 개발 서버
npm run build                    # 프로덕션 빌드
npm run start                    # 빌드된 서버 실행
npm run typecheck                # react-router typegen + tsc

docker compose up --build        # Docker 격리 실행 (권장)
docker compose down              # 컨테이너 종료
docker compose logs -f agent     # 로그 추적
```

## 컨테이너에 들어있는 도구

에이전트의 `bash` 도구가 호출할 수 있도록 미리 깔아둔 것들. 모두 [Dockerfile](Dockerfile)의 `apk add` 한 블록에 묶여 있어서 추가/제거가 한 곳에서 됨.

| 카테고리 | 패키지 |
|---|---|
| Shell / 런타임 | `bash`, `python3`, `py3-pip` |
| 데이터/텍스트 | `jq` (JSON), `yq` (YAML), `xmlstarlet` (XML), `miller` (mlr — CSV/TSV/JSON), `gawk` |
| 네트워크 | `curl`, `wget`, `openssl`, `openssh`, `netcat-openbsd`, `nmap`, `bind-tools` (dig/nslookup) |
| 빌드/컴파일 | `make`, `gcc`, `g++`, `musl-dev`, `cmake` |
| VCS | `git` (private repo는 `data/` 아래 ssh 키 마운트 필요) |
| 압축/파일 | `zip`, `unzip`, `xz`, `p7zip` (7z), `rsync`, `patch` |
| DB 클라이언트 | `sqlite`, `postgresql-client` (psql), `mysql-client` |
| 미디어 | `ffmpeg`, `imagemagick` (magick), `exiftool` |
| 문서 변환 | `pandoc`, `ghostscript` (gs) |
| 시스템 유틸 | `htop`, `tree`, `vim`, `tzdata`, `ca-certificates`, `tini` |

이미지 사이즈는 ~1.5GB. 도구 추가/제거는 [Dockerfile](Dockerfile)의 리스트 알파벳 순서 유지하고 `docker compose up --build`.

## 보안 / 격리 메모

- 빌트인 `bash`는 cwd 밖으로 자유롭게 이동/실행 가능. **반드시 Docker 안에서 운용**할 것.
- 컨테이너는 비루트 유저(`piuser`, uid 10001)로 실행되며, `data/` 외부는 컨테이너 재기동 시 ephemeral.
- 도구가 마운트된 `./data` 는 망가뜨릴 수 있음 — 필요 시 별도 볼륨/백업으로 보호.
- 멀티유저/인증 없음. 외부 네트워크 노출 시 reverse proxy 앞단에 인증 붙일 것.

## 알려진 한계

- 다중 사용자/인증 없음 (로컬 단일 사용자 가정)
- 채팅 제목 자동 생성 미구현 (수동 편집)
- 도구 화이트리스트 UI 미구현 (전 채팅 동일하게 read/bash/edit/write)
- 첨부 이미지 미지원 (SDK는 지원, UI 미구현)
