/**
 * What the start dialog says a new thread boots on and checks out. client.js writes it from the parts below whenever
 * the dialog opens or changes, as only its script can start a thread. A part with a look is shown in that element.
 */
export interface HintPart { text: string; look?: "b" | "code" }

export function startHint(o: { node: string; image: string | null; branch: string; scratch: boolean }): HintPart[] {
  return [
    { text: "Boots a pylon on " },
    o.node === "auto" ? { text: "the node with the most room left" } : { text: o.node, look: "b" },
    ...o.image === null ? [] : [{ text: " from image " }, { text: o.image, look: "code" as const }],
    { text: o.scratch ? " and starts an empty repository on " : " and checks out " },
    { text: o.branch, look: "code" },
    { text: "." },
  ];
}
