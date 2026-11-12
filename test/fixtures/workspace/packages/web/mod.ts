const channel = new BroadcastChannel("updates");
channel.postMessage({ hello: "world" });
export { channel };
