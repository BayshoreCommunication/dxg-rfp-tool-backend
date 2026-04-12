"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createNotification = exports.emitUnreadNotificationCount = exports.initializeNotificationWebSocketServer = void 0;
const crypto_1 = __importDefault(require("crypto"));
const notificationModel_1 = __importDefault(require("../modal/notificationModel"));
const jwt_1 = require("../config/jwt");
const clientsByUserId = new Map();
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_PATH = "/api/notifications/ws";
const addClient = (client) => {
    const existing = clientsByUserId.get(client.userId) ?? new Set();
    existing.add(client);
    clientsByUserId.set(client.userId, existing);
};
const removeClient = (client) => {
    const clients = clientsByUserId.get(client.userId);
    if (!clients)
        return;
    clients.delete(client);
    if (clients.size === 0) {
        clientsByUserId.delete(client.userId);
    }
};
const buildTextFrame = (payload) => {
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
const buildControlFrame = (opcode, payload = Buffer.alloc(0)) => Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
const sendSocketMessage = (socket, message) => {
    if (socket.destroyed)
        return;
    socket.write(buildTextFrame(JSON.stringify(message)));
};
const parseFrames = (client) => {
    let buffer = client.buffer;
    while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const opcode = firstByte & 0x0f;
        const isMasked = (secondByte & 0x80) !== 0;
        let payloadLength = secondByte & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
            if (buffer.length < offset + 2)
                break;
            payloadLength = buffer.readUInt16BE(offset);
            offset += 2;
        }
        else if (payloadLength === 127) {
            if (buffer.length < offset + 8)
                break;
            payloadLength = Number(buffer.readBigUInt64BE(offset));
            offset += 8;
        }
        const maskBytes = isMasked ? 4 : 0;
        if (buffer.length < offset + maskBytes + payloadLength)
            break;
        let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + payloadLength);
        if (isMasked) {
            const mask = buffer.subarray(offset, offset + 4);
            payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
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
const initializeNotificationWebSocketServer = (server) => {
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
            const payload = (0, jwt_1.verifyAccessToken)(token);
            const websocketKey = req.headers["sec-websocket-key"];
            if (!websocketKey) {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
                return;
            }
            const acceptKey = crypto_1.default
                .createHash("sha1")
                .update(`${websocketKey}${WS_GUID}`)
                .digest("base64");
            socket.write([
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${acceptKey}`,
                "\r\n",
            ].join("\r\n"));
            const client = {
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
            socket.on("data", (chunk) => {
                client.buffer = Buffer.concat([client.buffer, chunk]);
                parseFrames(client);
            });
            const cleanup = () => removeClient(client);
            socket.on("close", cleanup);
            socket.on("end", cleanup);
            socket.on("error", cleanup);
        }
        catch (error) {
            console.error("Notification WebSocket upgrade error:", error);
            socket.destroy();
        }
    });
};
exports.initializeNotificationWebSocketServer = initializeNotificationWebSocketServer;
const emitUnreadNotificationCount = async (userId) => {
    const count = await notificationModel_1.default.countDocuments({ userId, isRead: false });
    const clients = clientsByUserId.get(userId);
    if (!clients)
        return;
    for (const client of clients) {
        sendSocketMessage(client.socket, {
            event: "notification:unread-count",
            data: { count },
        });
    }
};
exports.emitUnreadNotificationCount = emitUnreadNotificationCount;
const createNotification = async ({ userId, proposalId = null, type, title, message, metadata = {}, dedupeKey, }) => {
    try {
        const notification = await notificationModel_1.default.create({
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
                    data: plainNotification,
                });
            }
        }
        await (0, exports.emitUnreadNotificationCount)(userId);
        return notification;
    }
    catch (error) {
        if (error?.code === 11000 && dedupeKey) {
            return notificationModel_1.default.findOne({ dedupeKey });
        }
        throw error;
    }
};
exports.createNotification = createNotification;
//# sourceMappingURL=notificationService.js.map