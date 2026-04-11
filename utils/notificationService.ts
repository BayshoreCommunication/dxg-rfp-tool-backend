import crypto from "crypto";
import http from "http";
import { Duplex } from "stream";
import Notification from "../modal/notificationModel";
import { verifyAccessToken } from "../config/jwt";

type SocketMessage =
  | {
      event: "connected";
      data: {
        userId: string;
        connectedAt: string;
      };
    }
  | {
      event: "notification:new";
      data: Record<string, unknown>;
    }
  | {
      event: "notification:unread-count";
      data: {
        count: number;
      };
    };

type ConnectedClient = {
  userId: string;
  socket: Duplex;
  buffer: Buffer;
};

type CreateNotificationInput = {
  userId: string;
  proposalId?: string | null;
  type: "proposal_view" | "proposal_expiring_soon" | "proposal_expired";
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  dedupeKey?: string;
};

const clientsByUserId = new Map<string, Set<ConnectedClient>>();

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_PATH = "/api/notifications/ws";

const addClient = (client: ConnectedClient) => {
  const existing = clientsByUserId.get(client.userId) ?? new Set<ConnectedClient>();
  existing.add(client);
  clientsByUserId.set(client.userId, existing);
};

const removeClient = (client: ConnectedClient) => {
  const clients = clientsByUserId.get(client.userId);
  if (!clients) return;

  clients.delete(client);
  if (clients.size === 0) {
    clientsByUserId.delete(client.userId);
  }
};

const buildTextFrame = (payload: string) => {
  const payloadBuffer = Buffer.from(payload, "utf8");
  const payloadLength = payloadBuffer.length;

  if (payloadLength < 126) {
    return Buffer.concat([
      Buffer.from([0x81, payloadLength]),
      payloadBuffer,
    ]);
  }

  if (payloadLength < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payloadLength, 2);
    return Buffer.concat([header, payloadBuffer]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payloadLength), 2);
  return Buffer.concat([header, payloadBuffer]);
};

const buildControlFrame = (opcode: number, payload = Buffer.alloc(0)) =>
  Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);

const sendSocketMessage = (socket: Duplex, message: SocketMessage) => {
  if (socket.destroyed) return;
  socket.write(buildTextFrame(JSON.stringify(message)));
};

const parseFrames = (client: ConnectedClient) => {
  let buffer = client.buffer;

  while (buffer.length >= 2) {
    const firstByte = buffer[0];
    const secondByte = buffer[1];
    const opcode = firstByte & 0x0f;
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < offset + 2) break;
      payloadLength = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (buffer.length < offset + 8) break;
      payloadLength = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }

    const maskBytes = isMasked ? 4 : 0;
    if (buffer.length < offset + maskBytes + payloadLength) break;

    let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLength);

    if (isMasked) {
      const mask = buffer.subarray(offset, offset + 4);
      payload = Buffer.from(
        payload.map((byte, index) => byte ^ mask[index % 4]),
      );
    }

    if (opcode === 0x8) {
      client.socket.end(buildControlFrame(0x8));
      buffer = buffer.subarray(offset + maskBytes + payloadLength);
      continue;
    }

    if (opcode === 0x9) {
      client.socket.write(buildControlFrame(0xA, Buffer.from(payload)));
    }

    buffer = buffer.subarray(offset + maskBytes + payloadLength);
  }

  client.buffer = buffer;
};

export const initializeNotificationWebSocketServer = (server: http.Server) => {
  server.on("upgrade", (req, socket, head) => {
    try {
      const requestUrl = new URL(req.url || "", "http://localhost");
      if (requestUrl.pathname !== WS_PATH) {
        socket.destroy();
        return;
      }

      const token = requestUrl.searchParams.get("token");
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const payload = verifyAccessToken(token);
      const websocketKey = req.headers["sec-websocket-key"];

      if (!websocketKey) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const acceptKey = crypto
        .createHash("sha1")
        .update(`${websocketKey}${WS_GUID}`)
        .digest("base64");

      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${acceptKey}`,
          "\r\n",
        ].join("\r\n"),
      );

      const client: ConnectedClient = {
        userId: payload.userId,
        socket,
        buffer: head && head.length > 0 ? Buffer.concat([head]) : Buffer.alloc(0),
      };

      addClient(client);
      sendSocketMessage(socket, {
        event: "connected",
        data: {
          userId: payload.userId,
          connectedAt: new Date().toISOString(),
        },
      });

      if (client.buffer.length > 0) {
        parseFrames(client);
      }

      socket.on("data", (chunk: Buffer) => {
        client.buffer = Buffer.concat([client.buffer, chunk]);
        parseFrames(client);
      });

      const cleanup = () => removeClient(client);
      socket.on("close", cleanup);
      socket.on("end", cleanup);
      socket.on("error", cleanup);
    } catch (error) {
      console.error("Notification WebSocket upgrade error:", error);
      socket.destroy();
    }
  });
};

export const emitUnreadNotificationCount = async (userId: string) => {
  const count = await Notification.countDocuments({ userId, isRead: false });
  const clients = clientsByUserId.get(userId);

  if (!clients) return;

  for (const client of clients) {
    sendSocketMessage(client.socket, {
      event: "notification:unread-count",
      data: { count },
    });
  }
};

export const createNotification = async ({
  userId,
  proposalId = null,
  type,
  title,
  message,
  metadata = {},
  dedupeKey,
}: CreateNotificationInput) => {
  try {
    const notification = await Notification.create({
      userId,
      proposalId,
      type,
      title,
      message,
      metadata,
      dedupeKey,
    });

    const plainNotification = notification.toObject();
    const clients = clientsByUserId.get(userId);

    if (clients) {
      for (const client of clients) {
        sendSocketMessage(client.socket, {
          event: "notification:new",
          data: plainNotification as unknown as Record<string, unknown>,
        });
      }
    }

    await emitUnreadNotificationCount(userId);
    return notification;
  } catch (error: any) {
    if (error?.code === 11000 && dedupeKey) {
      return Notification.findOne({ dedupeKey });
    }
    throw error;
  }
};
