# Parcelwise - Order Tracking & Live Support System

A full-stack web app that shows **four communication protocols working together** in one product:

| Protocol | Endpoint | What it does here |
|---|---|---|
| **REST** | `/api/v1/catalog`, `/api/v1/orders` | Resource management: browse the catalog, create / read / update orders |
| **WebSockets (Socket.io)** | `/socket.io` | Live order-status pushes + private 1-on-1 chat between a customer and a support agent |
| **JSON-RPC 2.0** | `POST /rpc` | Method-style actions: `cancelOrder`, `getOrderStatus`, `updateOrderStatus`, ... |
| **Server-Sent Events** | `GET /events` | One-way live system alerts pushed to every open browser |

The important design idea: all four protocols sit on **one shared data layer + event bus** (`backend/src/store.js`).
Cancel an order over JSON-RPC and the customer's screen updates over WebSocket, the agent's table updates over WebSocket,
and an alert appears over SSE, all from a single change.

```
                 ┌─────────────────────────── Node.js server ────────────────────────────┐
 Browser         │  REST  /api/v1  ─┐                                                     │
 (Vercel/Netlify)│  RPC   /rpc     ─┼──►  store.js  ──►  event bus ──►  Socket.io rooms   │
   fetch ───────►│                  │   (orders, catalog,             └►  SSE clients     │
   WebSocket ◄──►│  Socket.io      ─┘    chat, alerts)                                    │
   EventSource ◄─│  SSE   /events                                                         │
                 └────────────────────────────────────────────────────────────────────────┘
```

## Project structure

```
.
├── backend/                 Node.js + Express + Socket.io   (deploy on Render / Railway)
│   ├── src/
│   │   ├── server.js        wires everything together, health check, order simulator
│   │   ├── store.js         in-memory data + event bus + business rules
│   │   ├── rest.js          REST routes
│   │   ├── rpc.js           JSON-RPC 2.0 handler (single, batch, notifications)
│   │   ├── sockets.js       Socket.io events + chat rooms
│   │   ├── sse.js           Server-Sent Events stream
│   │   └── config.js        environment variables
│   ├── test/smoke.js        end-to-end test of all 4 protocols (36 checks)
│   └── .env.example
├── frontend/                Plain HTML/CSS/JS, no build step   (deploy on Vercel / Netlify)
│   ├── index.html  styles.css  app.js
│   └── config.js            <- put your backend URL here
└── render.yaml              one-click Render blueprint
```

## Run it locally (2 minutes)

Requirements: Node.js 18 or newer.

```bash
cd backend
npm install
npm start
```

Open **http://localhost:4000**. The backend also serves the `frontend/` folder in development, so this one command runs the whole app.

Run the automated test (boots the server on a random port and checks REST, RPC, Socket.io and SSE):

```bash
npm test
```

### Try the full demo

1. Open http://localhost:4000 in one browser window. This is the **customer**.
2. Open it again in a second window (or a private window) and switch the toggle to **Support agent**. Enter the agent key `support123`.
3. As the customer: add products, check out, and watch the order on the **Orders** tab.
4. As the agent: change the order status in the table. The customer's tracker moves **instantly** (WebSocket).
5. Customer clicks **Chat with support**. The agent sees them in the queue and clicks **Take chat**. Talk to each other.
6. Customer clicks **Cancel order** (this uses JSON-RPC `cancelOrder`). It is only allowed while the order is *pending* or *processing*.
7. Watch **Live alerts**. Every change shows up there over SSE. The agent can also broadcast a custom alert.
8. Open **JSON-RPC console** to send raw requests, batches, notifications and deliberate errors.

Demo emails with seeded orders: `ayesha@example.com` (ORD-1001) and `bilal@example.com` (ORD-1002).

By default a simulator moves orders forward every 30 seconds so the demo feels alive. Turn it off with `SIMULATE_PROGRESS=false`.

## Environment variables (backend)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | Set automatically by Render/Railway |
| `CORS_ORIGIN` | `*` | Your frontend URL(s), comma separated. **Set this in production**, e.g. `https://parcelwise.vercel.app` |
| `AGENT_KEY` | `support123` | Secret for support-agent actions. **Change it in production** |
| `SIMULATE_PROGRESS` | `true` | Auto-advance order statuses |
| `STEP_SECONDS` | `30` | Seconds between simulated status steps |

---

## 1. REST API (`/api/v1`)

