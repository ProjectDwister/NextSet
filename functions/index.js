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

// Shared by both functions below: sends one payload to every device a
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
async function sendRemindersForWindow(hoursAhead, sentField) {
  const nowMs = Date.now();
  const windowStart = admin.firestore.Timestamp.fromMillis(nowMs + hoursAhead * 3600000 - 16 * 60000);
  const windowEnd = admin.firestore.Timestamp.fromMillis(nowMs + hoursAhead * 3600000);

  const snap = await db.collection('events')
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
    const where = [event.location, event.court].filter(Boolean).join(' · ');
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
    await sendRemindersForWindow(24, 'reminder24hSentAt');
    await sendRemindersForWindow(12, 'reminder12hSentAt');
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
