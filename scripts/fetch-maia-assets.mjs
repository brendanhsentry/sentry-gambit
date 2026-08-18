/** Downloads the Maia 3 model and ONNX runtime files the bot opponents need. */
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";

const ORT_VERSION = "1.23.0";
const ASSETS = [
  ["public/maia3/maia3.onnx", "https://www.maiachess.com/maia3/maia3_simplified.onnx"],
  ...["ort.wasm.min.js", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"].map(
    (file) => [
      `public/ort/${file}`,
      `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/${file}`,
    ],
  ),
];

for (const [path, url] of ASSETS) {
  try {
    await access(path);
    continue;
  } catch {
    // Missing; download below.
  }
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}
