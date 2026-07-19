import { db } from './firebase-config.js';
import {
  collection,
  collectionGroup,
  addDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  runTransaction,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

const PADEL_EVENTS = 'padelEvents';

export function toTimestamp(dateStr, timeStr) {
  return Timestamp.fromDate(new Date(`${dateStr}T${timeStr}`));
}

export async function getPadelEvent(eventId) {
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createPadelEvent(fields, myUid, myName, iAmPlaying = true) {
  const ref = await addDoc(collection(db, PADEL_EVENTS), {
    createdBy: myUid,
    dateTime: fields.dateTime,
    durationMin: fields.durationMin,
    location: fields.location,
    courts: fields.courts || '',
    capacity: fields.capacity,
    tournamentFormat: fields.tournamentFormat || 'americano',
    numRounds: fields.numRounds,
    pointsTarget: fields.pointsTarget,
    notes: fields.notes || '',
    participants: iAmPlaying ? [myUid] : [],
    participantNames: { [myUid]: myName },
    organizers: [myUid],
    drawGenerated: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updatePadelEvent(eventId, fields) {
  return updateDoc(doc(db, PADEL_EVENTS, eventId), { ...fields, updatedAt: serverTimestamp() });
}

// Client-side deletes never cascade to subcollections — that's a
// Firestore-wide limitation, not specific to this app (only deleting
// through the console's own UI does that automatically). So this
// explicitly cleans up everything nested under the event first —
// every padelInvites and organizerInvites document, plus the
// tournament draw if one was ever generated — before deleting the
// event document itself. Leaving those orphaned wouldn't break
// anything visibly, but they'd sit there indefinitely otherwise.
// Organizer-only, but the actual deletion this performs only ever
// succeeds against the rules if the caller is the event's original
// creator — see the requestEventDeletion/cancelDeletionRequest pair
// below for what every other organizer actually gets instead.
export async function deletePadelEvent(eventId) {
  const [padelInvites, organizerInvites] = await Promise.all([
    getDocs(collection(db, PADEL_EVENTS, eventId, 'padelInvites')),
    getDocs(collection(db, PADEL_EVENTS, eventId, 'organizerInvites')),
  ]);
  const deletions = [
    ...padelInvites.docs.map((d) => deleteDoc(d.ref)),
    ...organizerInvites.docs.map((d) => deleteDoc(d.ref)),
    deleteDoc(doc(db, PADEL_EVENTS, eventId, 'tournament', 'draw')).catch(() => {}), // fine if it never existed
  ];
  await Promise.all(deletions);
  await deleteDoc(doc(db, PADEL_EVENTS, eventId));
}

// For any organizer who isn't the event's creator — deleting is a
// two-step approval, not a direct action, specifically to guard
// against accidental deletion by someone other than whoever's
// ultimately responsible for the event. This just records who asked;
// the actual delete only ever happens when the creator calls
// deletePadelEvent themself.
export async function requestEventDeletion(eventId, myUid, myName) {
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    deleteRequestedBy: myUid,
    deleteRequestedByName: myName || '',
    updatedAt: serverTimestamp(),
  });
}

// Clears a pending deletion request — used both by the creator
// declining it, and by whoever asked changing their mind.
export async function cancelDeletionRequest(eventId) {
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    deleteRequestedBy: null,
    deleteRequestedByName: null,
    updatedAt: serverTimestamp(),
  });
}

// Lets an organizer set how they're displayed specifically in the
// organizers list — separate from participantNames, which is their
// real name shown if they're also playing. Self-only in the UI (the
// form only ever edits your own), though the underlying rule doesn't
// technically restrict it beyond normal organizer trust — same as
// participantNames itself already works.
export async function setOrganizerAlias(eventId, myUid, alias) {
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  if (!snap.exists()) throw new Error('This event no longer exists.');
  const data = snap.data();
  const trimmed = (alias || '').trim();
  const nextAliases = { ...(data.organizerAliases || {}) };
  if (trimmed) {
    nextAliases[myUid] = trimmed;
  } else {
    delete nextAliases[myUid];
  }
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    organizerAliases: nextAliases,
    updatedAt: serverTimestamp(),
  });
}

