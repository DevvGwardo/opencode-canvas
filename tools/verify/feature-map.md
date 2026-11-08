# Feature map

Living doc: what exists, how to reach it, what "working" looks like. Update it
when routes, selectors, or flows change — a stale map misroutes agents.

| Feature | How to reach it | Working looks like |
|---|---|---|
| Canvas (sessions on a map) | open `/`, cards grouped by project | cards stream live status; pan/zoom smooth |
| Tiles (running sessions) | press `T` or open `#tiles` | one tile per running session, transcripts stream |
| Session view | click a card / `Enter` | full transcript, steering + permission prompts inline |
| New session | press `N`, pick project + model | session appears on canvas and starts streaming |
| Integrated browser | top bar → Browser | live viewport, clicks type/scroll in the page |

Repro recipe for a bug report: feature row → exact steps → expected vs actual →
minimal fixture. File the repro as a gate in `config.json` so it can't regress.
