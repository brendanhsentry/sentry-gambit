/** Downloads the Maia 3 model the server-side bot opponents need. */
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname } from "node:path";

const path = "models/maia3.onnx";
const url = "https://www.maiachess.com/maia3/maia3_simplified.onnx";

try {
  await access(path);
} catch {
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}