// Add or remove an organizer. The 4-organizer cap is enforced by the
// security rules regardless — this just gives a clear error up front
// instead of letting the write round-trip and fail.
export async function addOrganizer(eventId, uid, name) {
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  if (!snap.exists()) throw new Error('This event no longer exists.');
  const data = snap.data();
  const organizers = data.organizers || [];
  if (organizers.includes(uid)) return;
  if (organizers.length >= 4) throw new Error('An event can have at most 4 organizers.');
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    organizers: [...organizers, uid],
    participantNames: { ...(data.participantNames || {}), [uid]: name || data.participantNames?.[uid] || '' },
    updatedAt: serverTimestamp(),
  });
}

export async function removeOrganizer(eventId, uid) {
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  if (!snap.exists()) throw new Error('This event no longer exists.');
  const data = snap.data();
  if (uid === data.createdBy) {
    throw new Error("The event's original organizer can't be removed by anyone else.");
  }
  const organizers = (data.organizers || []).filter((id) => id !== uid);
  if (organizers.length === 0) throw new Error('An event needs at least one organizer.');
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    organizers,
    updatedAt: serverTimestamp(),
  });
}

// Lets someone remove themself from the player list — typically the
// organizer, after realizing they created the event but aren't
// actually going to play. Deliberately self-only in what it's used
// for here, even though the underlying update rule (any organizer can
// change anything) would technically permit removing someone else too
// — that's an existing, broader permission this function just doesn't
// exercise, not a new restriction being added.
export async function removeSelfFromParticipants(eventId, myUid) {
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  if (!snap.exists()) throw new Error('This event no longer exists.');
  const participants = (snap.data().participants || []).filter((id) => id !== myUid);
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    participants,
    updatedAt: serverTimestamp(),
  });
}

// The organizer-facing counterpart — removes any given player, not
// just yourself. Security rules already permit this (any organizer
// can change participants freely); this just exposes it as its own
// explicit action rather than only ever being used for self-removal.
export async function removeParticipant(eventId, targetUid) {
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  if (!snap.exists()) throw new Error('This event no longer exists.');
  const participants = (snap.data().participants || []).filter((id) => id !== targetUid);
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    participants,
    updatedAt: serverTimestamp(),
  });
}

// Adds someone directly, bypassing invite/accept entirely — for
// players who confirmed offline (courtside, over a phone call) and
// may never actually open the app. Given a synthetic id rather than
// a real uid, since there's no account to link to; the draw-generation
// engine doesn't care whether an id is a real Firebase uid or not, it
// just needs a unique identifier per player, so this needs no changes
// anywhere else. Organizer-only — enforced by the same broad update
// rule that already governs every other participants-array change.
export async function addGuestPlayer(eventId, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('Enter a name.');
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  if (!snap.exists()) throw new Error('This event no longer exists.');
  const data = snap.data();
  const participants = data.participants || [];
  if (participants.length >= data.capacity) throw new Error('This event is already full.');
  const guestId = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    participants: [...participants, guestId],
    participantNames: { ...(data.participantNames || {}), [guestId]: trimmed },
    updatedAt: serverTimestamp(),
  });
  return guestId;
}

// Corrects a player's display name within this event — useful for
// guest players especially, since they have no account of their own
// to fix a typo with. Organizer-only in the UI; the rules already
// permit any organizer to change participantNames freely.
export async function editParticipantName(eventId, targetId, newName) {
  const trimmed = (newName || '').trim();
  if (!trimmed) throw new Error('Enter a name.');
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  if (!snap.exists()) throw new Error('This event no longer exists.');
  const data = snap.data();
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    participantNames: { ...(data.participantNames || {}), [targetId]: trimmed },
    updatedAt: serverTimestamp(),
  });
}

