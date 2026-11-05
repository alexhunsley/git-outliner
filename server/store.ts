import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { ViewSchema, type TunedView } from "../src/model.ts";
export class ViewStore {
  constructor(
    readonly directory = process.env.GIT_OUTLINER_DATA_DIR ||
      join(homedir(), ".git-outliner", "views"),
  ) {}
  file(id: string) {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new Error("Invalid view ID.");
    return join(this.directory, `${id}.json`);
  }
  async list(): Promise<TunedView[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const views: TunedView[] = [];
    for (const name of (await readdir(this.directory))
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      // Report invalid saved files instead of silently losing a view.
      views.push(
        ViewSchema.parse(
          JSON.parse(await readFile(join(this.directory, name), "utf8")),
        ),
      );
    }
    return views;
  }
  async save(input: unknown) {
    const view = ViewSchema.parse(input);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(view.id),
      temp = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(view, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temp, file);
    return view;
  }
  async delete(id: string) {
    await unlink(this.file(id));
  }
}
