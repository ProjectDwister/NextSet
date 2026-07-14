import { db } from './firebase-config.js';
import {
  doc,
  setDoc,
  deleteDoc,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

// This is the VAPID *public* key only — safe to ship in client code, by
// design (it's how the push service verifies messages came from this
// app's server, not a secret the client needs to protect). The matching
// private key lives only in the Cloud Function's secret config, never
// here and never in the repo.
const VAPID_PUBLIC_KEY = 'BP9fO4d2D_BnrD14un6lAQIeuCFyIMX9zRvDNj_XAvGM72cBZE6TAaZgf3YaCRLTQuicljNHbt4OAneqJbmUBNw';

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function notificationPermission() {
  return pushSupported() ? Notification.permission : 'unsupported';
}

export async function enableReminders(uid) {
  if (!pushSupported()) {
    throw new Error("This browser doesn't support notifications.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.');
  }

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const json = subscription.toJSON();
  const subId = await sha256Hex(json.endpoint);
  await setDoc(doc(db, 'users', uid, 'pushSubscriptions', subId), {
    endpoint: json.endpoint,
    keys: json.keys,
    createdAt: serverTimestamp(),
  });
}

export async function disableReminders(uid) {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const json = subscription.toJSON();
  const subId = await sha256Hex(json.endpoint);
  await deleteDoc(doc(db, 'users', uid, 'pushSubscriptions', subId)).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}
