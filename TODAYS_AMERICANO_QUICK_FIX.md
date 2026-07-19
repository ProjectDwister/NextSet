# Today's 8-player Americano quick fix

This repository version makes the existing full-screen 8-player event page use the exact perfect draw for:

- Anandita
- Arunima
- Neetul
- Pam
- Poonam
- Ritika
- Shweta
- Swat

The page displays Court #2 and Court #3 for all seven rounds. It overlays the perfect draw in the browser while continuing to store scores and round confirmations in the existing Firebase event. No Cloud Function deployment or database migration is required for this emergency fix.

## Deploy now

1. Replace these files in the GitHub repository:
   - `americano-8-player-event.html`
   - `events.html`
   - `sw.js`
2. Commit and push to the GitHub Pages branch.
3. Wait for GitHub Pages to finish deploying.
4. Open Court Pop > Events > today's 8-player event.
5. Select **Open the full-screen live event page**.
6. Use **Share live link** on that page and send the generated URL to the players.

The shared URL has this form:

`https://ministryofcourts.com/americano-8-player-event.html?event=FIREBASE_EVENT_ID`

## Access and score entry

- Accepted players can sign in and see the complete perfect draw, live scores and standings.
- Only event organizers can enter, edit, confirm or reopen scores.
- Add the two scorekeepers as organizers and have them accept the organizer invitation before opening the link.
- Later rounds are visible immediately, but score entry unlocks sequentially as preceding rounds are confirmed.

## Important

The connected Firebase event must contain exactly the eight names above. The page checks the names before displaying the draw so a different event cannot accidentally use today's schedule.
