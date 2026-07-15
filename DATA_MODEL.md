# Data model

Three collections. No Google Sheet anywhere in this version — Firestore is
the only source of truth.

## `users/{uid}`

One doc per registered player. Document id is the Firebase Auth uid.

| field       | type      | notes                                  |
|-------------|-----------|-----------------------------------------|
| `phone`     | string    | E.164, e.g. `+919876543210`             |
| `name`      | string    | set once at first sign-in               |
| `createdAt` | timestamp |                                          |

Self-read-only. See "Why users is locked down" below.

## `events/{eventId}`

The actual games. Document id is auto-generated.

| field             | type              | notes                                    |
|-------------------|-------------------|--------------------------------------------|
| `createdBy`       | uid               | the organizer                              |
| `dateTime`        | timestamp         | combined date + start time                 |
| `durationMin`     | number            |                                             |
| `location`        | string            |                                             |
| `court`           | string            |                                             |
| `format`          | string, optional  | e.g. "Men's Americano" — its own field now |
| `notes`           | string, optional  | e.g. "payment pending"                     |
| `participants`    | array\<uid\>      | always includes `createdBy`                |
| `participantNames`| map\<uid,string\> | denormalized display names, see below      |
| `createdAt`       | timestamp         |                                             |
| `updatedAt`        | timestamp         |                                             |
| `reminder24hSentAt` | timestamp, optional | set by the reminders Cloud Function, never by clients |
| `reminder12hSentAt` | timestamp, optional | same                                       |

`format` and `notes` exist so nothing like "Women Americano" ever has to
get typed into a players field again.

## `users/{uid}/pushSubscriptions/{subId}`

One doc per subscribed device/browser. `subId` is a SHA-256 hash of the
subscription's push endpoint, computed client-side — re-subscribing the
same device overwrites its own doc instead of creating duplicates.

| field       | type      | notes                                  |
|-------------|-----------|-----------------------------------------|
| `endpoint`  | string    | the push service URL for this device     |
| `keys`      | map       | `{p256dh, auth}` — the subscription's own encryption keys, not a secret this app holds |
| `createdAt` | timestamp |                                          |

Written and read only by its own owner from the client; the reminders
Cloud Function reads across all users' subscriptions using the Admin
SDK, which bypasses these rules entirely (see `functions/index.js`).

## `invites/{eventId}_{invitedPhone}`

One doc per invite. The id is **deterministic**, built from the event id
and the invited phone number — not auto-generated. That's what lets the
rules answer "do I have an invite to this event" with a cheap `get()` on
a known path instead of a query.

| field          | type              | notes                                       |
|----------------|-------------------|-----------------------------------------------|
| `eventId`      | string            |                                                |
| `invitedBy`    | uid               |                                                |
| `invitedPhone` | string            | E.164 — works even before that person signs up |
| `invitedName`  | string, optional  | whatever the inviter typed for them            |
| `status`       | string            | `pending` \| `accepted` \| `declined`          |
| `createdAt`    | timestamp         |                                                |
| `respondedAt`  | timestamp, optional |                                              |

## `tournaments/{tournamentId}`

Rally's data — a whole tournament (roster, format, generated draw,
live scores) as one document, auto-generated id. Structurally this is
whatever shape Rally's own React state is (`stage`, `format`, `players`,
`rounds`, etc.) plus:

| field        | type      | notes                                    |
|--------------|-----------|--------------------------------------------|
| `createdBy`  | uid       | recorded for reference, not enforced by the rules — see below |
| `createdAt`  | timestamp |                                            |
| `updatedAt`  | timestamp | bumped on every structural save and every per-court score update |

**This one is deliberately not scoped like `events`/`invites` above.**
Those restrict a document to its specific participants; `tournaments`
is readable and writable by *any* signed-in NextSet user, full stop.
That's not an oversight — it's what live courtside sync actually needs:
Rally was always "share a link, whoever's at the courts can jump in,"
and the tournament id (an unguessable Firestore auto-id) is the real
access boundary, same as it always was. What changed by wiring this to
NextSet's sign-in is *who's* allowed to hold that id at all — a
verified NextSet account now, not literally anyone on the internet —
not how tightly an individual tournament is locked down once you have
its link. If a future version needs per-tournament access control the
way events do, that's a real change to make deliberately, not a gap to
quietly close.

## `padelEvents/{eventId}`

That "real change, made deliberately" from above — the Events section.
A capacity-gated tournament: invited and joined exactly like `events`
above, but once every invite is accepted, a Cloud Function generates
an Americano draw automatically and the whole thing behaves like a
private, participant-only version of a Rally tournament.

