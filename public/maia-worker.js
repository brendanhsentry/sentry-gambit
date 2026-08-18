/** Runs Maia 3 ONNX inference off the main thread. */
/* global ort */
importScripts("/ort/ort.wasm.min.js");
ort.env.wasm.wasmPaths = "/ort/";
ort.env.wasm.numThreads = 1;

let session = null;

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      const response = await fetch(msg.modelUrl);
      if (!response.ok) throw new Error(`Model download failed (${response.status})`);
      const total =
        Number(response.headers.get("Content-Length")) ||
        Number(response.headers.get("X-Model-Size")) ||
        0;
      const reader = response.body.getReader();
      const chunks = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) {
          postMessage({ type: "progress", progress: Math.floor((received / total) * 100) });
        }
      }
      const buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }
      session = await ort.InferenceSession.create(buffer.buffer);
      postMessage({ type: "ready" });
      return;
    }

    if (msg.type === "infer") {
      if (!session) throw new Error("Model is not loaded yet");
      const result = await session.run({
        tokens: new ort.Tensor("float32", new Float32Array(msg.tokens), [1, 64, 12]),
        elo_self: new ort.Tensor("float32", Float32Array.from([msg.eloSelf]), [1]),
        elo_oppo: new ort.Tensor("float32", Float32Array.from([msg.eloOppo]), [1]),
      });
      const logits = new Float32Array(result.logits_move.data);
      postMessage({ type: "result", id: msg.id, logits: logits.buffer }, [logits.buffer]);
    }
  } catch (error) {
    postMessage({
      type: "error",
      id: msg.type === "infer" ? msg.id : undefined,
      message: String(error && error.message ? error.message : error),
    });
  }
};
