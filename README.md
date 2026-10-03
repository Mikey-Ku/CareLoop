# Mhacks_2026

A daily check-in companion for older adults living alone with several chronic conditions, built on FinchNode, Relay Messenger, ElevenLabs and Presage.

**Status:** in progress (MHacks 2026)

## What it does

Each morning a Relay agent starts a short, friendly chat with at most three questions picked from the senior's FinchNode health record. She can choose a voice call to talk or a video call that compares her heart rate with her usual range from clinic visits and records her breathing rate. Photos of hospital papers are checked against her medication list, and her family follows along in a Relay group chat.

All data in this project is synthetic.

## Setup

Requires Node 22.18 or newer: the server runs its `.ts` files directly through Node's built-in type stripping, with no build step.

```sh
cd apps/server
npm install
cp ../../.env.example ../../.env   # optional for run 1
```

The `.env` file lives at the repo root. Run 1 needs no keys: the FinchNode demo API is open and every other value has a default.

## Usage

All commands run in `apps/server`.

| Command | What it does |
| --- | --- |
| `npm test` | Runs the test suite (vitest). |
| `npm run lint` | Typechecks the project (`tsc --noEmit`). |
| `npm run packet -- patient-demo-polypharmacy` | Prints Harriet's context packet built from the recorded fixtures. Add `--live` to read the FinchNode demo API instead. |
| `npm run record-fixtures` | Re-records the fixtures in `fixtures/` from the FinchNode demo API. |
| `npm run dev` | Starts the server on `PORT` (default 3000). For now it serves only `GET /health`; `/webhooks/relay` answers 501 until run 2. |

### Simulator

`npm run simulate` runs Harriet's morning check-in in the terminal, with no phones: her chat ("Harriet's phone") and the family group print as separate chats, and you type her replies. A number taps that button on her latest message; any other text is sent as her message. Synthetic data, offline by default (recorded fixtures; `--live` reads the FinchNode demo API).

```
npm run simulate -- [subject] [--day YYYY-MM-DD] [--db path] [--reset] [--live] [--script file] [--sharing status|status_vitals|all]
```

- Days carry over in `data/simulator.db`; `--reset` deletes that file first. `--day` defaults to `CLOCK_DATE`, else her data as-of date (2026-09-01).
- Commands: `/next` (next day), `/day YYYY-MM-DD`, `/noon` (missed check-in job), `/flags`, `/sharing <level>`, `/paper` (discharge paper read-back and R6 check), `/db`, `/help`, `/quit`.
- `--script file` runs one input per line (`#` comments) and exits, non-zero if any input failed. Demo backups live in `scripts/demo/`, for example `npm run simulate -- --reset --script ../../scripts/demo/harriet-day1.txt`. `harriet-red-flag.txt` needs `--day 2026-09-02`.

## How it works

- What and why: [docs/BRIEF.md](docs/BRIEF.md)
- How: [docs/DESIGN.md](docs/DESIGN.md)
- Glossary of domain terms: [CONTEXT.md](CONTEXT.md)

## Working with Claude Code

1. Add notes for the next run to `FEEDBACK.md`, commit and push.
2. Open Claude Code in this folder and say: "Read CLAUDE_CODE_BRIEF.md and start the next run."
3. Review `RUN_LOG.md` after each run.

## License

MIT
