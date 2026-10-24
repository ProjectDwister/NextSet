import { auth, db } from './firebase-config.js';
import { getMyProfile } from './auth.js';
import {
  sendOrganizerInvite,
  watchSentOrganizerInvites,
  watchMyOrganizerInvites,
  acceptOrganizerInvite,
  syncPadelScoreField,
} from './padelEvents.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js';
import {
  collection,
  addDoc,
  doc,
  getDocs,
  query,
  where,
  updateDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

const FORMAT = 'bonus-centre-court-mixed-americano';
const MARKER = 'Bonus Rounds at Centre Court';
const FEMALES = ['Shruti', 'Ritika', 'Arunima', 'Rashida', 'Tunali', 'Shweta'];
const MALES = ['Nishank', 'Nikhil', 'Santosh', 'Mayur', 'Raj', 'Yashraj'];
const SCOREKEEPERS = ['Neetul', 'Arunima'];

// Exact same draw as the Glass Court event.
const TEMPLATE = [
  [
    [1, ['Nishank', 'Shruti'], ['Mayur', 'Rashida']],
    [2, ['Nikhil', 'Ritika'], ['Raj', 'Tunali']],
    [3, ['Santosh', 'Arunima'], ['Yashraj', 'Shweta']],
  ],
  [
    [1, ['Nishank', 'Arunima'], ['Santosh', 'Tunali']],
    [2, ['Mayur', 'Shweta'], ['Raj', 'Rashida']],
    [3, ['Nikhil', 'Shruti'], ['Yashraj', 'Ritika']],
  ],
  [
    [1, ['Raj', 'Shweta'], ['Yashraj', 'Tunali']],
    [2, ['Nishank', 'Rashida'], ['Nikhil', 'Arunima']],
    [3, ['Santosh', 'Ritika'], ['Mayur', 'Shruti']],
  ],
  [
    [1, ['Nikhil', 'Rashida'], ['Santosh', 'Shweta']],
    [2, ['Mayur', 'Ritika'], ['Yashraj', 'Arunima']],
    [3, ['Nishank', 'Tunali'], ['Raj', 'Shruti']],
  ],
  [
    [1, ['Nikhil', 'Tunali'], ['Mayur', 'Arunima']],
    [2, ['Nishank', 'Shweta'], ['Yashraj', 'Shruti']],
    [3, ['Santosh', 'Rashida'], ['Raj', 'Ritika']],
  ],
  [
    [1, ['Nishank', 'Ritika'], ['Nikhil', 'Shweta']],
    [2, ['Santosh', 'Shruti'], ['Raj', 'Arunima']],
    [3, ['Mayur', 'Tunali'], ['Yashraj', 'Rashida']],
  ],
];

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let eventId = params.get('event') || '';
let user = null;
let profile = null;
let eventData = null;
let drawData = null;
let isOrganizer = false;
let pendingOrganizerInvite = null;
let eventUnsub = null;
let drawUnsub = null;
let sentInviteUnsub = null;
let myInviteUnsub = null;
const expanded = new Set([0]);

const idFor = (name, gender) =>
  `bonus_${gender.toLowerCase()}_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

const PLAYERS = [
  ...FEMALES.map((name) => ({ id: idFor(name, 'F'), name, gender: 'F' })),
  ...MALES.map((name) => ({ id: idFor(name, 'M'), name, gender: 'M' })),
];
const ID_BY_NAME = new Map(PLAYERS.map((player) => [player.name, player.id]));
const ROUNDS = TEMPLATE.map((matches) => ({
  courts: matches.map(([court, teamA, teamB]) => ({
    court,
    teamA: teamA.map((name) => ID_BY_NAME.get(name)),
    teamB: teamB.map((name) => ID_BY_NAME.get(name)),
    scoreA: null,
    scoreB: null,
  })),
  sittingOut: [],
}));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[char]));
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase();
}

function playerName(id) {
  return (drawData?.players || PLAYERS).find((player) => player.id === id)?.name || id;
}

function showError(message) {
  el('loading').classList.add('hidden');
  el('error').classList.remove('hidden');
  el('error').innerHTML = `<h2>Could not open event</h2><div class="sub">${escapeHtml(message)}</div>`;
}

function toast(message) {
  el('toast').textContent = message;
  el('toast').classList.remove('hidden');
  setTimeout(() => el('toast').classList.add('hidden'), 1800);
}

function redirectToLogin() {
  const target = location.pathname.split('/').pop() + location.search;
  const url = new URL('index.html', location.href);
  url.searchParams.set('nav', '1');
  url.searchParams.set('returnTo', target);
  location.replace(url.toString());
}

function formatWhen(event) {
  const value = event?.dateTime?.toDate ? event.dateTime.toDate() : new Date(event?.dateTime);
  if (!value || Number.isNaN(value.getTime())) return '';
  const end = new Date(value.getTime() + Number(event.durationMin || 0) * 60000);
  const date = value.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const start = value.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const finish = end.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${start}–${finish}`;
}

