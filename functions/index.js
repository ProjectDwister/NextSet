const { onSchedule } = require('firebase-functions/scheduler');
const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const webpush = require('web-push');

admin.initializeApp();
const db = admin.firestore();

// Public key only — safe to duplicate here and in push.js, by design.
// The private half is never in this repo; it's injected at runtime from
// Firebase's own secret manager (see the GitHub Actions workflow).
const VAPID_PUBLIC_KEY = 'BP9fO4d2D_BnrD14un6lAQIeuCFyIMX9zRvDNj_XAvGM72cBZE6TAaZgf3YaCRLTQuicljNHbt4OAneqJbmUBNw';
const vapidPrivateKey = defineSecret('VAPID_PRIVATE_KEY');

function formatWhen(dateTime) {
  // Assumes an India-based group, matching the rest of this app (SMS
  // region, default +91 country code, etc.) — adjust the timeZone here
  // if this is ever deployed for a group somewhere else.
  return dateTime.toDate().toLocaleString('en-IN', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

// Shared by every function below: sends one payload to every device a
// given uid has subscribed from, cleaning up any subscription the push
// service reports as dead (404/410 — unsubscribed, site data cleared,
// etc.) so future sends stop wasting time on it.
async function pushToUser(uid, payload) {
  let subsSnap;
  try {
    subsSnap = await db.collection('users').doc(uid).collection('pushSubscriptions').get();
  } catch (err) {
    logger.error('could not read subscriptions', { uid, error: err.message });
    return;
  }

  for (const subDoc of subsSnap.docs) {
    const sub = subDoc.data();
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
    } catch (err) {
      logger.warn('push send failed', { uid, subId: subDoc.id, status: err.statusCode, message: err.message });
      if (err.statusCode === 404 || err.statusCode === 410) {
        await subDoc.ref.delete().catch(() => {});
      }
    }
  }
}

// Checks a sliding window ending exactly `hoursAhead` from now. The
// window is deliberately 16 minutes wide against a 15-minute run
// cadence — a 1-minute overlap so a slightly delayed run (Cloud
// Scheduler doesn't guarantee millisecond precision) can never let an
// event slip through a gap between two windows. The `sentField` check
// below is what actually prevents that overlap from causing duplicate
// sends, not the window math itself.
//
// Parameterized by collection name so the same logic covers both plain
// Your Games events and capacity-gated padelEvents — the two have
// slightly different shapes (padelEvents has `courts` instead of a
// single `court`) but the reminder text handles both.
async function sendRemindersForWindow(collectionName, hoursAhead, sentField) {
  const nowMs = Date.now();
  const windowStart = admin.firestore.Timestamp.fromMillis(nowMs + hoursAhead * 3600000 - 16 * 60000);
  const windowEnd = admin.firestore.Timestamp.fromMillis(nowMs + hoursAhead * 3600000);

  const snap = await db.collection(collectionName)
    .where('dateTime', '>=', windowStart)
    .where('dateTime', '<=', windowEnd)
    .get();

  if (snap.empty) return;

  for (const eventDoc of snap.docs) {
    const event = eventDoc.data();
    if (event[sentField]) continue; // already handled, even across overlapping windows

    const participants = event.participants || [];
    if (!participants.length) continue;

    const title = hoursAhead === 24 ? 'Game tomorrow' : 'Game today';
    const courtLabel = event.courts || event.court; // padelEvents uses `courts`, events uses `court`
    const where = [event.location, courtLabel].filter(Boolean).join(' · ');
    const body = `${formatWhen(event.dateTime)}${where ? ' · ' + where : ''}`;
    const payload = JSON.stringify({ title, body, url: './' });

    for (const uid of participants) {
      await pushToUser(uid, payload);
    }

    await eventDoc.ref.update({ [sentField]: admin.firestore.FieldValue.serverTimestamp() }).catch((err) => {
      logger.error('could not mark reminder sent', { eventId: eventDoc.id, error: err.message });
    });
  }
}

exports.sendGameReminders = onSchedule(
  {
    schedule: 'every 15 minutes',
    timeZone: 'Asia/Kolkata',
    secrets: [vapidPrivateKey],
  },
  async () => {
    webpush.setVapidDetails('mailto:reminders@nextset.app', VAPID_PUBLIC_KEY, vapidPrivateKey.value());
    await sendRemindersForWindow('events', 24, 'reminder24hSentAt');
    await sendRemindersForWindow('events', 12, 'reminder12hSentAt');
    await sendRemindersForWindow('padelEvents', 24, 'reminder24hSentAt');
    await sendRemindersForWindow('padelEvents', 12, 'reminder12hSentAt');
  },
);

// Fires the moment a new invite document is created. Only ever sends
// anything if the invited phone number already belongs to a registered
// user who has enabled reminders — someone who hasn't signed up yet has
// no uid and nothing to push to, and still finds the invite the normal
// way (the Invitations section, or a WhatsApp nudge) once they do.
exports.notifyOnInvite = onDocumentCreated(
  { document: 'invites/{inviteId}', secrets: [vapidPrivateKey] },
  async (snapshotEvent) => {
    const invite = snapshotEvent.data ? snapshotEvent.data.data() : null;
    if (!invite || !invite.invitedPhone || !invite.eventId) return;

    const userSnap = await db.collection('users').where('phone', '==', invite.invitedPhone).limit(1).get();
    if (userSnap.empty) return; // not registered yet — nothing to push to

    const inviteeUid = userSnap.docs[0].id;

    const eventSnap = await db.collection('events').doc(invite.eventId).get();
    if (!eventSnap.exists) return;
    const gameEvent = eventSnap.data();

    const inviterName = (gameEvent.participantNames && gameEvent.participantNames[invite.invitedBy]) || 'Someone';
    const where = [gameEvent.location, gameEvent.court].filter(Boolean).join(' · ');
    const body = `${inviterName} invited you — ${formatWhen(gameEvent.dateTime)}${where ? ' · ' + where : ''}`;
    const payload = JSON.stringify({ title: 'New game invite', body, url: './' });

    webpush.setVapidDetails('mailto:reminders@nextset.app', VAPID_PUBLIC_KEY, vapidPrivateKey.value());
    await pushToUser(inviteeUid, payload);
  },
);

// Fires whenever an invite document is updated — in practice that only
// ever means status moved from pending to accepted or declined, since
// that's the only update the security rules permit. Notifies whoever
// sent the invite, so a decline in particular doesn't sit unnoticed
// until they next happen to open the app.
exports.notifyOnInviteResponse = onDocumentUpdated(
  { document: 'invites/{inviteId}', secrets: [vapidPrivateKey] },
  async (updateEvent) => {
    const before = updateEvent.data && updateEvent.data.before ? updateEvent.data.before.data() : null;
    const after = updateEvent.data && updateEvent.data.after ? updateEvent.data.after.data() : null;
    if (!before || !after) return;
    if (before.status !== 'pending' || (after.status !== 'accepted' && after.status !== 'declined')) return;

    const inviterUid = after.invitedBy;
    if (!inviterUid) return;

    const label = after.invitedName || after.invitedPhone || 'Someone';
    const verb = after.status === 'accepted' ? 'accepted' : 'declined';
    let body = `${label} ${verb} your invite`;

    if (after.eventId) {
      const eventSnap = await db.collection('events').doc(after.eventId).get();
      if (eventSnap.exists) {
        const gameEvent = eventSnap.data();
        const where = [gameEvent.location, gameEvent.court].filter(Boolean).join(' · ');
        body += ` — ${formatWhen(gameEvent.dateTime)}${where ? ' · ' + where : ''}`;
      }
    }

    const payload = JSON.stringify({
      title: after.status === 'accepted' ? 'Invite accepted' : 'Invite declined',
      body,
      url: './',
    });

    webpush.setVapidDetails('mailto:reminders@nextset.app', VAPID_PUBLIC_KEY, vapidPrivateKey.value());
    await pushToUser(inviterUid, payload);
  },
);

/* ============================================================
   padelEvents — Events section: invite notifications
   Mirrors notifyOnInvite / notifyOnInviteResponse above exactly,
   just pointed at the nested padelEvents/{eventId}/padelInvites path
   instead of the top-level invites collection.
   ============================================================ */

exports.notifyOnPadelEventInvite = onDocumentCreated(
  { document: 'padelEvents/{eventId}/padelInvites/{invitedPhone}', secrets: [vapidPrivateKey] },
  async (snapshotEvent) => {
    const invite = snapshotEvent.data ? snapshotEvent.data.data() : null;
    if (!invite || !invite.invitedPhone) return;

    const userSnap = await db.collection('users').where('phone', '==', invite.invitedPhone).limit(1).get();
    if (userSnap.empty) return;

    const inviteeUid = userSnap.docs[0].id;
    const eventId = snapshotEvent.params.eventId;

    const eventSnap = await db.collection('padelEvents').doc(eventId).get();
    if (!eventSnap.exists) return;
    const padelEvent = eventSnap.data();

    const inviterName = (padelEvent.participantNames && padelEvent.participantNames[invite.invitedBy]) || 'Someone';
    const where = [padelEvent.location, padelEvent.courts].filter(Boolean).join(' · ');
    const body = `${inviterName} invited you — ${formatWhen(padelEvent.dateTime)}${where ? ' · ' + where : ''}`;
    const payload = JSON.stringify({ title: 'New event invite', body, url: './events.html' });

    webpush.setVapidDetails('mailto:reminders@nextset.app', VAPID_PUBLIC_KEY, vapidPrivateKey.value());
    await pushToUser(inviteeUid, payload);
  },
);

exports.notifyOnPadelEventInviteResponse = onDocumentUpdated(
  { document: 'padelEvents/{eventId}/padelInvites/{invitedPhone}', secrets: [vapidPrivateKey] },
  async (updateEvent) => {
    const before = updateEvent.data && updateEvent.data.before ? updateEvent.data.before.data() : null;
    const after = updateEvent.data && updateEvent.data.after ? updateEvent.data.after.data() : null;
    if (!before || !after) return;
    if (before.status !== 'pending' || (after.status !== 'accepted' && after.status !== 'declined')) return;

    const inviterUid = after.invitedBy;
    if (!inviterUid) return;

    const eventId = updateEvent.params.eventId;
    const label = after.invitedName || after.invitedPhone || 'Someone';
    const verb = after.status === 'accepted' ? 'accepted' : 'declined';
    let body = `${label} ${verb} your invite`;

    const eventSnap = await db.collection('padelEvents').doc(eventId).get();
    if (eventSnap.exists) {
      const padelEvent = eventSnap.data();
      const where = [padelEvent.location, padelEvent.courts].filter(Boolean).join(' · ');
      body += ` — ${formatWhen(padelEvent.dateTime)}${where ? ' · ' + where : ''}`;
    }

    const payload = JSON.stringify({
      title: after.status === 'accepted' ? 'Invite accepted' : 'Invite declined',
      body,
      url: './events.html',
    });

    webpush.setVapidDetails('mailto:reminders@nextset.app', VAPID_PUBLIC_KEY, vapidPrivateKey.value());
    await pushToUser(inviterUid, payload);
  },
);

/* ============================================================
   Americano pairing engine — ported directly from rally.html
   (functions shuffle, pairKey, buildHistory, computeActiveCount,
   chooseSitOuts, pairHistoryScore, groupConflictScore,
   groupIntoFoursomes, bestTeamSplit, toCourts,
   generateAmericanoRound, scheduleQualityScore,
   generateFullAmericanoSchedule). Non-mixed-mode only, since
   padelEvents participants don't currently carry a gender field —
   Rally's own mixed-mode branch is intentionally not ported here.
   Kept byte-for-byte faithful to the browser version on purpose:
   two different implementations of the same algorithm drifting
   apart over time is worse than one shared source duplicated with
   care. If Rally's version changes, this needs updating to match.
   ============================================================ */

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function buildHistory(players, rounds) {
  const partnerCount = {};
  const opponentCount = {};
  const gamesPlayed = {};
  const sitOutCount = {};
  players.forEach((p) => {
    gamesPlayed[p.id] = 0;
    sitOutCount[p.id] = 0;
  });

  rounds.forEach((round) => {
    round.courts.forEach((court) => {
      const [a1, a2] = court.teamA;
      const [b1, b2] = court.teamB;
      [a1, a2, b1, b2].forEach((id) => {
        gamesPlayed[id] = (gamesPlayed[id] || 0) + 1;
      });
      const pk1 = pairKey(a1, a2);
      partnerCount[pk1] = (partnerCount[pk1] || 0) + 1;
      const pk2 = pairKey(b1, b2);
      partnerCount[pk2] = (partnerCount[pk2] || 0) + 1;
      [a1, a2].forEach((x) =>
        [b1, b2].forEach((y) => {
          const ok = pairKey(x, y);
          opponentCount[ok] = (opponentCount[ok] || 0) + 1;
        })
      );
    });
    (round.sittingOut || []).forEach((id) => {
      sitOutCount[id] = (sitOutCount[id] || 0) + 1;
    });
  });

  return { partnerCount, opponentCount, gamesPlayed, sitOutCount };
}

function computeActiveCount(numPlayers, numCourts) {
  const maxSlots = numCourts * 4;
  return Math.floor(Math.min(numPlayers, maxSlots) / 4) * 4;
}

function chooseSitOuts(players, history, numSitOut) {
  if (numSitOut <= 0) return [];
  const sorted = [...players].sort((a, b) => {
    const soDiff = (history.sitOutCount[a.id] || 0) - (history.sitOutCount[b.id] || 0);
    if (soDiff !== 0) return soDiff;
    const gpDiff = (history.gamesPlayed[b.id] || 0) - (history.gamesPlayed[a.id] || 0);
    if (gpDiff !== 0) return gpDiff;
    return Math.random() - 0.5;
  });
  return sorted.slice(0, numSitOut);
}

function pairHistoryScore(idA, idB, history, partnerWeight, opponentWeight) {
  const pk = pairKey(idA, idB);
  return (history.partnerCount[pk] || 0) * partnerWeight + (history.opponentCount[pk] || 0) * opponentWeight;
}

function selectActiveForRound(players, numCourts, history) {
  const activeCount = computeActiveCount(players.length, numCourts);
  const numSitOut = players.length - activeCount;
  const sittingOut = chooseSitOuts(players, history, numSitOut);
  const sitOutIds = new Set(sittingOut.map((p) => p.id));
  return { active: players.filter((p) => !sitOutIds.has(p.id)), sittingOut };
}

function groupConflictScore(group, history) {
  let score = 0;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      score += pairHistoryScore(group[i].id, group[j].id, history, 2, 1);
    }
  }
  return score;
}

