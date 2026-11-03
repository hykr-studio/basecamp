# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

One Expo codebase ships to the web, iOS and Android now, with the same design on all three. Phones get responsive layouts, not platform-specific styling.

## Users

Developers on the team who will build real products on this stack. They run the app locally to see how the pieces fit together: the entity framework, the assistant acting for a person, approvals and the audit trail. They then copy its patterns into the next product.

## Product Purpose

A template for a real product, not the product itself. The meetings, notes and to-dos domain is a placeholder that exercises every part of the stack, so the patterns are proven before a real domain replaces it.

Success means a developer can add a real business entity as one declaration, and it gets screens, agent tools, approvals and audit without hand-written plumbing. They can also see exactly what the assistant did and why.

Open decision: which real product replaces the placeholder domain. The build guide names heavy-equipment matching (location search) as a later piece, but it is not confirmed as the product.

## Positioning

The assistant has no more power than the person it acts for. It reaches data only through the same API as the app, under its own key. Every write takes one path: authorize, then do it, park it for the person's approval, or refuse it, with an audit row in the same transaction. A multi-entity operation drafted by the assistant, such as closing a meeting with a note and its to-dos, is approved or rejected as one unit.

## Operating Context

- Run locally: Docker Compose services, the NestJS API on port 3000, the Expo web app on 8081, Mastra Studio on 4000 and pgAdmin on 5050.
- The assistant runs on a scripted model (MODEL_MODE=fake) for tests, CI and demos without a model key, or on a live model through OpenRouter.
- Developers inspect runs in Mastra Studio (traces, logs, scores) and in the `audit.events` table. A chat's `runId` is its trace id.
- Demo flows: add a meeting; paste notes so the assistant drafts a close for approval; reschedule a meeting, which moves its to-dos too.

## Capabilities and Constraints

- Entities: to-dos, notes and meetings, each one declaration. Each has list, get, create, update and delete actions, a validated list grammar (filters, search, sort, cursor pages), and per-action exposure (everyone, people only, or internal).
- Commands: close a meeting (a summary note, one to-do per action item, the meeting closed, all in one transaction) and reschedule a meeting (moves its open to-dos' due dates).
- Approvals: any operation can be parked. The approval card shows the summary, who asked (the person or the assistant) and when it expires. Approving replays the stored operation; if a replay is refused, the card shows why.
- The assistant works with the person's screen context: on a meeting, "close this one" and pasted notes need no meeting name.
- Sign-in is email and password (Better Auth). Sessions are browser cookies on the web; the native apps will need Better Auth's Expo plugin.
- Data residency: OpenRouter sends data outside India, so it is for development only.
- Terminology: "to-do" (not task), "meeting", "note", "approval", "assistant" (not bot or AI), "close" a meeting, "move" or "reschedule" it.

## Evidence on Hand

No real users, customers, testimonials or usage data exist. All content is placeholder, flavoured as construction-site work (tiles, cement, site reviews, plumbers). Future work must not present it as real customer evidence, or invent any.

## Product Principles

1. The person stays in charge. Anything the assistant asks to do that needs approval is visible, readable in full, and decided by the person, never auto-applied.
2. Show the machinery. A developer evaluating the stack should be able to see what the assistant called, what was parked, and what was refused and why.
3. Build from the framework's parts. Screens use the generic building blocks (entity lists, mutations, commands, the approval card), so a real domain can replace the placeholder without redesigning the app.
4. One design everywhere. The same interface on the web and on phones, adapting to screen size rather than to the OS.
