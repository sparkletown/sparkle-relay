import http from "http";
import ws from "ws";
import redis from "redis";

const DATA_KEY = "data";
const START_ZONE = {
  x: 0,
  y: 0,
  width: 200,
  height: 200,
};
const MAX_X = 2000;
const MAX_Y = 2000;

const randomStartLocation: () => { x: number; y: number } = () => {
  const x = START_ZONE.x + Math.floor(Math.random() * START_ZONE.width);
  const y = START_ZONE.y + Math.floor(Math.random() * START_ZONE.height);
  return { x, y };
};

// Setup Redis pub/sub. Need two Redis clients, as the one that subscribes can't also publish.
const pub = process.env.REDIS_URL
  ? redis.createClient({ url: process.env.REDIS_URL })
  : redis.createClient();
const sub = process.env.REDIS_URL
  ? redis.createClient({ url: process.env.REDIS_URL })
  : redis.createClient();
sub.subscribe("global");

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

const clients: ws[] = [];

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
      conn.send(JSON.stringify(msg));
    }
  } catch (err) {
    console.error(`Error ${err} in onMessage(${data}); continuing`);
  }
});

handler.on("connection", function (conn) {
  try {
    clients.push(conn);

    conn.on("message", function (data) {
      console.log("message", data);
      try {
        const parsed = JSON.parse(data.toString());
        switch (parsed.type) {
          case MessageType.Hello:
            const helloMsg = parsed as HelloWsMessage;

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
            });
            break;
          case MessageType.Update:
            const updateMsg = parsed as UpdateWsMessage;
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
              allData[updateMsg.uid] = updateMsg.update;
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
    const closedIndex = clients.findIndex((client) => client === conn);
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