Responses look like `{ "data": ... , "meta": ... }`. Errors look like `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/catalog` | - | List products. Filters: `?q=`, `?category=` |
| GET | `/api/v1/catalog/:id` | - | One product |
| GET | `/api/v1/orders` | `?email=` **or** agent key | List orders. Filters: `status`, `email`, `page`, `limit` |
| GET | `/api/v1/orders/:id` | - | One order (with status history) |
| POST | `/api/v1/orders` | - | Create an order. Reserves stock. Returns `201` + `Location` header |
| PATCH | `/api/v1/orders/:id/status` | `x-agent-key` | Move an order forward (`processing`, `shipped`, ...) |
| POST | `/api/v1/orders/:id/cancel` | - | Cancel (same rule as RPC) |
| POST | `/api/v1/alerts` | `x-agent-key` | Broadcast a custom alert to all SSE clients |
| GET | `/health` | - | Health check for the host |

Order lifecycle: `pending → processing → shipped → out_for_delivery → delivered`, or `cancelled` (only from `pending`/`processing`, stock is returned).

```bash
# create an order
curl -X POST http://localhost:4000/api/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"customer":{"name":"Sana","email":"sana@example.com"},"items":[{"productId":"p3","quantity":2}]}'

# agent moves it forward
curl -X PATCH http://localhost:4000/api/v1/orders/ORD-1003/status \
  -H "Content-Type: application/json" -H "x-agent-key: support123" \
  -d '{"status":"shipped"}'
```

## 2. WebSocket events (Socket.io)

Connect with `io(API_URL)`. Every client-to-server event accepts an **acknowledgement callback** that receives `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`.

### Rooms

| Room | Who is inside |
|---|---|
| `order:<ORDER_ID>` | Customers watching one order |
| `agents` | Logged-in support agents |
| `chat:<ORDER_ID>` | The private chat: **at most 1 customer + 1 agent** |

### Client → Server

| Event | Payload | Ack / result |
|---|---|---|
| `order:subscribe` | `{ orderId }` | `{ ok, order }`. Joins `order:<id>` so you receive live status pushes |
| `order:unsubscribe` | `{ orderId }` | `{ ok }` |
| `agent:login` | `{ agentKey }` | `{ ok, queue }`. Joins the `agents` room |
| `chat:join` | `{ orderId, role: "customer"\|"agent", name?, email?, agentKey? }` | `{ ok, orderId, history, presence }`. A customer must send the **email on the order**; an agent must send the **agent key**. Errors: `FORBIDDEN`, `UNAUTHORIZED`, `SLOT_TAKEN` (1-on-1 rule) |
| `chat:message` | `{ orderId, text }` (max 1000 chars) | `{ ok, message }` |
| `chat:typing` | `{ orderId, typing: boolean }` | - |
| `chat:leave` | `{ orderId }` | `{ ok }` |
| `chat:close` | `{ orderId }` | `{ ok }`. Agent only. Ends the chat for both sides |

### Server → Client

| Event | Payload | Sent to | When |
|---|---|---|---|
| `order:status` | `{ orderId, status, previousStatus, order, at }` | `order:<id>` room and `agents` | Any status change, whether it came from REST, RPC, an agent, or the simulator |
| `order:created` | `{ order }` | `agents` | A new order is placed |
| `chat:message` | `{ id, orderId, from: "customer"\|"agent"\|"system", name, text, at }` | `chat:<id>` room | A message (or a system notice like "Sara joined") is posted |
| `chat:presence` | `{ orderId, customerOnline, agentOnline, customerName, agentName }` | `chat:<id>` room | Someone joins, leaves or disconnects |
| `chat:typing` | `{ orderId, role, name, typing }` | The *other* person in the room | Typing starts/stops |
| `support:queue` | `[{ orderId, customerName, waiting, agentName }]` | `agents` | Customers join/leave chats |
| `chat:closed` | `{ orderId }` | `chat:<id>` room | The agent closed the chat |

```js
const socket = io("http://localhost:4000");
socket.emit("order:subscribe", { orderId: "ORD-1001" }, console.log);
socket.on("order:status", ({ orderId, status }) => console.log(orderId, "is now", status));

socket.emit("chat:join", { orderId: "ORD-1001", role: "customer", email: "ayesha@example.com" }, (r) => console.log(r));
socket.emit("chat:message", { orderId: "ORD-1001", text: "Hello!" });
```

## 3. JSON-RPC 2.0 (`POST /rpc`)

