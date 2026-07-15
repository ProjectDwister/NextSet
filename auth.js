import { auth, db } from './firebase-config.js';
import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  onAuthStateChanged,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

let recaptchaVerifier = null;
let pendingConfirmation = null;

// Lazily created, reused across attempts within the same page load.
// If reCAPTCHA ever errors out on retry, the simplest fix is reloading
// the page rather than trying to reset it in place — that's why
// sign-out below does a full reload instead of resetting this by hand.
function ensureRecaptcha(containerId) {
  if (!recaptchaVerifier) {
    recaptchaVerifier = new RecaptchaVerifier(auth, containerId, { size: 'invisible' });
  }
  return recaptchaVerifier;
}

// phoneNumber must already be E.164, e.g. "+919876543210".
export async function sendCode(phoneNumber, recaptchaContainerId) {
  const verifier = ensureRecaptcha(recaptchaContainerId);
  pendingConfirmation = await signInWithPhoneNumber(auth, phoneNumber, verifier);
  return pendingConfirmation;
}

export async function verifyCode(code) {
  if (!pendingConfirmation) {
    throw new Error('No verification in progress — request a code first.');
  }
  const result = await pendingConfirmation.confirm(code);
  pendingConfirmation = null;
  return result.user;
}

// null means "signed in, but hasn't set a name yet" — first-time flow.
export async function getMyProfile(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

export async function createMyProfile(uid, phone, name) {
  await setDoc(doc(db, 'users', uid), {
    phone,
    name,
    createdAt: serverTimestamp(),
  });
}

// Phone number is deliberately not editable here — it's the identity
// the account is keyed by, and changing it would mean re-verifying via
// OTP, not a plain profile edit. Only name can change, which is also
// all the security rules permit (see firestore.rules).
export async function updateMyProfileName(uid, name) {
  await updateDoc(doc(db, 'users', uid), { name });
}

export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export function signOutUser() {
  pendingConfirmation = null;
  return signOut(auth);
}
