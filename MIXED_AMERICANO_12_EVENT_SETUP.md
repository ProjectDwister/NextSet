# Mixed Americano — 12 players / 6 rounds / Courts #2, #3, #4

This build adds a fixed **Mixed Americano · 6 female + 6 male** option to `events.html`.

## Fixed roster

Female: Pinder, Neetul, Arunima, Shweta, Poonam, Sonia  
Male: Sagar, Gautam, Rohit, Krish, Piyush, Raghav

The Cloud Function normalizes case/whitespace and accepts a longer display name whose first name matches one of the roster names. The event must contain exactly these 12 players before the draw is generated.

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
- Only organizers can write scores; Firestore Rules cap this mixed format at 2 organizers.
- For this event, future rounds are not readable even by organizers. Round N+1 is copied into the live draw only after all three courts in Round N have both scores entered.
- Standings react live as score fields are entered; no Confirm button is required for the mixed format.

## Organizer setup

Create the event while signed in as **Pinder or Neetul**. After the other person joins, make that person an organizer from the Organizers section. Keep only **Pinder and Neetul** in the organizers list. Firestore score writes are organizer-only.

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
4. Add/invite the 12 roster names above.
5. Make Pinder and Neetul the only organizers.
6. When the 12th player joins, the Cloud Function generates the exact fixed draw and publishes only Round 1.

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