Follows the [specification](https://www.jsonrpc.org/specification): single calls, **batch** (send an array), and **notifications** (no `id` → no response, HTTP 204).

| Method | Params | Result |
|---|---|---|
| `cancelOrder` | `{ orderId, reason? }` | `{ orderId, status: "cancelled", cancelled: true }` |
| `getOrderStatus` | `{ orderId }` | `{ orderId, status, updatedAt }` |
| `trackOrders` | `{ email }` | `[{ orderId, status, total }]` |
| `updateOrderStatus` | `{ orderId, status, note?, agentKey }` (or `x-agent-key` header) | `{ orderId, status }`. Agent only |
| `listMethods` | - | `["ping", "listMethods", ...]` |
| `ping` | - | `{ pong: true, time }` |

Error codes: `-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params, `-32603` internal error,
`-32000` application error (the reason is in `error.data.code`, for example `ORDER_NOT_FOUND`, `NOT_CANCELLABLE`, `UNAUTHORIZED`).

```bash
curl -X POST http://localhost:4000/rpc -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"cancelOrder","params":{"orderId":"ORD-1002"}}'
# {"jsonrpc":"2.0","id":1,"result":{"orderId":"ORD-1002","status":"cancelled","cancelled":true}}
```

## 4. Server-Sent Events (`GET /events`)

```js
const es = new EventSource("http://localhost:4000/events");
es.addEventListener("alert", (e) => console.log(JSON.parse(e.data)));
```

| SSE event | Data | Meaning |
|---|---|---|
| `connected` | `{ message, clients }` | Sent once when the stream opens |
| `alert` | `{ id, level: info\|success\|warning\|error, title, message, at }` | New order, status change, cancellation, or an agent broadcast |
| `stats` | `{ orders, sseClients, socketClients, time }` | Every 10 seconds |

Each alert has an `id`, so if the connection drops the browser reconnects with `Last-Event-ID` and the server **replays the missed alerts**. A heartbeat comment is sent every 15 s to keep proxies from closing the stream.

---

## Deployment

You deploy the **backend first** (to get its URL), then the **frontend**, then tell the backend the frontend's URL.

### A. Push to GitHub

```bash
git init
git add .
git commit -m "Order tracking & live support system"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

### B. Backend on Render

1. Go to [render.com](https://render.com) → **New +** → **Web Service** → connect your GitHub repo.
2. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install --omit=dev`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
3. Environment variables: `AGENT_KEY` = a secret of your choice, `CORS_ORIGIN` = `*` for now (you will tighten it in step D).
4. Deploy. Your API URL looks like `https://order-tracking-api.onrender.com`. Open `/health` to confirm.

(Or use **New + → Blueprint** and select the repo; `render.yaml` fills all of this in.)

*Railway instead:* New Project → Deploy from GitHub → set **Root Directory** to `backend` → add the same variables → Settings → Networking → **Generate Domain**.

> Render's free plan sleeps after ~15 minutes without traffic, so the first request can take about 30-50 seconds. Orders and chats live in memory and reset when the server restarts. See "Production notes" below.

### C. Frontend on Vercel

1. Edit `frontend/config.js` and set your backend URL:
   ```js
   window.APP_CONFIG = { API_URL: "https://order-tracking-api.onrender.com" };
   ```
   Commit and push.
2. Go to [vercel.com](https://vercel.com) → **Add New… → Project** → import the repo.
3. **Root Directory:** `frontend`. **Framework Preset:** Other. Leave build command empty. Deploy.

*Netlify instead:* Add new site → import from Git → **Base directory** `frontend`, no build command, publish directory `frontend` (or `.` when the base directory is set).

### D. Lock down CORS

In Render, change `CORS_ORIGIN` to your real frontend URL (for example `https://parcelwise.vercel.app`) and redeploy. Now only your site can call the API.

### Checking the live deployment

- `https://<api>/health` returns `{"status":"ok"}`
- Open the Vercel URL. The three dots in the header (REST, WebSocket, SSE) should all turn green.
- You can also test any backend without editing files by opening `https://<your-frontend>/?api=https://<your-api>`.

## Security and production notes

- Agent actions are protected by one shared `AGENT_KEY`. This is enough for the assignment; a real system would use user accounts and JWT/session auth.
- A customer can only join the chat for an order if they know the **email on that order**.
- All user-generated text is HTML-escaped in the UI, and chat text is stripped of control characters and length-limited.
- Data is stored in memory to keep the project simple to run. To persist it, replace the maps in `store.js` with PostgreSQL/MongoDB (the rest of the code only uses the functions exported by `store.js`). To run more than one server instance, add the Socket.io Redis adapter and a Redis pub/sub for SSE.

## License

MIT
