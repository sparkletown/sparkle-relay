import http from "http";
import ws from "ws";
import redis from "redis";

const DATA_KEY = "data";
const START_ZONE = {
  x: 1150,
  y: 3630,
  width: 520,
  height: 170,
  rotateRad: 0.314159, // 18 degrees, roughly the city's offset
};
const MAX_X = 4000;
const MAX_Y = 4000;

const rotateY = (y: number, rad: number) => {
  return y * Math.cos(rad);
};

const randomStartLocation: () => { x: number; y: number } = () => {
  const xRotated = Math.floor(
    Math.random() * START_ZONE.width * Math.cos(START_ZONE.rotateRad)
  );
  const yRotated = Math.floor(
    Math.random() * START_ZONE.height * Math.sin(START_ZONE.rotateRad)
  );
  return { x: xRotated + START_ZONE.x, y: yRotated + START_ZONE.y };
};

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
  speaking?: boolean;
  state?: { [key: string]: string };
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
      console.log("message", data);
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

            // Respond with all known locations
            pub.get(DATA_KEY, (_, allDataStr) => {
              const allData = JSON.parse(allDataStr ?? "{}") as UserStateMap;
              if (!(helloMsg.uid in allData)) {
                const { x, y } = randomStartLocation();
                const initialUserState: UserState = {
                  x,
                  y,
                  speaking: false,
                };

                // Relay initial state to all other connected clients
                const relayMsg: PubsubMessage = {
                  uid: helloMsg.uid,
                  update: initialUserState,
                };
                pub.publish("global", JSON.stringify(relayMsg));

                // Ensure initial state is sent to the client who Hello'd
                allData[helloMsg.uid] = initialUserState;
              }

              // Respond with all known locations
              const msg: BroadcastMessage = {
                type: MessageType.Broadcast,
                updates: allData,
              };
              conn.send(JSON.stringify(msg));

              // Basic verification: set the uid for this conn (also marks it as Hello'd)
              client.uid = helloMsg.uid;
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
            if (
              updateMsg.update.x < 0 ||
              updateMsg.update.x >= MAX_X ||
              updateMsg.update.y < 0 ||
              updateMsg.update.y >= MAX_Y
            ) {
              console.log("coordinates out of bounds; discarding", updateMsg);
              break;
            }
            // Persist state and broadcast it
            pub.get(DATA_KEY, (_, allDataStr) => {
              const allData = JSON.parse(allDataStr ?? "{}") as UserStateMap;
              if (client.uid) {
                allData[client.uid] = updateMsg.update;
              }
              pub.set(DATA_KEY, JSON.stringify(allData));
              const relayMsg: PubsubMessage = {
                uid: updateMsg.uid,
                update: updateMsg.update,
              };
              // Broadcast via pubsub
              pub.publish("global", JSON.stringify(relayMsg));
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

process.on("uncaughtException", (err) => {
  console.error(new Date().toUTCString() + " uncaughtException:", err.message);
  console.error(err.stack);
  process.exit(1);
});

// Begin listening.
server.listen(process.env.PORT || 8080);
