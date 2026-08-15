# Mixed Americano — 12 players / 6 rounds / Courts #2, #3, #4

This build adds a fixed **Mixed Americano · 6 female + 6 male** option to `events.html`.

## Fixed roster

Female: Pinder, Neetul, Arunima, Shweta, Poonam, Sonia  
Male: Sagar, Gautam, Rohit, Krish, Piyush, Raghav

The app now seeds these 12 fixed roster entries automatically as soon as the event is created. The Cloud Function validates the names and genders before generating the draw.

## Tournament rules implemented

- 12 players, 6 rounds, 3 courts.
- Every player plays every round.
- Every male partners each female exactly once.
- Every female partners each male exactly once.
- All 36 mixed partnerships occur exactly once.
- No male-male or female-female partnerships.
- Court labels are the real booked labels: Court #2, Court #3 and Court #4.
- Court rotation is balanced between 1 and 3 appearances per court; Krish and Shweta are exactly 2/2/2.
- No opponent pair occurs more than twice in the fixed draw.
- Only organizers can write scores; this mixed format supports up to 3 organizers: the event creator plus Pinder and Neetul.
- Organizers can inspect the full six-round schedule in the organizer-only draw audit. Regular players still receive only the progressively revealed live draw. Round N+1 is copied into the live draw only after all three courts in Round N have both scores entered.
- Scoring is **open-ended**: there is no 24-point target and the two team scores do not need to add to any fixed total. Enter the actual final score from each court.
- Round N+1 unlocks automatically once **both team scores are entered on all three courts** in Round N.
- Standings react live as soon as both sides of a match have scores; no Confirm button is required for the mixed format.

## Organizer setup

Create the event while signed into your own Court Pop account. That account becomes the first organizer/scorekeeper even if you are not playing. Then invite **Pinder** and **Neetul** separately as organizers by phone; when they authenticate with Firebase Phone Auth and accept, their Firebase UIDs are added to the organizers list. Firestore score writes are organizer-only.

## Deployment

1. Replace the repo files with this build and push to `main`.
2. The included GitHub Actions workflow now watches `functions/**`, `firebase.json`, `firestore.rules` and `.firebaserc`, and deploys **Cloud Functions + Firestore Rules** together using the repo's existing Firebase service-account secret.
3. GitHub Pages will publish the web files as usual.
4. In GitHub → Actions, confirm **Deploy Cloud Functions** finishes successfully.
5. Hard-refresh `https://ministryofcourts.com/events.html` once after the deployment finishes.

Manual fallback, from the repo root, if the GitHub Action is not configured or fails:

`firebase deploy --only functions,firestore:rules --project games-scheduler-aa101`

## Create the event

1. Open Events → New event.
2. Choose **Mixed Americano · 6 female + 6 male**.
3. Date/time/venue are still editable; player count, rounds and court labels are locked to the fixed format.
4. Press **Create event**. The app automatically inserts the 12 fixed roster entries; there is no player-add step.
5. The Cloud Function generates the exact fixed draw automatically. Players receive Round 1 first, while organizers can immediately audit all 6 rounds.
6. Invite Pinder and Neetul as organizers by phone so they can enter/edit scores from their authenticated accounts.

## Fixed draw used by the Cloud Function

| Round | Court #2 | Court #3 | Court #4 |
|---|---|---|---|
| 1 | Sagar & Pinder vs Krish & Shweta | Gautam & Neetul vs Piyush & Poonam | Rohit & Arunima vs Raghav & Sonia |
| 2 | Sagar & Arunima vs Rohit & Poonam | Krish & Sonia vs Piyush & Shweta | Gautam & Pinder vs Raghav & Neetul |
| 3 | Piyush & Sonia vs Raghav & Poonam | Sagar & Shweta vs Gautam & Arunima | Rohit & Neetul vs Krish & Pinder |
| 4 | Gautam & Shweta vs Rohit & Sonia | Krish & Neetul vs Raghav & Arunima | Sagar & Poonam vs Piyush & Pinder |
| 5 | Gautam & Poonam vs Krish & Arunima | Sagar & Sonia vs Raghav & Pinder | Rohit & Shweta vs Piyush & Neetul |
| 6 | Sagar & Neetul vs Gautam & Sonia | Rohit & Pinder vs Piyush & Arunima | Krish & Poonam vs Raghav & Shweta |

### Balance audit

- 36/36 male-female partnerships occur exactly once.
- Every player plays 6/6 rounds.
- No same-gender partnerships occur.
- No opponent pairing occurs more than twice.
- Opponent distribution across all 66 player-pairs: 48 pairs meet once, 12 meet twice, 6 do not meet.
- Court appearances stay between 1 and 3 on each physical court. Krish and Shweta are exactly 2/2/2; the other players are 3/2/1 in some order.


## Scorekeeper authentication

For this fixed mixed event, the account that creates the event is automatically the first organizer/scorekeeper even if that person is not one of the 12 players. The creator is kept outside the 12-player roster automatically. The fixed roster is represented by dedicated roster ids, so the creator cannot accidentally become a 13th player even if the creator's profile name matches one of the players.

Pinder and Neetul receive separate organizer invitations using the phone numbers tied to their Court Pop/Firebase Auth accounts. Each must sign in with that same verified phone number and accept the organizer invitation. Acceptance adds that account's Firebase UID to the event's `organizers` array. Score writes are authorized against those organizer UIDs, not against display-name text.

The mixed event therefore supports up to three organizers/scorekeepers: the creator, Pinder, and Neetul.

## Separate live scoring page

The mixed 12-player event keeps setup and organizer invitations on `events.html`. Once organizer invitations for Pinder and Neetul have been sent, the organizer can open:

`mixed-americano-12-event.html?event=<EVENT_ID>`

That page contains only two top-level views: **Scores** and **Standings**. Scores remain organizer-only; any signed-in viewer can follow the live scores and standings. Standings recalculate as soon as both team scores for a court are present. Round N+1 is still revealed by the existing Cloud Function only after all three courts in Round N have both scores entered.
