import { db } from './firebase-config.js';
import {
  collection,
  addDoc,
  doc,
  getDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

const EVENTS = 'events';

// One-time fetch of a single event by id — used to preview a game
// someone's been invited to but hasn't joined (and so isn't covered by
// watchMyEvents' participants filter yet). Allowed by the rules' "has
// any invite" clause, not just for confirmed participants.
export async function getEvent(eventId) {
  const snap = await getDoc(doc(db, EVENTS, eventId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function toTimestamp(dateStr, timeStr) {
  return Timestamp.fromDate(new Date(`${dateStr}T${timeStr}`));
}

export async function createEvent(fields, myUid, myName) {
  return addDoc(collection(db, EVENTS), {
    createdBy: myUid,
    dateTime: fields.dateTime,
    durationMin: fields.durationMin,
    location: fields.location,
    court: fields.court,
    format: fields.format || '',
    notes: fields.notes || '',
    participants: [myUid],
    participantNames: { [myUid]: myName },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateEvent(eventId, fields) {
  return updateDoc(doc(db, EVENTS, eventId), { ...fields, updatedAt: serverTimestamp() });
}

export async function deleteEvent(eventId) {
  return deleteDoc(doc(db, EVENTS, eventId));
}

// Real-time list of every event the current user is part of. Deliberately
// a single-field composite (participants + dateTime) — the simplest index
// Firestore needs. Splitting into upcoming/past happens client-side, in
// splitUpcoming below, rather than adding a second filter to this query.
//
// First time this runs, Firestore will likely reject it with
// 'failed-precondition' and a direct link to auto-create the required
// index — that's expected on a brand new project, not a bug. Click the
// link, wait a minute or two for the index to finish building, reload.
export function watchMyEvents(myUid, onChange, onError) {
  const q = query(
    collection(db, EVENTS),
    where('participants', 'array-contains', myUid),
    orderBy('dateTime', 'asc'),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  );
}

export function splitUpcoming(events) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const upcoming = [];
  const past = [];
  for (const ev of events) {
    const when = ev.dateTime && ev.dateTime.toDate ? ev.dateTime.toDate() : new Date(ev.dateTime);
    (when >= startOfToday ? upcoming : past).push(ev);
  }
  // Query already returns ascending order; the past half reads better
  // most-recent-first, so just that half gets reversed.
  return { upcoming, past: past.reverse() };
}
