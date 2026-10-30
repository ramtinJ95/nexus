/** The project store: each project's record, in `projects`. */
import { json, type Db, type Row } from "./db.ts";
import type { ProjectId } from "../ids.ts";
import type { Project } from "./project.ts";

export type ProjectStore = ReturnType<typeof projectStore>;

export function projectStore(db: Db) {
  const { transaction, sql } = db;
  function project(id: ProjectId): Project | undefined {
    const row = sql("SELECT record FROM projects WHERE id = ?").get(id);
    return row && json<Project>(row.record);
  }
  return {
    editProject(id: ProjectId, edit: (stored: Project) => Project): Project | undefined {
      return transaction(() => {
        const stored = project(id);
        if (stored === undefined) return undefined;
        const edited = edit(stored);
        sql("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(edited), id);
        return edited;
      });
    },
    updateProject(project: Project) { sql("UPDATE projects SET record = ? WHERE id = ?").run(JSON.stringify(project), project.id); },
    createProject(project: Project) { sql("INSERT INTO projects (id, record) VALUES (?, ?)").run(project.id, JSON.stringify(project)); },
    projects: () => (sql("SELECT record FROM projects ORDER BY id").all() as Row[]).map((r) => json<Project>(r.record)),
    project,
  };
}