// Real-time list of every padelEvent the current user can act on —
// either as a participant (playing) or an organizer (managing, whether
// or not they're playing). These are two different fields, and
// Firestore can't OR across two different array-contains filters in a
// single query, so this runs two listeners and merges the results,
// de-duplicating by event id (an organizer who's also playing would
// otherwise show up from both).
export function watchMyPadelEvents(myUid, onChange, onError) {
  let asParticipant = [];
  let asOrganizer = [];
  let gotParticipant = false;
  let gotOrganizer = false;

  function emit() {
    if (!gotParticipant || !gotOrganizer) return; // wait for both, avoid a flash of a partial list
    const merged = new Map();
    [...asParticipant, ...asOrganizer].forEach((ev) => merged.set(ev.id, ev));
    onChange(Array.from(merged.values()));
  }

  const unsub1 = onSnapshot(
    query(collection(db, PADEL_EVENTS), where('participants', 'array-contains', myUid)),
    (snap) => {
      asParticipant = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      gotParticipant = true;
      emit();
    },
    onError,
  );
  const unsub2 = onSnapshot(
    query(collection(db, PADEL_EVENTS), where('organizers', 'array-contains', myUid)),
    (snap) => {
      asOrganizer = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      gotOrganizer = true;
      emit();
    },
    onError,
  );
  return () => { unsub1(); unsub2(); };
}

// Unfiltered query across every event — only ever succeeds for an
// actual admin. The client has no way to check "am I an admin" ahead
// of time (the admins collection is deliberately allow read,write: if
// false, unreachable from any client), so this is attempted
// unconditionally and simply fails silently for everyone else, same
// as attempting any action you don't have permission for. Permitted
// by the rules specifically because isAdmin() doesn't depend on
// resource.data at all — it's true or false purely based on the
// caller, which Firestore can verify holds for every possible
// document a query like this could return, without needing a
// matching where() clause the way data-dependent rules do.
export function watchAllPadelEventsForAdmin(onChange, onError) {
  return onSnapshot(
    collection(db, PADEL_EVENTS),
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  );
}

export async function sendPadelEventInvite(eventId, invitedPhone, invitedName, myUid) {
  await setDoc(doc(db, PADEL_EVENTS, eventId, 'padelInvites', invitedPhone), {
    invitedBy: myUid,
    invitedPhone,
    invitedName: invitedName || '',
    status: 'pending',
    createdAt: serverTimestamp(),
  });
}

// Collection-group query — finds pending invites addressed to this
// phone number across every event at once, without needing to already
// know which event ids to look under. First run will likely prompt
// Firestore for a composite index (collection-group scope, invitedPhone
// + status) — same as every other new query pattern in this app,
// click the link in the console and wait for it to build.
export function watchMyPadelEventInvites(myPhone, onChange, onError) {
  const q = query(
    collectionGroup(db, 'padelInvites'),
    where('invitedPhone', '==', myPhone),
    where('status', '==', 'pending'),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({
      id: d.id,
      eventId: d.ref.parent.parent.id,
      ...d.data(),
    }))),
    onError,
  );
}

export async function declinePadelEventInvite(eventId, invitedPhone) {
  await updateDoc(doc(db, PADEL_EVENTS, eventId, 'padelInvites', invitedPhone), {
    status: 'declined',
    respondedAt: serverTimestamp(),
  });
}

// Same two-step, same reasoning as invites.js's acceptInvite: the
// event-side update rule only allows adding yourself once your invite
// already shows as accepted, which only holds after step 1 has
// actually committed. Wrapped in its own transaction so two people
// accepting invites to the same event seconds apart can't silently
// overwrite each other's participants-array update.
export async function acceptPadelEventInvite(eventId, invitedPhone, myUid, myName) {
  await updateDoc(doc(db, PADEL_EVENTS, eventId, 'padelInvites', invitedPhone), {
    status: 'accepted',
    respondedAt: serverTimestamp(),
  });

  const eventRef = doc(db, PADEL_EVENTS, eventId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) {
      throw new Error('This event no longer exists — it may have been deleted.');
    }
    const data = snap.data();
    const participants = data.participants || [];
    if (participants.includes(myUid)) return; // already joined, nothing to do
    tx.update(eventRef, {
      participants: [...participants, myUid],
      participantNames: { ...(data.participantNames || {}), [myUid]: myName },
      updatedAt: serverTimestamp(),
    });
  });
}

