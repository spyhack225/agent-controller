import { browserSecurityHeaders } from "./securityHeaders.mjs";

export function createEventBroker() {
  const clientsByUser = new Map();

  function connect({ userId, res }) {
    res.writeHead(200, {
      ...browserSecurityHeaders(),
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");

    const client = { res };
    const clients = clientsByUser.get(userId) ?? new Set();
    clients.add(client);
    clientsByUser.set(userId, clients);

    send(client, "connected", { userId, connectedAt: new Date().toISOString() });
    const heartbeat = setInterval(() => {
      send(client, "heartbeat", { at: new Date().toISOString() });
    }, 25_000);
    // The listening server keeps the process alive; a stream keepalive should never be what
    // holds it open, or a leaked client blocks shutdown.
    heartbeat.unref?.();

    res.on("close", () => {
      clearInterval(heartbeat);
      clients.delete(client);
      if (clients.size === 0) clientsByUser.delete(userId);
    });
  }

  function broadcastToUser(userId, type, payload) {
    const clients = clientsByUser.get(userId);
    if (!clients) return;
    for (const client of clients) send(client, type, payload);
  }

  function broadcastToAll(type, payload) {
    for (const userId of clientsByUser.keys()) broadcastToUser(userId, type, payload);
  }

  function broadcastStateChange(state) {
    const users = state.users ?? [];
    for (const user of users) {
      const auditEvents = (state.auditLogs ?? []).filter((event) => event.userId === user.id);
      broadcastToUser(user.id, "state.changed", {
        userId: user.id,
        summary: {
          devices: countFor(state.devices, user.id),
          environments: countFor(state.environments, user.id),
          media: countFor(state.mediaUploads, user.id),
          macros: countFor(state.macros, user.id),
          commands: countFor(state.commands, user.id),
          auditEvents: auditEvents.length,
          latestAction: auditEvents.at(-1)?.action ?? null,
        },
        changedAt: new Date().toISOString(),
      });
    }
  }

  // Used when the store cannot hand back a full snapshot to diff (Convex). Subscribers treat
  // state.changed as a refetch trigger, so the lighter payload is equivalent for them.
  function broadcastUserChange(userId, { action = null } = {}) {
    broadcastToUser(userId, "state.changed", {
      userId,
      summary: { latestAction: action },
      changedAt: new Date().toISOString(),
    });
  }

  return { connect, broadcastToUser, broadcastToAll, broadcastStateChange, broadcastUserChange };
}

function send(client, type, payload) {
  client.res.write(`event: ${type}\n`);
  client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function countFor(items = [], userId) {
  return items.filter((item) => item.userId === userId).length;
}
