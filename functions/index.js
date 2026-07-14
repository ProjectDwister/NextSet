const { onSchedule } = require('firebase-functions/scheduler');
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
      let subsSnap;
      try {
        subsSnap = await db.collection('users').doc(uid).collection('pushSubscriptions').get();
      } catch (err) {
        logger.error('could not read subscriptions', { uid, error: err.message });
        continue;
      }

      for (const subDoc of subsSnap.docs) {
        const sub = subDoc.data();
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
        } catch (err) {
          logger.warn('push send failed', { uid, subId: subDoc.id, status: err.statusCode, message: err.message });
          // 404/410 means the subscription is dead — the browser
          // unsubscribed, the user cleared site data, etc. Clean it up
          // so we stop wasting sends on it.
          if (err.statusCode === 404 || err.statusCode === 410) {
            await subDoc.ref.delete().catch(() => {});
          }
        }
      }
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
