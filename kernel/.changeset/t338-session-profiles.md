---
"@amoree-code/ocean": minor
---

Profiles v3, phases 2 and 3 (T-338):
- Each session's profile is now chosen automatically from the project, the task, the repository and the prompt.
- 14 domain profiles ship, and `ocean setup` installs them.
- A newly bound project gets its profile filled in.
- `ocean skill doctor` checks skills against profiles: a missing skill fails; a skill held only by a client, a hub skill in no profile, or a skill loaded twice warns.
- The skill router boosts skills from the session's profiles.
