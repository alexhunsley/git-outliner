import { resolve } from "node:path";
import { createFixture } from "./fixture.ts";
const path = resolve(process.argv[2] || ".demo");
await createFixture(path);
console.log(
  `\nDemo ready: ${path}\nOpen this path in Git Outliner; select main as root, plus staging and release/1.0.`,
);
