# Graph fixtures (synthetic)

Every file here is made up; none comes from a real meeting. Each is a `kvox.transcript/v1` export with named speakers, imported by `tests/e2e/graph-ask.spec.ts`. What the scripted model extracts from them is in `tests/support/scripted-model.ts`.

| File | Meeting | Speakers | What it states |
|---|---|---|---|
| `g01-weekly-sync.transcript.json` | Weekly sync with Maria Lopez | Maria Lopez, Jenny Kim, Joe Park | Jenny Kim reports to Maria; Joe will send the budget draft (open) and finished the vendor review (done) |
| `g02-standup.transcript.json` | Joe and Jenny standup | Joe Park, Jenny Kim | A meeting without Maria, which "meetings with Jenny's boss" must leave out |
| `g03-platform-review.transcript.json` | Data platform review with Mark Chen | Mark Chen, Priya Shah | Nothing about who Priya reports to: the test sets it by hand |
