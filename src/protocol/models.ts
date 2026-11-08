/**
 * The models Nexus picks for itself: the control plane when it starts a worker or a reviewer, the probe when it seeds a
 * guest's Claude settings, and the deployer when it writes a new control.json. deploy/control.example.json repeats the
 * harness model, because JSON cannot import it; main.test.ts holds the two the same.
 */

/** The Claude model a Claude worker runs when its request names none. */
export const defaultClaudeModel = "claude-opus-5-5";

/** The Claude models a second reviewer may run, the strongest first. */
export const secondReviewerModels = [defaultClaudeModel, "claude-fable-5-1", "claude-sonnet-5-5"] as const;

const claudeFamilies = /opus|fable|sonnet|haiku/i;

/**
 * A model's family, so that an alias, such as `opus`, or a variant, such as `claude-opus-5-5[1m]`, counts as the model
 * it runs. A model of no Claude family is its own.
 */
export const modelFamily = (model: string) => claudeFamilies.exec(model)?.[0].toLowerCase() ?? model;

/** The harness model a new control.json names. */
export const defaultHarnessModel = { provider: "openai", modelId: "gpt-6-astra" } as const;
