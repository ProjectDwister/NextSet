/**
 * Automated tests for firestore.rules, run against Firebase's local
 * emulator — never against the real, live database. This is new as
 * of this pass: every rules bug found so far in this project (the
 * missing organizer-invite-accept branch, the collection-group query
 * checking a path segment instead of a data field) was found by a
 * real person hitting it in production, not by anything automated.
 * This suite exists specifically so the next one gets caught before
 * it ships, not after.
 *
 * HOW TO ACTUALLY RUN THIS — genuinely important to read, since none
 * of this has been executed yet. It needs Node.js and the Firebase
 * CLI installed locally; neither is available in the sandbox these
 * files were written in, so this has been checked for valid syntax
 * only, not run end-to-end against real rules-evaluation logic.
 *
 *   1. cd firestore-rules-tests
 *   2. npm install
 *   3. npm test
 *      (this starts the Firestore emulator, runs every test below
 *      against it, then shuts the emulator down — nothing here ever
 *      touches your real, live Firestore data)
 *
 * If a test fails, the failure message names exactly which
 * assertSucceeds/assertFails call didn't match — that's the rule to
 * go look at, not a sign the whole file is broken.
 */

const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

let testEnv;

// Consistent across every test — these are the only two "people" most
// tests need. Phone numbers matter here specifically because myPhone()
// in the rules reads from the auth token's phone_number claim, not
// from any Firestore document.
const ALICE_UID = 'alice-uid';
const ALICE_PHONE = '+911111111111';
const BOB_UID = 'bob-uid';
const BOB_PHONE = '+912222222222';
const STRANGER_UID = 'stranger-uid';
const STRANGER_PHONE = '+913333333333';

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-court-pop-rules-test',
    firestore: {
      rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
});

function ctx(uid, phone) {
  return testEnv.authenticatedContext(uid, { phone_number: phone });
}

// Bypasses all rules entirely, same as the Cloud Functions' Admin SDK
// does in production — used only to set up test data, never to make
// the actual assertions the tests care about.
async function seed(fn) {
  await testEnv.withSecurityRulesDisabled(async (adminCtx) => {
    await fn(adminCtx.firestore());
  });
}