| field              | type            | notes                              |
|--------------------|-----------------|--------------------------------------|
| `createdBy`         | uid             |                                      |
| `dateTime`          | timestamp       |                                      |
| `durationMin`       | number          |                                      |
| `location`          | string          |                                      |
| `courts`            | string          | e.g. "Courts 4-6", free text like `court` on events |
| `capacity`          | number          | total players needed, e.g. 12 (must be a multiple of 4) |
| `tournamentFormat`  | string          | `'americano'` — the only one wired up so far; see below |
| `numRounds`         | number          |                                      |
| `pointsTarget`      | number          |                                      |
| `notes`             | string, optional |                                     |
| `participants`      | array of uid    | organizer included from creation, exactly like `events` |
| `participantNames`  | map uid→name    |                                      |
| `drawGenerated`     | boolean         | flips to true exactly once, the moment `participants.length == capacity` — see the Cloud Function |
| `reminder24hSentAt` / `reminder12hSentAt` | timestamp, optional | same reminder system as `events`, same Cloud Function, just pointed at this collection too |
| `createdAt` / `updatedAt` | timestamp |                                |

## `padelEvents/{eventId}/invites/{invitedPhone}`

Same shape and purpose as the top-level `invites/{eventId}_{invitedPhone}`
collection, just nested under its own event instead of using a
composite id at the top level. Nested specifically so its rules can
say "same people who can already see the event," rather than
duplicating the participant-check logic a third time. Not the same
collection as the top-level `invites` — Your Games invites and Events
invites are deliberately kept apart.

## `padelEvents/{eventId}/tournament/draw`

The actual Americano draw, written once by the `generateDrawOnFull`
Cloud Function the moment `participants.length` reaches `capacity` —
never by a client directly, though clients (any participant) can
read and write it afterward to enter scores, same trust level Rally's
own `tournaments` collection uses. Same shape as a Rally tournament
document (`players`, `rounds`, `numCourts`, `pointsTarget`), deliberately
kept structurally identical so the same client-side scoring/standings
logic can be reused rather than reimplemented.

The pairing algorithm itself is ported into the Cloud Function
byte-for-byte from Rally's own `generateFullAmericanoSchedule` and its
helpers (`functions/index.js`) — not reimplemented from scratch, to
avoid two versions of the same algorithm quietly drifting apart over
time. If Rally's version ever changes, this needs updating to match.
Currently Americano-only, non-mixed-mode only (padelEvents participants
don't carry a gender field the way Rally's manually-entered roster
does) — Mexicano support would reuse this exact same structure.

## Why `users` is locked down

Early draft of this let any signed-in user read any `users` doc, so the
UI could show real names instead of raw phone numbers. Dropped that:
once this is shared as a template, "any signed-in user" stops meaning
"someone in your group" and starts meaning "anyone who's ever signed up
on any deployment of this app" — and a collection of everyone's phone
number, readable by any other signed-up stranger, is exactly the kind of
thing that's supposed to be impossible.

Instead, `participantNames` on the event itself carries the display name
of everyone in that game, written by each person for themselves the
moment they join. Anyone who can already read the event (i.e. is already
in it, or holds an invite to it) can see those names — nobody needs to
separately read someone else's `users` doc to render a participant list.

## Client query patterns

The rules only allow what the client can *prove* is scoped to the
signed-in user. In practice that means:

1. **"My games"** — `events.where('participants', 'array-contains', myUid)`.
   Covers games you created and games you've joined.
2. **"My pending invites"** — `invites.where('invitedPhone', '==', myPhone).where('status', '==', 'pending')`.
   Each result has an `eventId`.
3. **Preview an invited event** — `events.doc(eventId).get()` for each
   `eventId` from step 2. This is a single-document read, allowed by the
   `hasAnyInvite()` clause in the rules, so someone can see what they're
   being invited to before accepting.
4. **Accepting** — two writes, in this order: (a) `invites` doc status
   `pending → accepted`, then (b) `events` doc `participants` gets your
   uid appended. The order matters — the events-update rule checks for
   an *already-accepted* invite, so accepting the invite has to land
   first.

Never run an unfiltered `.get()` across the whole `events` or `invites`
collection — the rules are written to reject that, on purpose.

## Deferred to a later pass

- **Leaving a game you've joined.** Skipped for now to keep the first
  version of the rules smaller and easier to verify. Straightforward to
  add later (Firestore rules support set difference — `list.toSet().difference(...)`
  — for exactly this).
- **Rate limiting / abuse protection** beyond what the rules themselves
  enforce. Fine for a small, trusted group; worth adding Firebase App
  Check before this is ever opened up to strangers.
- **Contact-list matching**, once the native app exists: hash phone
  numbers on-device and check for matches server-side, rather than
  uploading anyone's address book.

## Test before you trust this

I can't execute-test Firestore rules from where I'm writing this — no
live connection to your project. Firestore's Rules Playground (Firebase
console → Firestore Database → Rules) or the local emulator will let you
actually run these. Before treating this as production-ready, check at
minimum:

- [ ] User X cannot read an event they're not a participant in and have
      no invite to.
- [ ] User X *can* read an event's details once they hold a pending
      invite to it (needed to preview before accepting).
- [ ] User X cannot mark their own invite `accepted` on someone else's
      invite doc.
- [ ] User X cannot add themself to an event's `participants` without an
      accepted invite existing first.
- [ ] An unfiltered `invites.get()` (no `where` clause) is rejected.
- [ ] User X cannot read User Y's `users` doc.
