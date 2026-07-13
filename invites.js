import { db } from './firebase-config.js';
import {
  doc,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  onSnapshot,
  serverTimestamp,
  runTransaction,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

const INVITES = 'invites';

// One-time fetch of invites the current user has sent (any status) —
// used to build a "invited before" quick-pick list. Deliberately no
// orderBy here to avoid needing another composite index: this dataset
// is small (one person's own invite history), so sorting/deduping by
// most-recent happens client-side instead.
export async function getSentInvites(myUid) {
  const q = query(collection(db, INVITES), where('invitedBy', '==', myUid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data());
}

// Deterministic id: "{eventId}_{invitedPhone}" — see DATA_MODEL.md. This
// is also why re-inviting the same phone number to the same event, once
// an invite already exists there in any status, gets rejected by the
// rules rather than silently resetting it back to pending: setDoc on an
// existing id is evaluated as an *update*, and only the invitee can
// update their own invite.
function inviteId(eventId, invitedPhone) {
  return `${eventId}_${invitedPhone}`;
}

export async function sendInvite(eventId, invitedPhone, invitedName, myUid) {
  const id = inviteId(eventId, invitedPhone);
  await setDoc(doc(db, INVITES, id), {
    eventId,
    invitedBy: myUid,
    invitedPhone,
    invitedName: invitedName || '',
    status: 'pending',
    createdAt: serverTimestamp(),
  });
}

// Pending invites addressed to the current user's own verified phone
// number. Two plain equality filters — shouldn't need a composite index,
// but if Firestore asks for one anyway, same fix as before: click the
// link in the console.
export function watchMyInvites(myPhone, onChange, onError) {
  const q = query(
    collection(db, INVITES),
    where('invitedPhone', '==', myPhone),
    where('status', '==', 'pending'),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError,
  );
}

export async function declineInvite(inviteId) {
  await updateDoc(doc(db, INVITES, inviteId), {
    status: 'declined',
    respondedAt: serverTimestamp(),
  });
}

// Two separate writes, deliberately not one transaction spanning both
// documents — the events-update rule checks that this invite is
// *already* accepted, which only holds once step 1 has actually
// committed. The event-side write is wrapped in its own transaction so
// two people accepting invites to the same game seconds apart can't
// silently overwrite each other's participants-array update.
export async function acceptInvite(invite, myUid, myName) {
  await updateDoc(doc(db, INVITES, invite.id), {
    status: 'accepted',
    respondedAt: serverTimestamp(),
  });

  const eventRef = doc(db, 'events', invite.eventId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(eventRef);
    if (!snap.exists()) {
      throw new Error('This game no longer exists — it may have been deleted.');
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
