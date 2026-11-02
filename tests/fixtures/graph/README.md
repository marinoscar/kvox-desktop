# Graph fixtures (synthetic)

Every file here is made up; none comes from a real meeting. Each is a `kvox.transcript/v1` export with named speakers, imported by `tests/e2e/graph-ask.spec.ts`. What the scripted model extracts from them is in `tests/support/scripted-model.ts`.

| File | Meeting | Speakers | What it states |
|---|---|---|---|
| `g01-weekly-sync.transcript.json` | Weekly sync with Morgan Placeholder | Morgan Placeholder, Jamie Fixture, Jordan Sample | Jamie Fixture reports to Morgan; Jordan will send the budget draft (open) and finished the vendor review (done) |
| `g02-standup.transcript.json` | Jordan and Jamie standup | Jordan Sample, Jamie Fixture | A meeting without Morgan, which "meetings with Jamie's boss" must leave out |
| `g03-platform-review.transcript.json` | Data platform review with Riley Demo | Riley Demo, Quinn Testcase | Nothing about who Quinn reports to: the test sets it by hand |
