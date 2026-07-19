# Firebase-backed 8-player Americano event page

The live event page is:

- `americano-8-player-event.html`
- URL format: `https://ministryofcourts.com/americano-8-player-event.html?event=FIREBASE_EVENT_ID`

The event id is added automatically by the new **Open the full-screen live event page** link inside any Court Pop event configured for 8 players and 7 rounds.

## What changed

The page no longer stores scores in one browser or creates snapshot links. It now uses the existing Firebase data already used by `events.html`:

- Event details: `padelEvents/{eventId}`
- Live/revealed draw and scores: `padelEvents/{eventId}/tournament/draw`
- Organizer-only complete draw: `padelEvents/{eventId}/tournament/fullDraw`

Score edits use the existing transaction-based functions in `padelEvents.js`, so two phones entering scores on different courts do not overwrite each other.

## Player flow

1. Create an Americano event from Court Pop Events.
2. Set capacity to 8, rounds to 7 and points to 24.
3. Invite the players and have them accept.
4. When all 8 players have joined, Firebase generates the draw.
5. Open the event in `events.html` and tap **Open the full-screen live event page**.
6. Share that URL with the players.

A player must be signed in with an invited Court Pop account and must have accepted the event invitation. Signed-out users are sent to the existing phone sign-in page and returned to the live event afterward.

## Live scoring behavior

- Every participant or organizer can enter scores from their phone.
- Score fields sync to Firebase while being entered.
- Confirming a round counts it in the standings and reveals the next round through the existing Cloud Function.
- Reopening a confirmed round makes it editable again.
- Standings update immediately on every connected device.
- Organizers can see the complete draw because the existing Firestore rules allow them to read `fullDraw`.
- Regular players see rounds as they are revealed, matching the existing Events flow.

## Files changed

- `americano-8-player-event.html`
- `padelEvents.js`
- `events.html`
- `index.html`
- `sw.js`
- `AMERICANO_EVENT_SETUP.md`

No Firebase project configuration, database migration or new Cloud Function is required. The page reuses the existing `padelEvents` data model and score APIs.