function roundComplete(round) {
  return (round?.courts || []).every((court) => court.scoreA != null && court.scoreB != null);
}

function teamHtml(ids) {
  return `<div class="names">${ids.map((id) => `<div>${escapeHtml(playerName(id))}</div>`).join('')}</div>`;
}

function scoreHtml(roundIndex, court, field, value) {
  if (!isOrganizer) return `<div class="score-read">${value == null ? '-' : escapeHtml(value)}</div>`;
  return `<input class="score" inputmode="numeric" maxlength="3" value="${value == null ? '' : escapeHtml(value)}" placeholder="-" data-score data-round="${roundIndex}" data-court="${court.court}" data-field="${field}">`;
}

function computeStandings() {
  const rows = Object.fromEntries((drawData?.players || PLAYERS).map((player) => [player.id, {
    name: player.name, played: 0, points: 0, against: 0, wins: 0,
  }]));
  (drawData?.rounds || []).forEach((round) => {
    (round.courts || []).forEach((court) => {
      if (court.scoreA == null || court.scoreB == null) return;
      const scoreA = Number(court.scoreA);
      const scoreB = Number(court.scoreB);
      court.teamA.forEach((id) => {
        if (!rows[id]) return;
        rows[id].played += 1; rows[id].points += scoreA; rows[id].against += scoreB;
        if (scoreA > scoreB) rows[id].wins += 1;
      });
      court.teamB.forEach((id) => {
        if (!rows[id]) return;
        rows[id].played += 1; rows[id].points += scoreB; rows[id].against += scoreA;
        if (scoreB > scoreA) rows[id].wins += 1;
      });
    });
  });
  return Object.values(rows)
    .map((row) => ({ ...row, diff: row.points - row.against }))
    .sort((a, b) => b.points - a.points || b.diff - a.diff || b.wins - a.wins || a.name.localeCompare(b.name));
}

function renderStandings() {
  el('standingsBody').innerHTML = computeStandings().map((row, index) => `
    <tr><td class="rank">${index + 1}</td><td>${escapeHtml(row.name)}</td><td>${row.played}</td><td class="points">${row.points}</td><td>${row.against}</td><td>${row.diff > 0 ? '+' : ''}${row.diff}</td><td>${row.wins}</td></tr>
  `).join('');
}

