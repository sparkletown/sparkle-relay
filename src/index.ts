import http from "http";
import ws from "ws";
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
  conn: ws;
  uid?: string;
};

type UserState = {
  x: number;
  y: number;
  speaking: boolean;
  reserved?: string;
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

const clients: Connection[] = [];

var server = http.createServer();
const handler = new ws.Server({ server });

// Listen for messages being published to this server.
sub.on("message", function (_, data) {
  try {
    const parsed = JSON.parse(data) as PubsubMessage;
    const msg: BroadcastMessage = {
      type: MessageType.Broadcast,
      updates: { [parsed.uid]: parsed.update },
    };

    // Broadcast to all connected clients
    for (const conn of clients) {
      // Require hello, which sets uid
      if (conn.uid) {
        conn.conn.send(JSON.stringify(msg));
      }
    }
  } catch (err) {
    console.error(`Error ${err} in onMessage(${data}); continuing`);
  }
});

handler.on("connection", function (conn) {
  try {
    clients.push({ conn });

    conn.on("message", function (data) {
      try {
        const client = clients.find((client) => client.conn === conn);
        if (!client) {
          throw new Error(`Cannot find client with conn ${conn}`);
        }
        const parsed = JSON.parse(data.toString());
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
              conn.send(JSON.stringify(msg));
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
          default:
            throw new Error(`Invalid message ${data}`);
        }
      } catch (err) {
        console.error(`Error ${err} in onData(${data}); closing connection`);
        conn.send(`Error ${err} in onData(${data}); closing connection`);
        conn.close();
      }
    });
  } catch (err) {
    console.error(`Error ${err} in onConnection(); closing connection`);
    conn.send(`Error ${err} in onConnection(); closing connection`);
    conn.close();
  }

  conn.on("close", function () {
    const closedIndex = clients.findIndex((client) => client.conn === conn);
    if (closedIndex >= 0) {
      clients.splice(closedIndex);
    }
  });
});

// Begin listening.
server.listen(process.env.PORT || 8080);
