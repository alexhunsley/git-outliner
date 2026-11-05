import { z } from "zod";
import { ViewSchema } from "./model.ts";
export const SESSION_KEY = "git-outliner.session.v1";
// Drafts intentionally allow incomplete/invalid regexes and an unfinished name.
export const SettingsSchema = z
  .object({
    format: z.literal("git-outliner-settings"),
    version: z.literal(1),
    repositoryPath: z.string().max(10000),
    view: ViewSchema.safeExtend({ name: z.string().max(120) }).nullable(),
    dirty: z.boolean(),
    ui: z
      .object({
        query: z.string().max(10000),
        selectedView: z.string().max(100),
        expanded: z.record(z.string(), z.boolean()),
        drafts: z
          .object({
            repositoryPath: z.string().max(10000),
            filter: z.string().max(10000),
            ticketPattern: z.string().max(500),
            rewrites: z
              .array(
                z
                  .object({
                    pattern: z.string().max(500),
                    replacement: z.string().max(2000),
                  })
                  .strict(),
              )
              .max(20),
            rewritePending: z.boolean(),
            rewriteSample: z.string().max(10000),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export function readSettings(
  storage: Pick<Storage, "getItem">,
): Settings | undefined {
  const raw = storage.getItem(SESSION_KEY);
  return raw === null ? undefined : SettingsSchema.parse(JSON.parse(raw));
}
export function writeSettings(
  storage: Pick<Storage, "setItem">,
  settings: Settings,
) {
  storage.setItem(SESSION_KEY, JSON.stringify(SettingsSchema.parse(settings)));
}
