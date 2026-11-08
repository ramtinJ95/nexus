/** The cases the merge policy reserves for the person, which a question or a hold names, and what each is called. It imports nothing. */
export const reservedCases = ["secrets", "egress", "auth", "tailnet", "destructive-migration", "image-rebuild", "cli-breaking", "irreversible"] as const;
export type ReservedCase = typeof reservedCases[number];

export const reservedNames: Readonly<Record<ReservedCase, string>> = {
  secrets: "changes to secrets", egress: "changes to the egress allowlist", auth: "changes to login or auth", tailnet: "changes to the tailnets",
  "destructive-migration": "database migrations that delete or rewrite existing data", "image-rebuild": "pylon image rebuilds",
  "cli-breaking": "breaking changes to the CLI's contract", irreversible: "anything irreversible",
};