function groupIntoFoursomes(activePlayers, history, attempts = 80) {
  let best = null;
  let bestScore = Infinity;

  for (let a = 0; a < attempts; a++) {
    const pool = shuffle(activePlayers);
    const groups = [];
    while (pool.length > 0) {
      const group = [pool.shift()];
      while (group.length < 4 && pool.length > 0) {
        let bestIdx = 0;
        let bestConflict = Infinity;
        for (let i = 0; i < pool.length; i++) {
          let c = 0;
          for (const g of group) {
            c += pairHistoryScore(g.id, pool[i].id, history, 2, 1);
          }
          if (c < bestConflict) {
            bestConflict = c;
            bestIdx = i;
          }
        }
        group.push(pool.splice(bestIdx, 1)[0]);
      }
      groups.push(group);
    }
    const totalScore = groups.reduce((sum, g) => sum + groupConflictScore(g, history), 0);
    if (totalScore < bestScore) {
      bestScore = totalScore;
      best = groups;
    }
  }
  return best;
}

function bestTeamSplit(group, history) {
  const [w, x, y, z] = group;
  const splits = [
    { teamA: [w, x], teamB: [y, z] },
    { teamA: [w, y], teamB: [x, z] },
    { teamA: [w, z], teamB: [x, y] },
  ];

  const scored = splits.map((s) => {
    const partnerScore =
      pairHistoryScore(s.teamA[0].id, s.teamA[1].id, history, 1, 0) +
      pairHistoryScore(s.teamB[0].id, s.teamB[1].id, history, 1, 0);
    const opponentScore =
      pairHistoryScore(s.teamA[0].id, s.teamB[0].id, history, 0, 1) +
      pairHistoryScore(s.teamA[0].id, s.teamB[1].id, history, 0, 1) +
      pairHistoryScore(s.teamA[1].id, s.teamB[0].id, history, 0, 1) +
      pairHistoryScore(s.teamA[1].id, s.teamB[1].id, history, 0, 1);
    return { split: s, score: partnerScore * 5 + opponentScore };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored[0].split;
}

function toCourts(courtPairs) {
  return courtPairs.map((pair, idx) => ({
    court: idx + 1,
    teamA: pair[0].map((p) => p.id),
    teamB: pair[1].map((p) => p.id),
    scoreA: null,
    scoreB: null,
  }));
}

function generateAmericanoRound(players, numCourts, priorRounds) {
  const history = buildHistory(players, priorRounds);
  const { active, sittingOut } = selectActiveForRound(players, numCourts, history);
  const groups = groupIntoFoursomes(active, history);
  const courtPairs = groups.map((g) => {
    const split = bestTeamSplit(g, history);
    return [split.teamA, split.teamB];
  });
  return { courts: toCourts(courtPairs), sittingOut: sittingOut.map((p) => p.id) };
}

function scheduleQualityScore(players, rounds) {
  const history = buildHistory(players, rounds);
  let score = 0;
  Object.values(history.partnerCount).forEach((c) => {
    if (c > 1) score += (c - 1) * (c - 1) * 10;
  });
  Object.values(history.opponentCount).forEach((c) => {
    if (c > 1) score += (c - 1) * (c - 1);
  });
  const sitOuts = Object.values(history.sitOutCount);
  if (sitOuts.length) {
    score += (Math.max(...sitOuts) - Math.min(...sitOuts)) * 5;
  }
  return score;
}

function generateFullAmericanoSchedule(players, numCourts, numRounds, scheduleAttempts = 12) {
  let best = null;
  let bestScore = Infinity;
  for (let attempt = 0; attempt < scheduleAttempts; attempt++) {
    const rounds = [];
    for (let r = 0; r < numRounds; r++) {
      rounds.push(generateAmericanoRound(players, numCourts, rounds));
    }
    const score = scheduleQualityScore(players, rounds);
    if (score < bestScore) {
      bestScore = score;
      best = rounds;
    }
    if (bestScore === 0) break;
  }
  return best;
}

/* ============================================================
   The actual trigger: once every invited player has accepted (the
   event's participants array reaches its capacity), generate the
   Americano draw automatically and let everyone know it's ready.
   Runs exactly once per event, guarded by the drawGenerated flag —
   whichever device happens to trigger the last acceptance is the
   one that runs this, but the flag check keeps it idempotent even
   if Firestore ever redelivers the same update.
   ============================================================ */

exports.generateDrawOnFull = onDocumentUpdated(
  { document: 'padelEvents/{eventId}', secrets: [vapidPrivateKey] },
  async (updateEvent) => {
    const after = updateEvent.data && updateEvent.data.after ? updateEvent.data.after.data() : null;
    if (!after) return;
    if (after.drawGenerated) return;

    const participants = after.participants || [];
    const capacity = after.capacity || 0;
    if (!capacity || participants.length < capacity) return;

    const eventId = updateEvent.params.eventId;
    const eventRef = db.collection('padelEvents').doc(eventId);

    // Guards against two near-simultaneous triggers (e.g. a retried
    // delivery) both trying to generate the draw — only the first to
    // grab this transaction actually proceeds.
    const claimed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(eventRef);
      if (!snap.exists || snap.data().drawGenerated) return false;
      tx.update(eventRef, { drawGenerated: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) return;

    const players = participants.map((uid) => ({
      id: uid,
      name: (after.participantNames && after.participantNames[uid]) || 'Player',
      gender: '-',
    }));

    const numCourts = Math.max(1, Math.floor(capacity / 4));
    const numRounds = after.numRounds || 7;
    const rounds = generateFullAmericanoSchedule(players, numCourts, numRounds) || [];

    await eventRef.collection('tournament').doc('draw').set({
      format: 'americano',
      players,
      rounds,
      numCourts,
      pointsTarget: after.pointsTarget || 24,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    webpush.setVapidDetails('mailto:reminders@nextset.app', VAPID_PUBLIC_KEY, vapidPrivateKey.value());
    const where = [after.location, after.courts].filter(Boolean).join(' · ');
    const payload = JSON.stringify({
      title: 'Draw is ready!',
      body: `All ${capacity} players have joined — the Americano draw is set.${where ? ' ' + where : ''}`,
      url: './events.html',
    });
    for (const uid of participants) {
      await pushToUser(uid, payload);
    }
  },
);
