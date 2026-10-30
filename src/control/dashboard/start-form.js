// The start dialog's project picker and the form drafts a swap keeps. The page passes its own pieces and a test its
// fakes, with the browser globals last.
export function startForm({ starting, syncWorker, updateStartHint, showError }, { document } = globalThis) {
  const projectRadios = () => [...document.querySelectorAll("#start input[name=project]")];

  /** Picks the project, or says it is not offered and picks none, so the thread cannot start on another repo. */
  function selectProject(project) {
    const radio = projectRadios().find((r) => r.value === project);
    for (const r of projectRadios()) r.checked = r === radio;
    showError("start-error", radio === undefined ? new Error(`Project ${project} is not offered here yet. Reload the page to see it.`) : null);
    updateStartHint();
  }

  const formKey = (form) => form.dataset.question ?? form.id;

  /**
   * What the reader has filled in on each form in the regions a swap replaces, by its ID or an ask form's question, so
   * the swap keeps it. The composer keeps its own draft, with its selection.
   */
  function formDrafts(regions) {
    const forms = regions.flatMap((el) => [...el.querySelectorAll("form")]).filter((form) => formKey(form) && form.id !== "prompt");
    return new Map(forms.map((form) => [formKey(form), { form, fields: [...form.elements].filter((f) => f.name !== "").map((f) => ({ name: f.name, value: f.value, checked: f.checked })) }]));
  }
  /** A radio or checkbox is the one of its name and value. A select keeps a value only while it still offers it. */
  function restoreDrafts(drafts) {
    for (const form of document.querySelectorAll("form")) {
      const draft = drafts.get(formKey(form));
      if (draft === undefined || draft.form === form) continue;
      for (const field of [...form.elements].filter((f) => f.name !== "")) {
        const choosable = field.type === "radio" || field.type === "checkbox";
        const was = draft.fields.find((d) => d.name === field.name && (!choosable || d.value === field.value));
        if (was === undefined) continue;
        if (choosable) field.checked = was.checked;
        else if (!field.type.startsWith("select") || [...field.options].some((o) => o.value === was.value)) field.value = was.value;
      }
    }
  }
  /**
   * A start form the swap replaced shows the worker picked, and the project picked or that it is no longer offered,
   * and stays unsendable while a start is in flight.
   */
  function restoreStart(drafts) {
    const form = document.getElementById("start");
    const saved = drafts.get("start");
    if (form === null || saved?.form === form) return;
    syncWorker(form);
    const project = saved?.fields.find((f) => f.name === "project" && f.checked)?.value;
    if (project !== undefined) selectProject(project);
    else updateStartHint();
    form.querySelector("button[type=submit]").disabled = starting();
  }
  return { projectRadios, selectProject, formDrafts, restoreDrafts, restoreStart };
}