// Live status of every player invite sent for this event — pending,
// accepted, or declined. Unlike watchMyPadelEventInvites, this is a
// plain subcollection read scoped to one known event, not a
// collection-group query across all events, so it needs no extra
// index. Shows invites sent by any organizer, not just the current
// viewer — with multiple organizers able to send invites, seeing the
// full picture matters more than only your own.
export function watchSentPadelInvites(eventId, onChange, onError) {
  return onSnapshot(
    collection(db, PADEL_EVENTS, eventId, 'padelInvites'),
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  );
}

export function watchSentOrganizerInvites(eventId, onChange, onError) {
  return onSnapshot(
    collection(db, PADEL_EVENTS, eventId, 'organizerInvites'),
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  );
}

// Live view of the generated draw, once one exists. Null until the
// Cloud Function creates it (participants.length reaching capacity).
// Organizer-only. Resets the same flag generateDrawOnFull already
// watches for — participants.length >= capacity && !drawGenerated —
// so simply flipping this back to false re-fires the exact same
// Cloud Function trigger that made the draw the first time, rather
// than needing a second, separate generation path to build and keep
// in sync with the first. Deliberately does NOT touch participants —
// regenerating is for "someone dropped out, redo the pairings for
// who's actually here now," not a way to also remove players; that
// stays a separate, explicit action. Guarded against being called
// while under capacity — the Cloud Function's own guard would
// otherwise silently do nothing in that case, leaving drawGenerated
// false with no new draw actually generated, an inconsistent state
// worth preventing here rather than discovering later.
export async function regenerateDraw(eventId) {
  const snap = await getDoc(doc(db, PADEL_EVENTS, eventId));
  if (!snap.exists()) throw new Error('This event no longer exists.');
  const data = snap.data();
  if ((data.participants || []).length < data.capacity) {
    throw new Error('Not enough players right now — add someone to fill the spot before regenerating.');
  }
  await updateDoc(doc(db, PADEL_EVENTS, eventId), {
    drawGenerated: false,
    updatedAt: serverTimestamp(),
  });
}

export function watchPadelTournament(eventId, onChange, onError) {
  return onSnapshot(
    doc(db, PADEL_EVENTS, eventId, 'tournament', 'draw'),
    (snap) => onChange(snap.exists() ? snap.data() : null),
    onError,
  );
}

// The complete, all-rounds-upfront schedule — only ever succeeds for
// an organizer; the rules deny this read outright for anyone else,
// not just hide it in the UI. Callers should treat a permission error
// here as the expected, normal case for a non-organizer, not a bug.
export function watchPadelFullDraw(eventId, onChange, onError) {
  return onSnapshot(
    doc(db, PADEL_EVENTS, eventId, 'tournament', 'fullDraw'),
    (snap) => onChange(snap.exists() ? snap.data() : null),
    onError,
  );
}

/* ============================================================
   Organizer invites — deliberately separate from padelInvites
   above, not a role field on the same collection. Someone can be
   pending as an invited player and an invited organizer for the
   same event at once; sharing one collection keyed by phone
   number wouldn't allow that. See firestore.rules for the same
   reasoning on the rules side.
   ============================================================ */

export async function sendOrganizerInvite(eventId, invitedPhone, invitedName, myUid) {
  await setDoc(doc(db, PADEL_EVENTS, eventId, 'organizerInvites', invitedPhone), {
    invitedBy: myUid,
    invitedPhone,
    invitedName: invitedName || '',
    status: 'pending',
    createdAt: serverTimestamp(),
  });
}

export function watchMyOrganizerInvites(myPhone, onChange, onError) {
  const q = query(
    collectionGroup(db, 'organizerInvites'),
    where('invitedPhone', '==', myPhone),
    where('status', '==', 'pending'),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({
      id: d.id,
      eventId: d.ref.parent.parent.id,
      ...d.data(),
    }))),
    onError,
  );
}

export async function declineOrganizerInvite(eventId, invitedPhone) {
  await updateDoc(doc(db, PADEL_EVENTS, eventId, 'organizerInvites', invitedPhone), {
    status: 'declined',
    respondedAt: serverTimestamp(),
  });
}

