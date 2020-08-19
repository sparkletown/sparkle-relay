"use strict";
exports.__esModule = true;
exports.RelayMessageType = void 0;
var http_1 = require("http");
var sockjs_1 = require("sockjs");
var redis_1 = require("redis");
// Setup Redis pub/sub. Need two Redis clients, as the one that subscribes can't also publish.
var pub = redis_1["default"].createClient();
var sub = redis_1["default"].createClient();
sub.subscribe("global");
var RelayMessageType;
(function (RelayMessageType) {
    RelayMessageType["Hello"] = "hello";
    RelayMessageType["Update"] = "update";
})(RelayMessageType = exports.RelayMessageType || (exports.RelayMessageType = {}));
var clients = {};
var handler = sockjs_1["default"].createServer();
// Listen for messages being published to this server.
sub.on("message", function (channel, msg) {
    // Broadcast to all connected clients
    for (var _i = 0, _a = Object.values(clients); _i < _a.length; _i++) {
        var conn = _a[_i];
        conn.conn.write(msg);
    }
});
handler.on("connection", function (conn) {
    clients[conn.id] = { conn: conn };
    conn.on("data", function (data) {
        console.log("data:", data);
        try {
            var client = clients[conn.id];
            var message = JSON.parse(data);
            switch (message.type) {
                case RelayMessageType.Hello:
                    if (client.uid) {
                        throw new Error("Cannot set uid twice");
                    }
                    if (!message.uid) {
                        throw new Error("Hello must have uid");
                    }
                    client.uid = message.uid;
                    break;
                case RelayMessageType.Update:
                    if (!client.uid) {
                        throw new Error("Must Hello first");
                    }
                    if (message.uid !== client.uid) {
                        throw new Error("UID mismatch");
                    }
                    if (!message.x || !message.y || !message.speaking) {
                        throw new Error("Missing data");
                    }
                    pub.publish("global", JSON.stringify(message));
            }
        }
        catch (e) {
            conn.write("Bad message: " + data + "; error: " + e);
            conn.close();
        }
    });
    conn.on("close", function () {
        delete clients[conn.id];
    });
});
// Begin listening.
var server = http_1["default"].createServer();
handler.installHandlers(server, { prefix: "/sockjs" });
server.listen(80);
