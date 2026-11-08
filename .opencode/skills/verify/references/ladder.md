# The 5-layer correction ladder

From poteto's talk: every time you correct the agent for the same mistake, push
the correction one layer down this list. Higher layers are stronger — prose at
the bottom is the weakest enforcement and should carry the least weight.

1. **Codebase / architecture** — make the mistake categorically impossible.
   Her example: the import graph enforces thread boundaries so slow code can't
   leak into the renderer and blow the 16ms frame budget. One paved path, banned
   patterns (her codebase bans comments agents used to justify papering over
   problems), strict conventions, co-located features.
2. **Static analysis** — lint rules, compiler diagnostics, type checks, CI.
   Rule of thumb from the talk: when you correct the agent, encode it as a lint
   rule. Immediate "stop the bleeding", then agents clean up the backlog.
3. **Rules / review bots** — repo rules, AI review (Bugbot), skill instructions.
   Softer than a compiler, stronger than a chat message.
4. **Skills** — verification and workflow skills (this directory): CLIs, feature
   maps, playbooks that teach the agent to work like an engineer.
5. **Style guide / human review** — prose and eyeballs. Necessary last resort,
   never the plan. If review is catching what layers 1–4 should have caught,
   push the correction down.

Plus the **gardener role**: dedicated upkeep that deletes tech debt, keeps one
paved path, and writes the lint rules — so the fleet compounds instead of rots.
