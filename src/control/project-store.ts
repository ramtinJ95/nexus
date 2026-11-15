import { json, type Db, type Holding, type Row } from "./db.ts";
import type { ProjectId } from "../ids.ts";
import { upgradeProject, type Project } from "./project.ts";

export const holding = { tables: { projects: {} } } as const satisfies Holding;

/** `onEdit` hears of each project's edit in its transaction, so what reads the project, such as attention, is recomputed. */
export function projectStore(db: Db, onEdit: (id: ProjectId) => void = () => {}) {
  db.hold(holding);
  const { transaction, sql } = db;
  const starting = new Map<ProjectId, number>();
  function project(id: ProjectId): Project | undefined {
    const row = sql("SELECT record FROM projects WHERE id = ?").get(id);
    return row && upgradeProject(json<Project>(row.record));
  }
  return {
    editProject(id: ProjectId, edit: (stored: Project) => Project): Project | undefined {
      return transaction(() => {
        const stored = project(id);
        if (stored === undefined) return undefined;
        const edited = edit(stored);
        sql("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(edited), id);
        onEdit(id);
        return edited;
      });
    },
    createProject(project: Project) { sql("INSERT INTO projects (id, record) VALUES (?, ?)").run(project.id, JSON.stringify(project)); },
    projects: ({ removed = false }: { removed?: boolean } = {}) => (sql("SELECT record FROM projects ORDER BY id").all() as Row[])
      .map((r) => upgradeProject(json<Project>(r.record))).filter((p) => removed || p.removed === undefined),
    /** A start holds its project across remote reads and harness creation, before its thread row exists. */
    reserveStart(id: ProjectId): () => void {
      starting.set(id, (starting.get(id) ?? 0) + 1);
      return () => {
        const left = starting.get(id)! - 1;
        if (left === 0) starting.delete(id);
        else starting.set(id, left);
      };
    },
    starting: (id: ProjectId) => starting.has(id),
    project,
  };
}
