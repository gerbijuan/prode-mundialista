import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const fixturePath = resolve(root, 'public/data/fixture-2026.json');
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const COMPETITION_CODE = 'WC';
const SITE_URL = process.env.SITE_URL || '';
const APPS_SCRIPT_WEBAPP_URL = process.env.APPS_SCRIPT_WEBAPP_URL || '';
const APPS_SCRIPT_SHARED_TOKEN = process.env.APPS_SCRIPT_SHARED_TOKEN || '';

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function main() {
  const serviceAccount = parseJsonEnv('FIREBASE_SERVICE_ACCOUNT_JSON');
  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!serviceAccount) throw new Error('Falta FIREBASE_SERVICE_ACCOUNT_JSON');
  if (!apiKey) throw new Error('Falta FOOTBALL_DATA_API_KEY');

  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();

  const [fixtureSeed, matchesApi, standingsApi] = await Promise.all([
    readJsonFile(fixturePath),
    fetchJson(`${FOOTBALL_DATA_BASE}/competitions/${COMPETITION_CODE}/matches`, apiKey),
    fetchJson(`${FOOTBALL_DATA_BASE}/competitions/${COMPETITION_CODE}/standings`, apiKey).catch(() => ({ standings: [] })),
  ]);

  const [matchesSnap, betsSnap, usersSnap] = await Promise.all([
    db.collection('matches').get(),
    db.collection('bets').get(),
    db.collection('users').get(),
  ]);

  if (matchesSnap.empty) {
    console.log('No hay partidos en Firestore. Sembrando fixture inicial...');
    await seedFixture(db, fixtureSeed);
  }

  const [currentMatchesSnap, allBetsSnap, currentUsersSnap] = await Promise.all([
    db.collection('matches').get(),
    db.collection('bets').get(),
    db.collection('users').get(),
  ]);

  const currentMatches = currentMatchesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const bets = allBetsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const users = currentUsersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const { changedMatches, updatedMatches } = await syncMatches(db, currentMatches, matchesApi.matches || []);
  const ranking = buildRanking(updatedMatches, bets, users);

  await Promise.all([
    db.collection('ranking').doc('current').set({ rows: ranking, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
    db.collection('tournament').doc('groups').set({ standings: mapStandings(standingsApi.standings || []), updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
  ]);

  if (!changedMatches.length) {
    console.log('Sin cambios de resultados para notificar.');
    return;
  }

  if (!APPS_SCRIPT_WEBAPP_URL || !APPS_SCRIPT_SHARED_TOKEN) {
    console.log('No hay APPS_SCRIPT_WEBAPP_URL o APPS_SCRIPT_SHARED_TOKEN. Se omiten los correos.');
    return;
  }

  const usersByUid = new Map(users.map((u) => [u.uid || u.id, u]));

  for (const match of changedMatches) {
    const resultKey = `${match.resultHome}-${match.resultAway}`;
    if (!Number.isInteger(match.resultHome) || !Number.isInteger(match.resultAway)) continue;
    if (match.lastNotifiedResult === resultKey) continue;

    const matchBets = bets.filter((bet) => bet.matchId === match.id);
    if (!matchBets.length) {
      await db.collection('matches').doc(match.id).set({ lastNotifiedResult: resultKey, lastNotifiedAt: FieldValue.serverTimestamp() }, { merge: true });
      continue;
    }

    const notifications = [];
    for (const bet of matchBets) {
      const user = usersByUid.get(bet.uid);
      if (!user?.email) continue;
      const row = ranking.find((r) => r.uid === bet.uid);
      const position = ranking.findIndex((r) => r.uid === bet.uid) + 1;
      const points = calculatePointsForBet(bet, match);
      notifications.push({
        to: user.email,
        subject: `Actualización del Prode Mundialista · ${match.homeTeam} ${match.resultHome}-${match.resultAway} ${match.awayTeam}`,
        text: buildEmailText({ user, match, bet, points, row, position, ranking }),
        html: buildEmailHtml({ user, match, bet, points, row, position, ranking }),
        name: 'El Prode Mundialista',
      });
    }

    if (notifications.length) {
      await sendViaAppsScript({ notifications });
    }

    await db.collection('matches').doc(match.id).set({ lastNotifiedResult: resultKey, lastNotifiedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  console.log(`Sync completa. Cambios detectados: ${changedMatches.length}`);
}

async function sendViaAppsScript(payload) {
  const response = await fetch(APPS_SCRIPT_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: APPS_SCRIPT_SHARED_TOKEN, ...payload }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Apps Script respondió ${response.status}: ${text}`);
  }
  console.log('Apps Script response:', text);
}

async function seedFixture(db, fixture) {
  const batch = db.batch();
  for (const match of fixture) {
    batch.set(db.collection('matches').doc(match.id), {
      ...match,
      kickoffAtMs: match.kickoffAtMs || Date.parse(match.kickoffAt),
      externalMatchId: null,
      resultHome: null,
      resultAway: null,
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  }
  await batch.commit();
}

async function syncMatches(db, currentMatches, apiMatches) {
  const byExternal = new Map();
  const byComposite = new Map();
  for (const match of currentMatches) {
    if (Number.isInteger(match.externalMatchId)) byExternal.set(match.externalMatchId, match);
    byComposite.set(buildCompositeKey(match.homeTeam, match.awayTeam, match.kickoffAt), match);
  }

  const updatedMatches = currentMatches.map((m) => ({ ...m }));
  const updatedIndex = new Map(updatedMatches.map((m) => [m.id, m]));
  const changedMatches = [];
  const batch = db.batch();
  let writes = 0;

  for (const apiMatch of apiMatches) {
    const extId = Number(apiMatch?.id);
    const kickoffAt = apiMatch?.utcDate || null;
    const homeTeam = normalizeApiTeam(apiMatch?.homeTeam?.name);
    const awayTeam = normalizeApiTeam(apiMatch?.awayTeam?.name);
    const resultHome = toNullableInt(apiMatch?.score?.fullTime?.home);
    const resultAway = toNullableInt(apiMatch?.score?.fullTime?.away);
    const status = mapApiStatus(apiMatch?.status, resultHome, resultAway);
    const existing = byExternal.get(extId) || byComposite.get(buildCompositeKey(homeTeam, awayTeam, kickoffAt));
    if (!existing) continue;

    const changed = existing.resultHome !== resultHome || existing.resultAway !== resultAway || existing.status !== status || existing.externalMatchId !== extId;
    if (!changed) continue;

    writes += 1;
    batch.set(db.collection('matches').doc(existing.id), {
      externalMatchId: extId,
      resultHome,
      resultAway,
      status,
      lastSyncedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const local = updatedIndex.get(existing.id);
    if (local) {
      local.externalMatchId = extId;
      local.resultHome = resultHome;
      local.resultAway = resultAway;
      local.status = status;
      changedMatches.push(local);
    }
  }

  if (writes) await batch.commit();
  return { changedMatches, updatedMatches };
}

function buildRanking(matches, bets, users) {
  const matchById = new Map(matches.map((m) => [m.id, m]));
  return users.map((user) => {
    const uid = user.uid || user.id;
    const userBets = bets.filter((bet) => bet.uid === uid);
    let points = 0, exact = 0, outcomes = 0;
    for (const bet of userBets) {
      const match = matchById.get(bet.matchId);
      if (!match || !Number.isInteger(match.resultHome) || !Number.isInteger(match.resultAway)) continue;
      const betPoints = calculatePointsForBet(bet, match);
      points += betPoints;
      if (bet.home === match.resultHome && bet.away === match.resultAway) exact += 1;
      if (getOutcome(bet.home, bet.away) === getOutcome(match.resultHome, match.resultAway)) outcomes += 1;
    }
    return { uid, name: user.displayName || user.email || 'Usuario', email: user.email || '', points, exact, outcomes, bets: userBets.length };
  }).sort((a, b) => b.points - a.points || b.exact - a.exact || b.outcomes - a.outcomes || a.name.localeCompare(b.name, 'es'));
}

function mapStandings(standings) {
  return standings.map((entry) => ({
    group: entry.group || entry.stage || '',
    type: entry.type || '',
    table: (entry.table || []).map((row) => ({
      position: row.position,
      team: normalizeApiTeam(row.team?.name || ''),
      playedGames: row.playedGames,
      won: row.won,
      draw: row.draw,
      lost: row.lost,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      goalDifference: row.goalDifference,
      points: row.points,
    })),
  }));
}

function calculatePointsForBet(bet, match) {
  if (!Number.isInteger(match.resultHome) || !Number.isInteger(match.resultAway)) return 0;
  if (bet.home === match.resultHome && bet.away === match.resultAway) return 4;
  if (getOutcome(bet.home, bet.away) === getOutcome(match.resultHome, match.resultAway)) return 2;
  return 1;
}

function getOutcome(home, away) {
  return home > away ? 'home' : home < away ? 'away' : 'draw';
}

function buildEmailHtml({ user, match, bet, points, row, position, ranking }) {
  const top = ranking.slice(0, 5).map((r, i) => `<li>${i + 1}. ${escapeHtml(r.name)} · ${r.points} pts</li>`).join('');
  const cta = SITE_URL ? `<p><a href="${SITE_URL}" target="_blank" rel="noreferrer">Abrir El Prode Mundialista</a></p>` : '';
  return `<div style="font-family:Arial,sans-serif;color:#14314f;line-height:1.55"><h2 style="margin:0 0 12px">El Prode Mundialista</h2><p>Hola <strong>${escapeHtml(user.displayName || user.email || 'usuario')}</strong>, ya se actualizó un partido.</p><p><strong>${escapeHtml(match.homeTeam)} ${match.resultHome}-${match.resultAway} ${escapeHtml(match.awayTeam)}</strong></p><p>Tu apuesta fue <strong>${bet.home}-${bet.away}</strong> y sumaste <strong>${points} ${points === 1 ? 'punto' : 'puntos'}</strong>. <em>Recordatorio:</em> exacto = 4, signo = 2, fallo con apuesta = 1, sin jugar = 0.</p><p>Ahora estás en la posición <strong>#${position}</strong> con <strong>${row?.points || 0} pts</strong>.</p><h3 style="margin:20px 0 8px">Clasificación actual</h3><ol style="padding-left:20px;margin:0">${top}</ol>${cta}</div>`;
}

function buildEmailText({ user, match, bet, points, row, position, ranking }) {
  return [
    'El Prode Mundialista', '', `Hola ${user.displayName || user.email || 'usuario'}, ya se actualizó un partido.`, `${match.homeTeam} ${match.resultHome}-${match.resultAway} ${match.awayTeam}`,
    `Tu apuesta: ${bet.home}-${bet.away}`, `Puntos ganados: ${points} (exacto=4, signo=2, fallo con apuesta=1, sin jugar=0)`, `Posición actual: #${position}`, `Puntos totales: ${row?.points || 0}`, '', 'Clasificación actual:',
    ...ranking.slice(0, 5).map((r, i) => `${i + 1}. ${r.name} · ${r.points} pts`), SITE_URL ? `\nAbrir app: ${SITE_URL}` : ''
  ].join('\n');
}

function normalizeApiTeam(name) {
  const n = String(name || '').trim();
  const aliases = {
    'United States': 'Estados Unidos', 'USA': 'Estados Unidos', 'Korea Republic': 'Corea del Sur', 'Czechia': 'Chequia', 'Netherlands': 'Países Bajos',
    'IR Iran': 'Irán', 'Ivory Coast': 'Costa de Marfil', 'DR Congo': 'RD Congo', 'Cape Verde': 'Cabo Verde', 'Saudi Arabia': 'Arabia Saudita',
    'New Zealand': 'Nueva Zelanda', 'Bosnia-Herzegovina': 'Bosnia y Herzegovina', 'Scotland': 'Escocia', 'England': 'Inglaterra'
  };
  return aliases[n] || n;
}

function toNullableInt(value) {
  return Number.isInteger(value) ? Number(value) : null;
}

function mapApiStatus(apiStatus, home, away) {
  if (Number.isInteger(home) && Number.isInteger(away)) return 'played';
  if (['IN_PLAY', 'PAUSED', 'LIVE'].includes(apiStatus)) return 'in_play';
  return 'scheduled';
}

function buildCompositeKey(homeTeam, awayTeam, kickoffAt) {
  return `${String(homeTeam || '').trim().toLowerCase()}__${String(awayTeam || '').trim().toLowerCase()}__${kickoffAt || ''}`;
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  return raw ? JSON.parse(raw) : null;
}

async function readJsonFile(path) {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw);
}

async function fetchJson(url, apiKey) {
  const response = await fetch(url, { headers: { 'X-Auth-Token': apiKey } });
  if (!response.ok) {
    throw new Error(`Error ${response.status} consultando ${url}: ${await response.text()}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