// Same two-step shape as acceptPadelEventInvite, adds to organizers
// instead of participants — accepting an organizer invite does NOT
// also make you a participant; those stay two independent things,
// exactly as requested.
export async function acceptOrganizerInvite(eventId, invitedPhone, myUid, myName) {
  await updateDoc(doc(db, PADEL_EVENTS, eventId, 'organizerInvites', invitedPhone), {
    status: 'accepted',
    respondedAt: serverTimestamp(),
  });

  const eventRef = doc(db, PADEL_EVENTS, eventId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) {
      throw new Error('This event no longer exists — it may have been deleted.');
    }
    const data = snap.data();
    const organizers = data.organizers || [];
    if (organizers.includes(myUid)) return; // already an organizer, nothing to do
    if (organizers.length >= 4) {
      throw new Error('This event already has the maximum of 4 organizers.');
    }
    tx.update(eventRef, {
      organizers: [...organizers, myUid],
      participantNames: { ...(data.participantNames || {}), [myUid]: myName },
      updatedAt: serverTimestamp(),
    });
  });
}

// Same transaction-based approach as Rally's own syncScoreFieldToFirestore
// (see rally.html) — concurrent score entry on different courts is the
// one thing multiple courtside phones are likely to actually collide
// on, and a read-modify-write transaction is what makes that safe.
// Matches by court number (not array index), same reasoning as Rally's
// version. Debounced 150ms per field so rapid +/- taps don't each
// trigger their own transaction.
const scoreSyncTimers = {};
export function syncPadelScoreField(eventId, roundIdx, courtNumber, field, value) {
  const key = `${eventId}:${roundIdx}:${courtNumber}:${field}`;
  if (scoreSyncTimers[key]) clearTimeout(scoreSyncTimers[key]);
  scoreSyncTimers[key] = setTimeout(async () => {
    try {
      const ref = doc(db, PADEL_EVENTS, eventId, 'tournament', 'draw');
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const data = snap.data();
        const rounds = (data.rounds || []).map((r, ri) => {
          if (ri !== roundIdx) return r;
          return {
            ...r,
            courts: (r.courts || []).map((c) => (c.court !== courtNumber ? c : { ...c, [field]: value })),
          };
        });
        tx.update(ref, { rounds, updatedAt: serverTimestamp() });
      });
    } catch (e) {
      // Non-fatal — local state (via the reducer/UI) already reflects
      // the change either way; the next edit's debounced write, or a
      // future one, reconciles it.
    }
  }, 150);
}

// One Confirm per round now, not one per court — this writes every
// court's scores in that round together, atomically. Immediately
// satisfies the Cloud Function's "is this round fully scored" check,
// which is what actually reveals the next round to everyone else —
// no separate step needed for that part.
export async function confirmRoundScores(eventId, roundIdx, courtScores) {
  const ref = doc(db, PADEL_EVENTS, eventId, 'tournament', 'draw');
  const byCourt = new Map(courtScores.map((c) => [c.court, c]));
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    const rounds = (data.rounds || []).map((r, ri) => {
      if (ri !== roundIdx) return r;
      return {
        ...r,
        courts: (r.courts || []).map((c) => {
          const s = byCourt.get(c.court);
          return s ? { ...c, scoreA: s.scoreA, scoreB: s.scoreB, confirmed: true } : c;
        }),
      };
    });
    tx.update(ref, { rounds, updatedAt: serverTimestamp() });
  });
}

// Reopens every court in the round for editing at once — flips
// confirmed back to false immediately, so anyone else looking at it
// live sees accurately that it's being changed. Scores themselves are
// untouched until the next confirmRoundScores call.
export async function unconfirmRoundScores(eventId, roundIdx) {
  const ref = doc(db, PADEL_EVENTS, eventId, 'tournament', 'draw');
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    const rounds = (data.rounds || []).map((r, ri) => {
      if (ri !== roundIdx) return r;
      return { ...r, courts: (r.courts || []).map((c) => ({ ...c, confirmed: false })) };
    });
    tx.update(ref, { rounds, updatedAt: serverTimestamp() });
  });
}

