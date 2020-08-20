import http from "http";
import sockjs from "sockjs";
import redis from "redis";

const DATA_KEY = "data";

// Setup Redis pub/sub. Need two Redis clients, as the one that subscribes can't also publish.
const pub = process.env.REDIS_URL
  ? redis.createClient({ url: process.env.REDIS_URL })
  : redis.createClient();
const sub = process.env.REDIS_URL
  ? redis.createClient({ url: process.env.REDIS_URL })
  : redis.createClient();
sub.subscribe("global");

type Connection = {
  conn: sockjs.Connection;
  uid?: string;
};

type UserState = {
  x: number;
  y: number;
  speaking: boolean;
};

type UserStateMap = { [uid: string]: UserState };

enum MessageType {
  Hello = "hello",
  Update = "update",
  Broadcast = "broadcast",
}

type HelloWsMessage = {
  type: MessageType.Hello;
  uid: string;
};

type UpdateWsMessage = {
  type: MessageType.Update;
  uid: string;
  update: UserState;
};

type BroadcastMessage = {
  type: MessageType.Broadcast;
  updates: UserStateMap;
};

type PubsubMessage = {
  uid: string;
  update: UserState;
};

const clients: { [id: string]: Connection } = {};
const handler = sockjs.createServer();

// Listen for messages being published to this server.
sub.on("message", function (_, data) {
  try {
    const parsed = JSON.parse(data) as PubsubMessage;
    const msg: BroadcastMessage = {
      type: MessageType.Broadcast,
      updates: { [parsed.uid]: parsed.update },
    };

    // Broadcast to all connected clients
    for (const conn of Object.values(clients)) {
      // Require hello, which sets uid
      if (conn.uid) {
        conn.conn.write(JSON.stringify(msg));
      }
    }
  } catch (err) {
    console.error(`Error ${err} in onMessage(${data}); continuing`);
  }
});

handler.on("connection", function (conn) {
  clients[conn.id] = { conn };

  conn.on("data", function (data) {
    try {
      const client = clients[conn.id];
      const parsed = JSON.parse(data);
      switch (parsed.type) {
        case MessageType.Hello:
          const helloMsg = parsed as HelloWsMessage;
          if (client.uid) {
            throw new Error("Cannot hello twice");
          }
          // Basic verification: set the uid for this conn (also marks it as Hello'd)
          client.uid = helloMsg.uid;
          // Broadcast all known locations
          pub.get(DATA_KEY, (_, allDataStr) => {
            const allData = JSON.parse(allDataStr ?? "{}") as UserStateMap;
            const msg: BroadcastMessage = {
              type: MessageType.Broadcast,
              updates: allData,
            };
            conn.write(JSON.stringify(msg));
          });
          break;
        case MessageType.Update:
          const updateMsg = parsed as UpdateWsMessage;
          if (!client.uid) {
            throw new Error("Must Hello first");
          }
          if (updateMsg.uid !== client.uid) {
            throw new Error("UID mismatch");
          }
          // Persist state and broadcast it
          pub.get(DATA_KEY, (_, allDataStr) => {
            const allData = JSON.parse(allDataStr ?? "{}") as UserStateMap;
            if (client.uid) {
              allData[client.uid] = updateMsg.update;
            }
            pub.set(DATA_KEY, JSON.stringify(allData));
            const broadcastMsg: PubsubMessage = {
              uid: updateMsg.uid,
              update: updateMsg.update,
            };
            // Broadcast via pubsub
            pub.publish("global", JSON.stringify(broadcastMsg));
          });
          break;
      }
    } catch (err) {
      console.error(`Error ${err} in onData(${data}); closing connection`);
      conn.write(`Error ${err} in onData(${data}); closing connection`);
      conn.close();
    }
  });

  conn.on("close", function () {
    delete clients[conn.id];
  });
});

// Begin listening.
var server = http.createServer();
handler.installHandlers(server, { prefix: "/" });
server.listen(process.env.PORT || 8080);
