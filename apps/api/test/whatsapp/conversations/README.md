# Golden conversations

Whole WhatsApp conversations, run by `../golden.e2e.test.ts` against **whaloc-test** (port 8090,
webhooks to the test app on port 3099) with the queues inline and the scripted model. One file is
one conversation; each person in it (`kavya`, `owner`, …) gets a number of their own. `owner` is
the business's owner (signed up by the runner); everyone else is a customer.

Run them with the rest of the API tests (`pnpm --filter @app/api test`), or alone:
`pnpm --filter @app/api exec vitest run test/whatsapp`. They are skipped when whaloc-test is not
running (`docker compose up -d whaloc-test`).

## Steps

| Step | What it does |
|---|---|
| `say: {as, text}` | A text message from them |
| `voice: {as, lang, text}` | A voice note whose words are `text` (fake speech-to-text) |
| `tap: {as, button, sentTo?}` | Tap a button by its title on the latest message that has it (sent to `sentTo`, default themselves: a forwarded button when different) |
| `repeat: {}` | Send the last message again (a double tap) |
| `redeliver: {as}` | Meta delivers the webhook of their last message again |
| `linkOwner: {}` | The owner's number, linked to their account |
| `shiftWindow: {as, hours}` | Their messages to us, moved back in time (closes the 24-hour window) |
| `inject: {preset} \| {code, status?}` | The next send fails: a whaloc preset (`rate_limit_429`), or a Meta error code |
| `api: {as, method, path, body?, save?, status?}` | Call the API as the owner, or as a customer's assistant |
| `fire: {dedupe}` | Run a scheduled notification now |
| `template: {name, status: approve\|reject}` | Meta's decision on a template, then the sync that records it |
| `query: {sql, params?, save}` | Keep the first row for later steps |
| `wait: ms` | Pause |

Values: `${saved.path}` from `save`, `${address.<person>}`, and `${soon.startsAt}`,
`${soon.endsAt}`, `${soon.reminderAt}` (a meeting in two hours) and `${later.*}` (an hour later).
In SQL, `$tenant` and `$owner` are this run's business and owner.

## Expectations

| Step | Passes when |
|---|---|
| `expect: {to, text?, template?, lang?, buttons?, within?}` | The next message to them matches (`text`: words it contains, or `/regex/`) |
| `expectNone: {to, for?}` | Nothing more reaches them for `for` ms |
| `expectEmail: {to: owner, subject}` | Mailpit has it |
| `expectDb: {sql, params?, rows}` | The query returns exactly these rows |
| `expectAudit: {action, count?}` | The business's audit trail has it this many times |
| `expectScheduled: {dedupe, at}` | The notification is scheduled for that minute (`null`: not at all) |
