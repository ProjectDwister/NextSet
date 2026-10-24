import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-auth.js';
import {
  collection,
  doc,
  onSnapshot,
  query,
  where,
} from 'https://www.gstatic.com/firebasejs/12.13.0/firebase-firestore.js';

const GLASS_FORMAT = 'glass-mixed-americano-2026-10-24';
const BONUS_FORMAT = 'bonus-centre-court-mixed-americano';
const ROSTER = [
  'Shruti', 'Ritika', 'Arunima', 'Rashida', 'Tunali', 'Shweta',
  'Nishank', 'Nikhil', 'Santosh', 'Mayur', 'Raj', 'Yashraj',
];
const CANONICAL_NAMES = new Map(ROSTER.map((name) => [name.toLowerCase(), name]));
const EVENT_CONFIG = {
  glass: {
    format: GLASS_FORMAT,
    title: 'Glass Court Mixed Americano',
    page: 'glass-court-mixed-americano.html',
    param: 'glass',
  },
  bonus: {
    format: BONUS_FORMAT,
    title: 'Bonus Rounds at Centre Court',
    page: 'bonus-rounds-centre-court.html',
    param: 'bonus',
  },
};

const el = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = {
  glass: { event: null, draw: null, resolved: false, selectedId: '' },
  bonus: { event: null, draw: null, resolved: false, selectedId: '' },
};
const discoveryUnsubs = {};
const eventUnsubs = {};
const drawUnsubs = {};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

