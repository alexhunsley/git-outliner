import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
export function fixtureGit(path: string, ...args: string[]) {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_DATE: "2026-01-01T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T12:00:00Z",
    },
  }).trim();
}
export async function createFixture(path: string) {
  await mkdir(path); // Refuse to overwrite an existing directory.
  const g = (...args: string[]) => fixtureGit(path, ...args);
  g("init", "-b", "main");
  g("config", "user.name", "Demo Author");
  g("config", "user.email", "demo@example.invalid");
  g("config", "commit.gpgsign", "false");
  g("config", "core.hooksPath", "/dev/null");
  g("commit", "--allow-empty", "-m", "Initial demo history");
  function merge(branch: string, subject: string, body = "") {
    const destination = g("branch", "--show-current");
    g("switch", "-c", branch);
    g("commit", "--allow-empty", "-m", `Work on ${branch}`);
    g("switch", destination);
    g("merge", "--no-ff", branch, "-m", subject, ...(body ? ["-m", body] : []));
    g("branch", "-D", branch);
    return g("rev-parse", "HEAD");
  }
  const shared = merge("feature/foundation", "CTR-100 Establish the platform");
  g("switch", "-c", "staging");
  const staging = merge(
    "feature/search",
    "CTR-201 Search & discovery",
    'Also covers CTR-202. A label with <angle brackets> and "quotes".',
  );
  g("switch", "-c", "release/1.0");
  const release = merge(
    "fix/accessibility",
    "CTR-201 Improve keyboard navigation",
  );
  merge("maintenance", "Routine maintenance without a ticket");
  g("switch", "main");
  const main = merge("feature/reporting", "CTR-301 Reporting dashboard");
  return { shared, staging, release, main };
}
