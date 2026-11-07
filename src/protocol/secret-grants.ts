/** The secrets a pylon can be granted, by name and the hosts each may reach. Nodes and the control plane both read them. */

/** A secret is a name plus the hosts it may be sent to. The value lives in each node's secret file. */
export interface SecretGrant { name: string; hosts: readonly string[] }
/** A grant's name, as an environment variable is named. */
export const secretNamePattern = /^[A-Z_][A-Z0-9_]*$/;
/** A host a grant sends its secret to: a lower-case hostname of two labels or more. */
export const secretHostPattern = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** The grant `gh`, and git through gh's credential helper, need to create GitHub repositories and push to them. */
export const githubTokenGrant: SecretGrant = { name: "GH_TOKEN", hosts: ["api.github.com", "github.com"] };
/**
 * The access token of the harness's own Sign in with ChatGPT, for pi's `openai` provider. Its value is not in any
 * node's secret file: the control plane holds it, refreshes it, and hands it to every probe.
 */
export const chatgptTokenGrant: SecretGrant = { name: "NEXUS_CHATGPT_TOKEN", hosts: ["api.openai.com"] };
