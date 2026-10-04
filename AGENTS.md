# AGENTS.md

For Codex and any other coding agent. The rules are the same as for Claude Code: read [CLAUDE.md](CLAUDE.md) first (branch and pull request into `main`, synthetic data only, secrets only in `.env`, rules decide medical flags and the model only words them, no dosing advice or diagnosis).

- Server code is in `apps/server`; run `npm run lint && npm test` there. `docs/QA.md` is the phone test, `docs/DEMO.md` the demo.
- Don't merge your own pull request: Michael approves merges, in his own words.
- Who edits what in `apps/server/src/calls/` (agreed 2026-10-04): Claude Code owns `audio.ts`, `service.ts`, `orchestrator.ts`, `copy.ts`, `../config.ts` and their tests. Codex owns `quiet-measurement.ts`, `video.ts`, `../vitals/frame-clock.ts` and the camera tests, and the photo reading in `../llm/gemini.ts` with its image tests. Hand a change across the line through a pull request.
- The live agent (`npm run agent` on Michael's Mac) belongs to Claude Code: don't restart it or use its tokens.
- Open product and medical questions go in [FEEDBACK.md](FEEDBACK.md).