function canonicalName(value) {
  const raw = String(value || '').trim();
  const lower = raw.toLowerCase();
  if (lower === 'pinder') return 'Shruti';
  return CANONICAL_NAMES.get(lower) || raw;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function formatWhen(event) {
  if (!event?.dateTime) return '';
  const start = typeof event.dateTime.toDate === 'function'
    ? event.dateTime.toDate()
    : new Date(event.dateTime);
  if (Number.isNaN(start.getTime())) return '';
  const end = new Date(start.getTime() + Number(event.durationMin || 0) * 60000);
  const date = start.toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
  const startTime = start.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  const endTime = end.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${startTime}–${endTime}`;
}

function redirectToLogin() {
  const target = location.pathname.split('/').pop() + location.search;
  const url = new URL('index.html', location.href);
  url.searchParams.set('nav', '1');
  url.searchParams.set('returnTo', target);
  location.replace(url.toString());
}

function toast(message) {
  el('toast').textContent = message;
  el('toast').classList.remove('hidden');
  setTimeout(() => el('toast').classList.add('hidden'), 1800);
}

function emptyPlayerStats(name) {
  return { name, played: 0, points: 0, against: 0, wins: 0 };
}

function calculateEventStats(draw) {
  const players = new Map(ROSTER.map((name) => [name, emptyPlayerStats(name)]));
  const idToName = new Map();

  (draw?.players || []).forEach((player) => {
    idToName.set(player.id, canonicalName(player.name || player.id));
  });

  let scoredMatches = 0;
  let completedRounds = 0;
  let totalMatches = 0;
  const rounds = draw?.rounds || [];

  rounds.forEach((round) => {
    const courts = round.courts || [];
    totalMatches += courts.length;
    let completedInRound = 0;

    courts.forEach((court) => {
      if (court.scoreA == null || court.scoreB == null) return;
      const scoreA = Number(court.scoreA);
      const scoreB = Number(court.scoreB);
      if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB)) return;

      scoredMatches += 1;
      completedInRound += 1;

      const addResult = (ids, points, against, won) => {
        (ids || []).forEach((id) => {
          const name = canonicalName(idToName.get(id) || id);
          if (!players.has(name)) players.set(name, emptyPlayerStats(name));
          const row = players.get(name);
          row.played += 1;
          row.points += points;
          row.against += against;
          if (won) row.wins += 1;
        });
      };

      addResult(court.teamA, scoreA, scoreB, scoreA > scoreB);
      addResult(court.teamB, scoreB, scoreA, scoreB > scoreA);
    });

    if (courts.length > 0 && completedInRound === courts.length) completedRounds += 1;
  });

  return {
    players,
    scoredMatches,
    completedRounds,
    totalMatches: totalMatches || 18,
    totalRounds: rounds.length || 6,
  };
}

function combinedRows() {
  const glass = calculateEventStats(state.glass.draw);
  const bonus = calculateEventStats(state.bonus.draw);
  const names = [...ROSTER];
  const extras = new Set([...glass.players.keys(), ...bonus.players.keys()]);
  ROSTER.forEach((name) => extras.delete(name));
  names.push(...[...extras].sort((a, b) => a.localeCompare(b)));

  const rows = names.map((name) => {
    const g = glass.players.get(name) || emptyPlayerStats(name);
    const b = bonus.players.get(name) || emptyPlayerStats(name);
    const points = g.points + b.points;
    const against = g.against + b.against;
    return {
      name,
      glassPoints: g.points,
      bonusPoints: b.points,
      played: g.played + b.played,
      points,
      against,
      diff: points - against,
      wins: g.wins + b.wins,
    };
  });

  const ranked = [...rows].sort((a, b) =>
    b.points - a.points ||
    b.diff - a.diff ||
    b.wins - a.wins ||
    a.name.localeCompare(b.name),
  );

  return { rows, ranked, glass, bonus };
}

function eventLink(key) {
  const event = state[key].event;
  if (!event?.id) return '';
  return `${EVENT_CONFIG[key].page}?event=${encodeURIComponent(event.id)}`;
}

function renderEventSummary(key) {
  const target = el(`${key}Summary`);
  const config = EVENT_CONFIG[key];
  const event = state[key].event;
  const draw = state[key].draw;
  const stats = calculateEventStats(draw);

  if (!event) {
    target.innerHTML = `
      <h2>${escapeHtml(config.title)}</h2>
      <div class="progress">Waiting</div>
      <div class="small">This event has not been found yet. The combined page will connect automatically after it is created.</div>`;
    return;
  }

  const status = draw
    ? `${stats.scoredMatches} of ${stats.totalMatches} matches scored`
    : 'Waiting for draw';
  target.innerHTML = `
    <h2>${escapeHtml(config.title)}</h2>
    <div class="small">${escapeHtml(formatWhen(event))}</div>
    <div class="progress">${stats.scoredMatches}/${stats.totalMatches}</div>
    <div class="small">${escapeHtml(status)} · ${stats.completedRounds}/${stats.totalRounds} rounds complete</div>
    <a href="${escapeHtml(eventLink(key))}">Open this event →</a>`;
}

function renderTables() {
  const { rows, ranked, glass, bonus } = combinedRows();

  el('scoresBody').innerHTML = rows.map((row) => `
    <tr>
      <td>${escapeHtml(row.name)}</td>
      <td>${row.glassPoints}</td>
      <td>${row.bonusPoints}</td>
      <td class="total">${row.points}</td>
      <td>${row.played}</td>
      <td>${row.against}</td>
      <td>${row.diff > 0 ? '+' : ''}${row.diff}</td>
      <td>${row.wins}</td>
    </tr>`).join('');

  el('standingsBody').innerHTML = ranked.map((row, index) => `
    <tr>
      <td class="rank">${index + 1}</td>
      <td>${escapeHtml(row.name)}</td>
      <td>${row.played}</td>
      <td class="points">${row.points}</td>
      <td>${row.against}</td>
      <td>${row.diff > 0 ? '+' : ''}${row.diff}</td>
      <td>${row.wins}</td>
    </tr>`).join('');

  el('matchesScored').textContent = glass.scoredMatches + bonus.scoredMatches;
  el('roundsCompleted').textContent = glass.completedRounds + bonus.completedRounds;
  el('leaderPoints').textContent = ranked[0]?.points || 0;
  el('playersActive').textContent = ranked.length;
}

function render() {
  const allResolved = state.glass.resolved && state.bonus.resolved;
  if (!allResolved) return;

  el('loading').classList.add('hidden');
  el('error').classList.add('hidden');
  el('app').classList.remove('hidden');
  renderEventSummary('glass');
  renderEventSummary('bonus');
  renderTables();
}

function showSourceError(key, error) {
  state[key].resolved = true;
  el('loading').classList.add('hidden');
  el('error').classList.remove('hidden');
  el('error').innerHTML = `
    <h2>Could not connect to ${escapeHtml(EVENT_CONFIG[key].title)}</h2>
    <div class="sub">${escapeHtml(error?.message || 'Unknown Firebase error.')}</div>`;
  render();
}

function clearEventSubscriptions(key) {
  if (eventUnsubs[key]) eventUnsubs[key]();
  if (drawUnsubs[key]) drawUnsubs[key]();
  eventUnsubs[key] = null;
  drawUnsubs[key] = null;
}

function subscribeToSelectedEvent(key, eventId) {
  if (state[key].selectedId === eventId && eventUnsubs[key] && drawUnsubs[key]) return;
  clearEventSubscriptions(key);
  state[key].selectedId = eventId;
  state[key].event = null;
  state[key].draw = null;

  eventUnsubs[key] = onSnapshot(
    doc(db, 'padelEvents', eventId),
    (snapshot) => {
      state[key].resolved = true;
      if (!snapshot.exists()) {
        state[key].event = null;
        render();
        return;
      }
      const event = { id: snapshot.id, ...snapshot.data() };
      if (event.tournamentFormat !== EVENT_CONFIG[key].format) {
        showSourceError(key, new Error('The supplied Event ID belongs to a different tournament format.'));
        return;
      }
      state[key].event = event;
      render();
    },
    (error) => showSourceError(key, error),
  );

  drawUnsubs[key] = onSnapshot(
    doc(db, 'padelEvents', eventId, 'tournament', 'draw'),
    (snapshot) => {
      state[key].resolved = true;
      state[key].draw = snapshot.exists() ? snapshot.data() : null;
      render();
    },
    (error) => showSourceError(key, error),
  );
}

function discoverEvent(key) {
  const config = EVENT_CONFIG[key];
  const explicitId = params.get(config.param);
  if (explicitId) {
    state[key].resolved = true;
    subscribeToSelectedEvent(key, explicitId);
    return;
  }

  discoveryUnsubs[key] = onSnapshot(
    query(collection(db, 'padelEvents'), where('tournamentFormat', '==', config.format)),
    (snapshot) => {
      state[key].resolved = true;
      const events = snapshot.docs
        .map((document) => ({ id: document.id, ...document.data() }))
        .sort((a, b) =>
          timestampMillis(b.createdAt) - timestampMillis(a.createdAt) ||
          timestampMillis(b.dateTime) - timestampMillis(a.dateTime),
        );

      if (!events.length) {
        clearEventSubscriptions(key);
        state[key].selectedId = '';
        state[key].event = null;
        state[key].draw = null;
        render();
        return;
      }
      subscribeToSelectedEvent(key, events[0].id);
      render();
    },
    (error) => showSourceError(key, error),
  );
}

function setupTabs() {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((item) => {
        item.classList.toggle('active', item === button);
      });
      document.querySelectorAll('[data-panel]').forEach((panel) => {
        panel.classList.toggle('hidden', panel.dataset.panel !== button.dataset.tab);
      });
      renderTables();
    });
  });
}

el('theme').addEventListener('click', () => {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  if (light) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', 'light');
  try {
    localStorage.setItem('nextset-theme', light ? 'dark' : 'light');
  } catch (error) {}
});

el('share').addEventListener('click', async () => {
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Combined Scores & Standings', url: location.href });
    } else {
      await navigator.clipboard.writeText(location.href);
      toast('Combined standings link copied');
    }
  } catch (error) {}
});

setupTabs();

onAuthStateChanged(auth, (user) => {
  if (!user) {
    redirectToLogin();
    return;
  }
  discoverEvent('glass');
  discoverEvent('bonus');
});

window.addEventListener('beforeunload', () => {
  Object.values(discoveryUnsubs).forEach((unsubscribe) => unsubscribe?.());
  Object.values(eventUnsubs).forEach((unsubscribe) => unsubscribe?.());
  Object.values(drawUnsubs).forEach((unsubscribe) => unsubscribe?.());
});