async function maybeRevealNext() {
  if (!isOrganizer || !drawData) return;
  const revealed = Math.max(1, Number(drawData.revealedCount || 1));
  if (revealed >= ROUNDS.length || !roundComplete(drawData.rounds[revealed - 1])) return;
  try {
    await updateDoc(doc(db, 'padelEvents', eventId, 'tournament', 'draw'), {
      revealedCount: revealed + 1,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    console.error('Could not reveal next round', error);
  }
}

function renderRounds() {
  if (!drawData) return;
  const revealedCount = Math.min(drawData.rounds.length, Math.max(1, Number(drawData.revealedCount || 1)));
  el('rounds').innerHTML = drawData.rounds.slice(0, revealedCount).map((round, roundIndex) => {
    const open = expanded.has(roundIndex) || roundIndex === revealedCount - 1;
    const courts = round.courts.map((court) => `
      <div class="court"><div class="court-label">COURT #${court.court}</div>
      <div class="team">${teamHtml(court.teamA)}${scoreHtml(roundIndex, court, 'scoreA', court.scoreA)}</div>
      <div class="team">${teamHtml(court.teamB)}${scoreHtml(roundIndex, court, 'scoreB', court.scoreB)}</div></div>`).join('');
    const note = roundComplete(round) ? (roundIndex < 5 ? 'Round complete — next round reveals automatically.' : 'Round complete.') : 'Enter both team scores on all three courts.';
    const hasScores = round.courts.some((court) => court.scoreA != null || court.scoreB != null);
    return `<section class="card round"><button class="round-head" data-toggle="${roundIndex}" type="button"><span>Round ${roundIndex + 1} of 6</span><span>${open ? '▲' : '▼'}</span></button><div class="round-body ${open ? '' : 'hidden'}"><div class="court-grid">${courts}</div><div class="round-note">${escapeHtml(note)}</div>${isOrganizer && hasScores ? `<button class="btn danger" data-clear="${roundIndex}" type="button" style="margin-top:10px">Clear round scores</button>` : ''}</div></section>`;
  }).join('');

  document.querySelectorAll('[data-toggle]').forEach((button) => button.addEventListener('click', () => {
    const roundIndex = Number(button.dataset.toggle);
    if (expanded.has(roundIndex)) expanded.delete(roundIndex); else expanded.add(roundIndex);
    renderRounds();
  }));
  document.querySelectorAll('[data-score]').forEach((input) => input.addEventListener('input', () => {
    const roundIndex = Number(input.dataset.round);
    const courtNumber = Number(input.dataset.court);
    const field = input.dataset.field;
    const digits = input.value.replace(/\D/g, '').slice(0, 3);
    input.value = digits;
    const value = digits === '' ? null : Number(digits);
    const court = drawData.rounds[roundIndex].courts.find((item) => Number(item.court) === courtNumber);
    if (!court) return;
    court[field] = value;
    syncPadelScoreField(eventId, roundIndex, courtNumber, field, value);
    renderStandings();
    setTimeout(maybeRevealNext, 300);
  }));
  document.querySelectorAll('[data-clear]').forEach((button) => button.addEventListener('click', () => {
    const roundIndex = Number(button.dataset.clear);
    if (!confirm(`Clear all scores in Round ${roundIndex + 1}?`)) return;
    drawData.rounds[roundIndex].courts.forEach((court) => {
      court.scoreA = null; court.scoreB = null;
      syncPadelScoreField(eventId, roundIndex, Number(court.court), 'scoreA', null);
      syncPadelScoreField(eventId, roundIndex, Number(court.court), 'scoreB', null);
    });
    renderRounds(); renderStandings();
  }));
}

function auditDraw() {
  const partnershipCounts = new Map();
  const opponentCounts = new Map();
  const gameCounts = new Map(PLAYERS.map((player) => [player.name, 0]));
  const pairKey = (a, b) => [a, b].sort().join('|');
  TEMPLATE.forEach((round) => round.forEach(([, teamA, teamB]) => {
    [teamA, teamB].forEach((team) => {
      const key = pairKey(team[0], team[1]);
      partnershipCounts.set(key, (partnershipCounts.get(key) || 0) + 1);
    });
    teamA.forEach((a) => teamB.forEach((b) => {
      const key = pairKey(a, b);
      opponentCounts.set(key, (opponentCounts.get(key) || 0) + 1);
    }));
    [...teamA, ...teamB].forEach((player) => gameCounts.set(player, gameCounts.get(player) + 1));
  }));
  const opponentValues = [...opponentCounts.values()];
  return {
    partnerships: partnershipCounts.size,
    maxOpponent: Math.max(...opponentValues),
    once: opponentValues.filter((value) => value === 1).length,
    twice: opponentValues.filter((value) => value === 2).length,
    never: 66 - opponentCounts.size,
    allGames: [...gameCounts.values()].every((value) => value === 6),
  };
}

function renderDraw() {
  const audit = auditDraw();
  el('drawPanel').innerHTML = `<h2>Full optimized draw</h2><div class="audit"><div>✓ ${audit.partnerships}/36 mixed partnerships</div><div>✓ ${audit.allGames ? '6 games each' : 'Check games'}</div><div>✓ no repeated partnerships</div><div>✓ max opponent repeat ${audit.maxOpponent}</div><div>Opponents: ${audit.once} once · ${audit.twice} twice · ${audit.never} never</div><div>Courts #1, #2 and #3 rotated</div></div>${TEMPLATE.map((round, index) => `<div class="draw-round"><b>Round ${index + 1}</b>${round.map(([court, teamA, teamB]) => `<div class="draw-match"><strong>Court #${court}:</strong> ${escapeHtml(teamA.join(' & '))} vs ${escapeHtml(teamB.join(' & '))}</div>`).join('')}</div>`).join('')}`;
}

function renderAdmins() {
  if (!eventData) return;
  isOrganizer = (eventData.organizers || []).includes(user.uid);
  const names = (eventData.organizers || []).map((uid) => (eventData.organizerAliases || {})[uid] || (eventData.participantNames || {})[uid] || (uid === eventData.createdBy ? 'Creator' : 'Organizer'));
  el('adminList').innerHTML = `<div class="sub"><strong style="color:var(--ink)">Administrators:</strong> ${names.map((name) => `<span class="admin-chip">${escapeHtml(name)}</span>`).join('')}</div>`;
  el('invitePanel').classList.toggle('hidden', !isOrganizer);
  el('drawTab').classList.toggle('hidden', !isOrganizer);
  el('acceptPanel').classList.toggle('hidden', isOrganizer || !pendingOrganizerInvite);
  if (isOrganizer) el('acceptStatus').textContent = '';
  else if (pendingOrganizerInvite) el('acceptStatus').textContent = `Invitation for ${pendingOrganizerInvite.invitedName || profile?.name || 'this account'}`;
}

function renderAll() {
  if (!eventData || !drawData) return;
  el('loading').classList.add('hidden'); el('error').classList.add('hidden'); el('createPanel').classList.add('hidden'); el('eventApp').classList.remove('hidden');
  el('eventWhen').innerHTML = `<strong>Schedule:</strong> ${escapeHtml(formatWhen(eventData))}`;
  renderAdmins(); renderRounds(); renderStandings(); renderDraw(); void maybeRevealNext();
}

function updateInviteUi(invites) {
  SCOREKEEPERS.forEach((name) => {
    const invite = invites.find((item) => normalizedName(item.invitedName) === normalizedName(name));
    const statusNode = document.querySelector(`[data-invite-status="${name}"]`);
    const whatsappNode = document.querySelector(`[data-whatsapp="${name}"]`);
    if (!statusNode || !whatsappNode) return;
    if (!invite) { statusNode.textContent = 'Not invited yet.'; whatsappNode.classList.add('hidden'); return; }
    statusNode.textContent = invite.status === 'accepted' ? 'Accepted — score editing enabled.' : 'Invitation pending.';
    const base = `${location.origin}${location.pathname.replace(/[^/]+$/, '')}`;
    const liveLink = `${base}bonus-rounds-centre-court.html?event=${encodeURIComponent(eventId)}`;
    const message = `Hi ${name}, you have been invited as an administrator for Bonus Rounds at Centre Court. Open this link, sign in using this invited phone number, and tap Accept administrator invitation: ${liveLink}`;
    whatsappNode.href = `https://wa.me/${String(invite.invitedPhone || invite.id || '').replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
    whatsappNode.classList.remove('hidden');
  });
}

function startEventListeners() {
  if (eventUnsub) eventUnsub(); if (drawUnsub) drawUnsub(); if (sentInviteUnsub) sentInviteUnsub();
  eventUnsub = onSnapshot(doc(db, 'padelEvents', eventId), (snapshot) => {
    if (!snapshot.exists()) return showError('Event not found.');
    eventData = { id: snapshot.id, ...snapshot.data() };
    if (eventData.tournamentFormat !== FORMAT) return showError('This link is not the Bonus Rounds event.');
    if (drawData) renderAll();
  }, (error) => showError(error.message));
  drawUnsub = onSnapshot(doc(db, 'padelEvents', eventId, 'tournament', 'draw'), (snapshot) => {
    if (!snapshot.exists()) return;
    drawData = snapshot.data();
    if (eventData) renderAll();
  }, (error) => showError(error.message));
  sentInviteUnsub = watchSentOrganizerInvites(eventId, updateInviteUi, () => {});
}

async function findExistingEvent() {
  const snapshot = await getDocs(query(collection(db, 'padelEvents'), where('createdBy', '==', user.uid)));
  return snapshot.docs.map((document) => ({ id: document.id, ...document.data() })).find((event) => event.tournamentFormat === FORMAT) || null;
}

async function createEvent() {
  const date = el('eventDate').value;
  const time = el('eventTime').value;
  const duration = Number(el('eventDuration').value);
  if (!date || !time || !duration || duration < 30) {
    el('createStatus').textContent = 'Enter a valid date, start time and duration.';
    el('createStatus').classList.add('error');
    return;
  }
  const button = el('createEvent');
  button.disabled = true;
  el('createStatus').textContent = 'Creating event and fixed draw…';
  el('createStatus').classList.remove('error');
  try {
    const eventRef = await addDoc(collection(db, 'padelEvents'), {
      createdBy: user.uid,
      dateTime: Timestamp.fromDate(new Date(`${date}T${time}:00+05:30`)),
      durationMin: duration,
      location: 'Bonus Rounds at Centre Court',
      courts: 'Court #1, Court #2, Court #3',
      capacity: 12,
      tournamentFormat: FORMAT,
      numRounds: 6,
      pointsTarget: null,
      notes: MARKER,
      participants: [],
      participantNames: { [user.uid]: profile?.name || 'Animesh' },
      organizers: [user.uid],
      drawGenerated: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    eventId = eventRef.id;
    const participantNames = Object.fromEntries(PLAYERS.map((player) => [player.id, player.name]));
    participantNames[user.uid] = profile?.name || 'Animesh';
    await updateDoc(eventRef, { participants: PLAYERS.map((player) => player.id), participantNames, updatedAt: serverTimestamp() });
    await setDoc(doc(db, 'padelEvents', eventId, 'tournament', 'draw'), {
      format: FORMAT, players: PLAYERS, rounds: ROUNDS, numCourts: 3, pointsTarget: null, revealedCount: 1, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    history.replaceState(null, '', `?event=${encodeURIComponent(eventId)}`);
    startEventListeners();
  } catch (error) {
    el('createStatus').textContent = error.message || 'Could not create event.';
    el('createStatus').classList.add('error');
    button.disabled = false;
  }
}

function setupTabs() {
  document.querySelectorAll('[data-tab]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('hidden', panel.dataset.panel !== button.dataset.tab));
    if (button.dataset.tab === 'standings') renderStandings();
  }));
}

function setupInvites() {
  document.querySelectorAll('[data-invite]').forEach((button) => button.addEventListener('click', async () => {
    const name = button.dataset.invite;
    const input = document.querySelector(`[data-phone="${name}"]`);
    const phone = input.value.replace(/[^0-9+]/g, '');
    if (!phone) return toast(`Enter ${name}'s phone number`);
    button.disabled = true;
    try { await sendOrganizerInvite(eventId, phone, name, user.uid); input.value = ''; toast(`${name} invited`); }
    catch (error) { toast(error.message || 'Invite failed'); }
    finally { button.disabled = false; }
  }));
}

async function acceptPendingOrganizerInvite() {
  if (!pendingOrganizerInvite) return;
  if (!SCOREKEEPERS.map(normalizedName).includes(normalizedName(pendingOrganizerInvite.invitedName))) {
    el('acceptStatus').textContent = 'This administrator invitation is not valid for this event.';
    return;
  }
  const button = el('acceptAdmin');
  button.disabled = true;
  el('acceptStatus').textContent = 'Accepting invitation…';
  try {
    await acceptOrganizerInvite(eventId, pendingOrganizerInvite.invitedPhone || pendingOrganizerInvite.id, user.uid, profile?.name || pendingOrganizerInvite.invitedName || 'Organizer');
    pendingOrganizerInvite = null;
    el('acceptStatus').textContent = 'Accepted. Score editing is now enabled.';
    toast('Administrator access enabled');
  } catch (error) {
    el('acceptStatus').textContent = error.message || 'Could not accept invitation.';
    button.disabled = false;
  }
}

el('theme').addEventListener('click', () => {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  if (light) document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', 'light');
  try { localStorage.setItem('nextset-theme', light ? 'dark' : 'light'); } catch (error) {}
});
el('createEvent').addEventListener('click', createEvent);
el('acceptAdmin').addEventListener('click', acceptPendingOrganizerInvite);
el('share').addEventListener('click', async () => {
  const url = location.href;
  try { if (navigator.share) await navigator.share({ title: 'Bonus Rounds at Centre Court', url }); else { await navigator.clipboard.writeText(url); toast('Live link copied'); } }
  catch (error) {}
});
el('copyId').addEventListener('click', async () => { await navigator.clipboard.writeText(eventId); toast('Event ID copied'); });
setupTabs();
setupInvites();

onAuthStateChanged(auth, async (authenticatedUser) => {
  if (!authenticatedUser) return redirectToLogin();
  user = authenticatedUser;
  profile = await getMyProfile(user.uid).catch(() => null);
  if (profile?.phone) {
    myInviteUnsub = watchMyOrganizerInvites(profile.phone, (invites) => {
      pendingOrganizerInvite = invites.find((invite) => invite.eventId === eventId) || null;
      if (eventData) renderAdmins();
    }, () => {});
  }
  if (!eventId) {
    const existing = await findExistingEvent().catch(() => null);
    if (existing) {
      eventId = existing.id;
      history.replaceState(null, '', `?event=${encodeURIComponent(eventId)}`);
      startEventListeners();
    } else {
      el('loading').classList.add('hidden');
      el('createPanel').classList.remove('hidden');
    }
  } else startEventListeners();
});

window.addEventListener('beforeunload', () => {
  if (eventUnsub) eventUnsub(); if (drawUnsub) drawUnsub(); if (sentInviteUnsub) sentInviteUnsub(); if (myInviteUnsub) myInviteUnsub();
});
