import { Worker } from "node:worker_threads";
import { rewriteMessage, RewriteRulesSchema } from "../src/rewrite.ts";
export async function rewriteMessages(
  messages: string[],
  input: unknown,
): Promise<string[]> {
  const rules = RewriteRulesSchema.parse(input);
  if (!rules.length) return [...messages];
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `const {parentPort, workerData} = require('node:worker_threads');
      const rewrite = ${rewriteMessage.toString()};
      parentPort.postMessage(workerData.messages.map(message => rewrite(message, workerData.rules)));`,
      { eval: true, workerData: { messages, rules } },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(
        new Error("Rewrite rules exceeded 2 seconds. Simplify the regex."),
      );
    }, 2000);
    worker.once("message", (result: string[]) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(error);
    });
  });
}
