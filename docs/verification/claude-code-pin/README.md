# Claude Code 2.1.310 in the pylon image

Captured in this thread's pylon on 2026-10-26.

`run.sh . main <scratch>` loads the image recipe at main and on this branch with the branch's `loadImageRecipe`, as the control plane does. `01-recipe.txt` shows the result. The loader reads `claudeCode` 2.1.310 from `pins.json`, and the image ID moves from `img-d6b8eb68b0c7` to `img-95c47995c258`. Node stays 24.22.1. The script then installs `@anthropic-ai/claude-code@2.1.310` from npm and passes the real `claude --version` output to the smoke boot's `claude version` check, which passes.

The transcripts come from one headless prompt, `claude -p 'Reply with the single word: pong' --model claude-haiku-5-5`, run once with this pylon's Claude Code 2.1.308 and once with that 2.1.310 install. Each run used its own `CLAUDE_CONFIG_DIR`. `parse.ts <transcript>` prints each record's type and version, then what `parseRecord` makes of it. In `02-transcript-2.1.308.txt` and `03-transcript-2.1.310.txt`, both versions write the same record types in the same order, and the reader gives the same prompt, queue and reply entries.

Not verified:
- An image build and its smoke boot. Building and rolling out images is the person's job.
- Claude Code 2.1.310's hook inputs in a pylon, which Nexus's `nexus-claude-hook` reads.
- A longer transcript with tool calls, subagents or a usage-limit stop.