function baseEvent(overrides = {}) {
  return {
    createdBy: ALICE_UID,
    dateTime: new Date('2026-08-01T10:00:00Z'),
    durationMin: 120,
    location: 'Test Court',
    courts: '1 court',
    capacity: 4,
    tournamentFormat: 'americano',
    numRounds: 3,
    pointsTarget: 24,
    notes: '',
    participants: [ALICE_UID],
    participantNames: { [ALICE_UID]: 'Alice' },
    organizers: [ALICE_UID],
    drawGenerated: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('padelEvents — read access', () => {
  test('a participant can read their own event', async () => {
    await seed((db) => db.doc('padelEvents/e1').set(baseEvent()));
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertSucceeds(db.doc('padelEvents/e1').get());
  });

  test('a complete stranger cannot read it', async () => {
    await seed((db) => db.doc('padelEvents/e1').set(baseEvent()));
    const db = ctx(STRANGER_UID, STRANGER_PHONE).firestore();
    await assertFails(db.doc('padelEvents/e1').get());
  });

  test('someone with a pending invite can read it, before accepting', async () => {
    await seed(async (db) => {
      await db.doc('padelEvents/e1').set(baseEvent());
      await db.doc('padelEvents/e1/padelInvites/' + BOB_PHONE).set({
        invitedBy: ALICE_UID,
        invitedPhone: BOB_PHONE,
        invitedName: 'Bob',
        status: 'pending',
        createdAt: new Date(),
      });
    });
    const db = ctx(BOB_UID, BOB_PHONE).firestore();
    await assertSucceeds(db.doc('padelEvents/e1').get());
  });
});

describe('padelEvents — create', () => {
  test('creator must set themself as the sole organizer', async () => {
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertSucceeds(db.doc('padelEvents/e2').set(baseEvent({ organizers: [ALICE_UID] })));
  });

  test('cannot create an event claiming someone else as organizer', async () => {
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertFails(db.doc('padelEvents/e3').set(baseEvent({ organizers: [BOB_UID] })));
  });

  test('organizer-only creation (not playing) is allowed — empty participants', async () => {
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertSucceeds(db.doc('padelEvents/e4').set(baseEvent({ participants: [] })));
  });

  test('cannot create with an unexpected extra field', async () => {
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertFails(db.doc('padelEvents/e5').set(baseEvent({ notAllowedField: 'sneaky' })));
  });
});

describe('padelEvents — update, and the two specific regressions from this project', () => {
  test('an organizer can freely edit event details', async () => {
    await seed((db) => db.doc('padelEvents/e6').set(baseEvent()));
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertSucceeds(db.doc('padelEvents/e6').update({ location: 'New Venue', updatedAt: new Date() }));
  });

  test('a non-organizer, non-participant cannot edit anything', async () => {
    await seed((db) => db.doc('padelEvents/e7').set(baseEvent()));
    const db = ctx(STRANGER_UID, STRANGER_PHONE).firestore();
    await assertFails(db.doc('padelEvents/e7').update({ location: 'Hijacked' }));
  });

  test('cannot exceed the 4-organizer cap', async () => {
    await seed((db) => db.doc('padelEvents/e8').set(baseEvent({
      organizers: [ALICE_UID, 'o2', 'o3', 'o4'],
    })));
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertFails(db.doc('padelEvents/e8').update({
      organizers: [ALICE_UID, 'o2', 'o3', 'o4', 'o5'],
      updatedAt: new Date(),
    }));
  });

  test('REGRESSION — accepting a player invite adds only yourself to participants', async () => {
    await seed(async (db) => {
      await db.doc('padelEvents/e9').set(baseEvent());
      await db.doc('padelEvents/e9/padelInvites/' + BOB_PHONE).set({
        invitedBy: ALICE_UID, invitedPhone: BOB_PHONE, invitedName: 'Bob',
        status: 'accepted', createdAt: new Date(), respondedAt: new Date(),
      });
    });
    const db = ctx(BOB_UID, BOB_PHONE).firestore();
    await assertSucceeds(db.doc('padelEvents/e9').update({
      participants: [ALICE_UID, BOB_UID],
      participantNames: { [ALICE_UID]: 'Alice', [BOB_UID]: 'Bob' },
      updatedAt: new Date(),
    }));
  });

  test('REGRESSION — accepting an organizer invite adds only yourself to organizers (the exact bug found and fixed this session)', async () => {
    await seed(async (db) => {
      await db.doc('padelEvents/e10').set(baseEvent());
      await db.doc('padelEvents/e10/organizerInvites/' + BOB_PHONE).set({
        invitedBy: ALICE_UID, invitedPhone: BOB_PHONE, invitedName: 'Bob',
        status: 'accepted', createdAt: new Date(), respondedAt: new Date(),
      });
    });
    const db = ctx(BOB_UID, BOB_PHONE).firestore();
    await assertSucceeds(db.doc('padelEvents/e10').update({
      organizers: [ALICE_UID, BOB_UID],
      participantNames: { [ALICE_UID]: 'Alice', [BOB_UID]: 'Bob' },
      updatedAt: new Date(),
    }));
  });

  test('cannot add yourself as organizer without an accepted organizer invite', async () => {
    await seed((db) => db.doc('padelEvents/e11').set(baseEvent()));
    const db = ctx(BOB_UID, BOB_PHONE).firestore();
    await assertFails(db.doc('padelEvents/e11').update({
      organizers: [ALICE_UID, BOB_UID],
      updatedAt: new Date(),
    }));
  });
});

describe('padelInvites and organizerInvites — who can send, who can respond', () => {
  test('only an organizer can send a player invite, not just any participant', async () => {
    await seed((db) => db.doc('padelEvents/e12').set(baseEvent({
      organizers: [ALICE_UID],
      participants: [ALICE_UID, BOB_UID],
      participantNames: { [ALICE_UID]: 'Alice', [BOB_UID]: 'Bob' },
    })));
    const bobDb = ctx(BOB_UID, BOB_PHONE).firestore(); // Bob plays, but isn't an organizer
    await assertFails(bobDb.doc('padelEvents/e12/padelInvites/' + STRANGER_PHONE).set({
      invitedBy: BOB_UID, invitedPhone: STRANGER_PHONE, invitedName: 'Someone',
      status: 'pending', createdAt: new Date(),
    }));
  });

  test('only an organizer can send an organizer invite', async () => {
    await seed((db) => db.doc('padelEvents/e13').set(baseEvent({
      participants: [ALICE_UID, BOB_UID],
      participantNames: { [ALICE_UID]: 'Alice', [BOB_UID]: 'Bob' },
    })));
    const bobDb = ctx(BOB_UID, BOB_PHONE).firestore();
    await assertFails(bobDb.doc('padelEvents/e13/organizerInvites/' + STRANGER_PHONE).set({
      invitedBy: BOB_UID, invitedPhone: STRANGER_PHONE, invitedName: 'Someone',
      status: 'pending', createdAt: new Date(),
    }));
  });

  test('only the actual invitee can accept or decline their own invite', async () => {
    await seed(async (db) => {
      await db.doc('padelEvents/e14').set(baseEvent());
      await db.doc('padelEvents/e14/padelInvites/' + BOB_PHONE).set({
        invitedBy: ALICE_UID, invitedPhone: BOB_PHONE, invitedName: 'Bob',
        status: 'pending', createdAt: new Date(),
      });
    });
    const strangerDb = ctx(STRANGER_UID, STRANGER_PHONE).firestore();
    await assertFails(strangerDb.doc('padelEvents/e14/padelInvites/' + BOB_PHONE).update({
      status: 'accepted', respondedAt: new Date(),
    }));

    const bobDb = ctx(BOB_UID, BOB_PHONE).firestore();
    await assertSucceeds(bobDb.doc('padelEvents/e14/padelInvites/' + BOB_PHONE).update({
      status: 'accepted', respondedAt: new Date(),
    }));
  });

  test('REGRESSION — collection-group query for "my pending invites" actually succeeds (the other bug found and fixed this session)', async () => {
    await seed(async (db) => {
      await db.doc('padelEvents/e15').set(baseEvent());
      await db.doc('padelEvents/e15/padelInvites/' + BOB_PHONE).set({
        invitedBy: ALICE_UID, invitedPhone: BOB_PHONE, invitedName: 'Bob',
        status: 'pending', createdAt: new Date(),
      });
    });
    const bobDb = ctx(BOB_UID, BOB_PHONE).firestore();
    const q = bobDb.collectionGroup('padelInvites')
      .where('invitedPhone', '==', BOB_PHONE)
      .where('status', '==', 'pending');
    await assertSucceeds(q.get());
  });

  test('the same collection-group query cannot be used to snoop on someone else\'s invites', async () => {
    await seed(async (db) => {
      await db.doc('padelEvents/e16').set(baseEvent());
      await db.doc('padelEvents/e16/padelInvites/' + BOB_PHONE).set({
        invitedBy: ALICE_UID, invitedPhone: BOB_PHONE, invitedName: 'Bob',
        status: 'pending', createdAt: new Date(),
      });
    });
    const strangerDb = ctx(STRANGER_UID, STRANGER_PHONE).firestore();
    const q = strangerDb.collectionGroup('padelInvites')
      .where('invitedPhone', '==', BOB_PHONE) // querying for BOB's invites, signed in as someone else
      .where('status', '==', 'pending');
    await assertFails(q.get());
  });
});

describe('tournament subcollection — scoring vs. viewing', () => {
  test('an organizer can write scores', async () => {
    await seed((db) => db.doc('padelEvents/e17').set(baseEvent()));
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertSucceeds(db.doc('padelEvents/e17/tournament/draw').set({ players: [], rounds: [] }));
  });

  test('a participant who is not an organizer can read scores but not write them', async () => {
    await seed((db) => db.doc('padelEvents/e18').set(baseEvent({
      participants: [ALICE_UID, BOB_UID],
      participantNames: { [ALICE_UID]: 'Alice', [BOB_UID]: 'Bob' },
    })));
    await seed((db) => db.doc('padelEvents/e18/tournament/draw').set({ players: [], rounds: [] }));

    const bobDb = ctx(BOB_UID, BOB_PHONE).firestore();
    await assertSucceeds(bobDb.doc('padelEvents/e18/tournament/draw').get());
    await assertFails(bobDb.doc('padelEvents/e18/tournament/draw').update({ rounds: [] }));
  });
});

describe('admins collection — completely locked to every client, always', () => {
  test('nobody can read it, not even an actual admin', async () => {
    await seed((db) => db.doc('admins/' + ALICE_PHONE).set({ note: 'me' }));
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertFails(db.doc('admins/' + ALICE_PHONE).get());
  });

  test('nobody can write to it either', async () => {
    const db = ctx(ALICE_UID, ALICE_PHONE).firestore();
    await assertFails(db.doc('admins/' + ALICE_PHONE).set({ note: 'trying to self-promote' }));
  });
});
