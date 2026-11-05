import { z } from "zod";
export const RewriteRulesSchema = z
  .array(
    z
      .object({
        pattern: z
          .string()
          .min(1)
          .max(500)
          .refine((pattern) => {
            try {
              new RegExp(pattern);
              return true;
            } catch {
              return false;
            }
          }, "Invalid rewrite regular expression."),
        replacement: z.string().max(2000),
      })
      .strict(),
  )
  .max(20)
  .default([]);
export type RewriteRule = z.infer<typeof RewriteRulesSchema>[number];
// Each rule replaces its first match; rules see the previous rule's output.
export function rewriteMessage(message: string, rules: RewriteRule[]): string {
  for (const rule of rules)
    message = message.replace(new RegExp(rule.pattern), rule.replacement);
  return message;
}
