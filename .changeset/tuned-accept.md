---
"@switchkick/core": minor
---

Local mode's default `policy.accept.fast` is now 0.80 (it was 0.85), chosen with a new set of 206 labelled prompts for `switchkick eval`. Simple requests that Jev is 80–85% sure of now go to the fast tier instead of balanced. Configs that set `accept.fast` keep their value. The tuning guide at https://eased-tech.github.io/switchkick/guides/tuning/ shows the numbers, and notes that `accept.frontier` has no effect.
