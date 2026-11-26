# One landing in Nexus

Drawn from `model/Chart.cfg` with the view `model/view.mjs`: one landing, one manual deploy, no pushes. The chart follows one landing. The person, GitHub and the fleet act in the background, and a step of theirs that leaves the landing where it is has no arrow. The orange outline marks where finding F1 breaks `RollbackTargetWasHealthy`.

Redraw it with the pstack `/statechart` skill after a change to the model.

```mermaid
---
title: "One landing in Nexus, from approval to deployed or held"
---
stateDiagram-v2
  state "Legend" as legend {
    lg0: Review
    lg1: Landing
    lg2: Done
    lg3: Yours
    lg4: Breaks RollbackTargetWasHealthy in some cases
    lg5: Path to the RollbackTargetWasHealthy bug
  }
  class lg0 blue
  class lg1 orange
  class lg2 teal
  class lg3 pink
  class lg4 mayBreak
  class lg5 bugPath
  s0: Under review
  s1: Approved, asks for its turn
  s2: Holds the turn
  s3: With you, before any merge
  s4: Merged, deploying
  s5: Waits for its turn
  s6: With you, merged outside the review
  s7: With you, after its deploy
  s8: Rolling back
  s9: Landed and deployed
  [*] --> s0
  s0 --> s1: the reviewers approve and the checks pass
  s1 --> s2: nothing is ahead
  s1 --> s3: a hold or GitHub's refusal stops it
  s1 --> s5: an unhealthy release or another landing is ahead
  s1 --> s4: it finds that someone merged the approved commit
  s1 --> s6: a hold or GitHub's refusal stops it
  s2 --> s1: the base branch moves
  s2 --> s3: a hold or GitHub's refusal stops it
  s2 --> s4: GitHub merges the approved commit or after a crash it finds its own merge
  s2 --> s2: you deploy a release by hand
  s3 --> s0: you press Land
  s3 --> s6: someone merges it on GitHub
  s4 --> s8: the deploy fails or runs out of time
  s4 --> s7: the deploy fails with nothing to roll back to or another release replaces it
  s5 --> s2: nothing is ahead
  s5 --> s3: a hold or GitHub's refusal stops it
  s4 --> s9: every service reports healthy
  s5 --> s4: it finds that someone merged the approved commit
  s5 --> s6: a hold or GitHub's refusal stops it
  s8 --> s7: the rollback fails or is replaced or the previous release is healthy again
  classDef mayBreak fill:#fff3e6,stroke:#e8730c,stroke-width:2.5px,color:#b85a06
  class s0 blue
  class s0 bugPath
  class s1 orange
  class s1 bugPath
  class s2 orange
  class s2 bugPath
  class s3 pink
  class s4 orange
  class s4 mayBreak
  class s4 bugPath
  class s5 orange
  class s6 pink
  class s7 pink
  class s8 orange
  class s8 mayBreak
  class s9 teal
```
