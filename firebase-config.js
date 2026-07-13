// Fill this in from: Firebase console > Project settings > General >
// "Your apps" > Web app > SDK setup and configuration.
//
// This object is NOT a secret. It's meant to sit in public page source —
// see the note in the chat about why this is different from the old
// Apps Script credential. The actual access control lives in
// firestore.rules, enforced by Google's servers on every request, not
// in keeping this config hidden.

// Pinned to 12.13.0 (current as of this writing). Bump the number in
// all three URLs together if you update later — check
// https://www.npmjs.com/package/firebase for the latest.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyBHmhKwONkRttbp8edtPe6LPK2GDmhdPXY",
  authDomain: "games-scheduler-aa101.firebaseapp.com",
  projectId: "games-scheduler-aa101",
  storageBucket: "games-scheduler-aa101.firebasestorage.app",
  messagingSenderId: "610492502692",
  appId: "1:610492502692:web:bed389be6695086b950c31",
  measurementId: "G-2BCS3JXD6D"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
