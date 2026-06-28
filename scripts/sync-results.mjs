import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const fixturePath = resolve(root, 'public/data/fixture-2026.json');
const bracketPath = resolve(root, 'public/data/bracket-2026.json');
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const COMPETITION_CODE = 'WC';
const SITE_URL = process.env.SITE_URL || '';
const APPS_SCRIPT_WEBAPP_URL = process.env.APPS_SCRIPT_WEBAPP_URL || '';
const APPS_SCRIPT_SHARED_TOKEN = process.env.APPS_SCRIPT_SHARED_TOKEN || '';

const STAGE_META = {
  'Fase de grupos': { stageOrder: 1, exactPoints: 4 },
  'Dieciseisavos': { stageOrder: 2, exactPoints: 5, apiAliases: ['LAST_32', 'ROUND_OF_32', 'PLAYOFFS', 'PRELIMINARY_FINAL'] },
  'Octavos': { stageOrder: 3, exactPoints: 6, apiAliases: ['LAST_16', 'ROUND_OF_16'] },
  'Cuartos': { stageOrder: 4, exactPoints: 7, apiAliases: ['QUARTER_FINALS', 'QUARTER_FINAL'] },
  'Semifinales': { stageOrder: 5, exactPoints: 8, apiAliases: ['SEMI_FINALS', 'SEMI_FINAL'] },
  '3º puesto': { stageOrder: 6, exactPoints: 8, apiAliases: ['THIRD_PLACE'] },
  'Final': { stageOrder: 7, exactPoints: 9, apiAliases: ['FINAL'] },
};

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

  const [fixtureSeed, bracketSeed, matchesApi, standingsApi] = await Promise.all([
    readJsonFile(fixturePath),
    readJsonFile(bracketPath),
    fetchJson(`${FOOTBALL_DATA_BASE}/competitions/${COMPETITION_CODE}/matches`, apiKey),
    fetchJson(`${FOOTBALL_DATA_BASE}/competitions/${COMPETITION_CODE}/standings`, apiKey).catch(() => ({ standings: [] })),
  ]);

  const seedMatches = [...normalizeGroupSeeds(fixtureSeed), ...normalizeKnockoutSeeds(bracketSeed)];
  await upsertSeedMatches(db, seedMatches);

  const [matchesSnap, betsSnap, usersSnap] = await Promise.all([
    db.collection('matches').get(),
    db.collection('bets').get(),
    db.collection('users').get(),
  ]);

  let currentMatches = matchesSnap.docs.map((doc) => normalizeMatch({ id: doc.id, ...doc.data() }));
  const bets = betsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const users = usersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const syncResult = await syncMatchesFromApi(db, currentMatches, matchesApi.matches || []);
  currentMatches = syncResult.updatedMatches;

  const standings = normalizeStandings(standingsApi.standings || []);
  const { groupSlots, bestThirds } = buildGroupSlots(standings);
  const resolutionResult = await resolveKnockoutMatches(db, currentMatches, groupSlots, bestThirds);
  currentMatches = resolutionResult.matches;

  const ranking = buildRanking(currentMatches, bets, users);
  await Promise.all([
    db.collection('ranking').doc('current').set({ rows: ranking, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
    db.collection('tournament').doc('groups').set({ standings, updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
    db.collection('tournament').doc('knockout').set({ bracket: buildBracketPayload(currentMatches), updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
  ]);

  const matchesToNotify = currentMatches.filter((match) => hasFinalResult(match) && `${match.resultHome}-${match.resultAway}` !== match.lastNotifiedResult);

  if (!APPS_SCRIPT_WEBAPP_URL || !APPS_SCRIPT_SHARED_TOKEN) {
    console.log(`Sync completa. Cambios detectados por API: ${syncResult.changedMatches.length}. Partidos revisados para aviso: ${matchesToNotify.length}`);
    return;
  }

  const usersByUid = new Map(users.map((u) => [u.uid || u.id, u]));
  for (const match of matchesToNotify) {
    const matchBets = bets.filter((bet) => bet.matchId === match.id);
    if (!matchBets.length) {
      await markNotified(db, match);
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
    if (notifications.length) await sendViaAppsScript({ notifications });
    await markNotified(db, match);
  }

  console.log(`Sync completa. Cambios detectados por API: ${syncResult.changedMatches.length}. Partidos revisados para aviso: ${matchesToNotify.length}`);
}

async function upsertSeedMatches(db, seedMatches) {
  const batch = db.batch();
  seedMatches.forEach((match) => batch.set(db.collection('matches').doc(match.id), { ...match, updatedAt: FieldValue.serverTimestamp() }, { merge: true }));
  await batch.commit();
}

function normalizeGroupSeeds(seed) {
  return seed.map((match) => normalizeMatch({ ...match, stage: 'Fase de grupos', stageOrder: 1, kickoffAtMs: Date.parse(match.kickoffAt) }));
}

function normalizeKnockoutSeeds(seed) {
  return seed.map((match) => normalizeMatch({ ...match, homeTeam: match.slotHome, awayTeam: match.slotAway, kickoffAtMs: Date.parse(match.kickoffAt) }));
}

async function syncMatchesFromApi(db, currentMatches, apiMatches) {
  const updatedMatches = currentMatches.map((match) => ({ ...match }));
  const updatedIndex = new Map(updatedMatches.map((match) => [match.id, match]));
  const changedMatches = [];
  const batch = db.batch();
  let writes = 0;

  const byExternal = new Map();
  const groupByComposite = new Map();
  const knockoutByStage = new Map();

  currentMatches.forEach((match) => {
    if (Number.isInteger(match.externalMatchId)) byExternal.set(match.externalMatchId, match);
    if (match.stage === 'Fase de grupos') groupByComposite.set(buildCompositeKey(match.homeTeam, match.awayTeam, match.kickoffAt), match);
    else {
      if (!knockoutByStage.has(match.stage)) knockoutByStage.set(match.stage, []);
      knockoutByStage.get(match.stage).push(match);
    }
  });
  knockoutByStage.forEach((list) => list.sort((a, b) => a.sortOrder - b.sortOrder));

  const groupedApiKnockout = new Map();
  for (const apiMatch of apiMatches) {
    const stage = normalizeApiStage(apiMatch.stage);
    if (!stage || stage === 'Fase de grupos') continue;
    if (!groupedApiKnockout.has(stage)) groupedApiKnockout.set(stage, []);
    groupedApiKnockout.get(stage).push(apiMatch);
  }
  groupedApiKnockout.forEach((list) => list.sort((a, b) => Date.parse(a.utcDate || 0) - Date.parse(b.utcDate || 0) || Number(a.id || 0) - Number(b.id || 0)));

  for (const apiMatch of apiMatches) {
    const stage = normalizeApiStage(apiMatch.stage);
    if (stage !== 'Fase de grupos') continue;
    const extId = Number(apiMatch?.id);
    const kickoffAt = apiMatch?.utcDate || null;
    const homeTeam = normalizeApiTeam(apiMatch?.homeTeam?.name);
    const awayTeam = normalizeApiTeam(apiMatch?.awayTeam?.name);
    const resultHome = toNullableInt(apiMatch?.score?.fullTime?.home);
    const resultAway = toNullableInt(apiMatch?.score?.fullTime?.away);
    const status = mapApiStatus(apiMatch?.status, resultHome, resultAway);
    const existing = byExternal.get(extId) || groupByComposite.get(buildCompositeKey(homeTeam, awayTeam, kickoffAt));
    if (!existing) continue;
    const local = updatedIndex.get(existing.id);
    if (applyApiToMatch(local, apiMatch, stage)) {
      writes += 1;
      changedMatches.push(local);
      batch.set(db.collection('matches').doc(local.id), buildApiPatch(local), { merge: true });
    }
  }

  for (const [stage, apiList] of groupedApiKnockout.entries()) {
    const localList = knockoutByStage.get(stage) || [];
    apiList.forEach((apiMatch, index) => {
      const extId = Number(apiMatch?.id);
      let local = byExternal.get(extId);
      if (!local) local = localList[index];
      if (!local) return;
      const target = updatedIndex.get(local.id);
      if (applyApiToMatch(target, apiMatch, stage)) {
        writes += 1;
        changedMatches.push(target);
        batch.set(db.collection('matches').doc(target.id), buildApiPatch(target), { merge: true });
      }
    });
  }

  if (writes) await batch.commit();
  return { updatedMatches, changedMatches };
}

function applyApiToMatch(local, apiMatch, stage) {
  const next = {
    externalMatchId: Number(apiMatch?.id),
    stage,
    stageOrder: STAGE_META[stage]?.stageOrder || local.stageOrder,
    kickoffAt: apiMatch?.utcDate || local.kickoffAt,
    kickoffAtMs: Date.parse(apiMatch?.utcDate || local.kickoffAt),
    dateKey: (apiMatch?.utcDate || local.kickoffAt).slice(0, 10),
    venue: apiMatch?.venue || local.venue || 'Por definir',
    homeTeam: normalizeApiTeam(apiMatch?.homeTeam?.name) || local.homeTeam,
    awayTeam: normalizeApiTeam(apiMatch?.awayTeam?.name) || local.awayTeam,
    resultHome: toNullableInt(apiMatch?.score?.fullTime?.home),
    resultAway: toNullableInt(apiMatch?.score?.fullTime?.away),
    status: mapApiStatus(apiMatch?.status, toNullableInt(apiMatch?.score?.fullTime?.home), toNullableInt(apiMatch?.score?.fullTime?.away)),
  };
  const changed = ['externalMatchId','stage','stageOrder','kickoffAt','kickoffAtMs','dateKey','venue','homeTeam','awayTeam','resultHome','resultAway','status'].some((key) => JSON.stringify(local[key]) !== JSON.stringify(next[key]));
  if (!changed) return false;
  Object.assign(local, next);
  return true;
}

function buildApiPatch(match) {
  return {
    externalMatchId: match.externalMatchId,
    stage: match.stage,
    stageOrder: match.stageOrder,
    kickoffAt: match.kickoffAt,
    kickoffAtMs: match.kickoffAtMs,
    dateKey: match.dateKey,
    venue: match.venue,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    resultHome: match.resultHome,
    resultAway: match.resultAway,
    status: match.status,
    lastSyncedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

async function resolveKnockoutMatches(db, currentMatches, groupSlots, bestThirds) {
  const matches = currentMatches.map((match) => ({ ...match }));
  const byId = new Map(matches.map((match) => [match.id, match]));
  const usedThirdGroups = new Set();
  const batch = db.batch();
  let writes = 0;

  const ordered = matches.filter((match) => match.stage !== 'Fase de grupos').sort((a, b) => a.stageOrder - b.stageOrder || a.sortOrder - b.sortOrder);
  for (const match of ordered) {
    const desiredHome = resolveSlot(match.slotHome, byId, groupSlots, bestThirds, usedThirdGroups);
    const desiredAway = resolveSlot(match.slotAway, byId, groupSlots, bestThirds, usedThirdGroups);
    const patch = {};
    if (!hasConcreteTeam(match.homeTeam) || hasPlaceholderLike(match.homeTeam)) patch.homeTeam = desiredHome;
    if (!hasConcreteTeam(match.awayTeam) || hasPlaceholderLike(match.awayTeam)) patch.awayTeam = desiredAway;
    if (patch.homeTeam || patch.awayTeam) {
      Object.assign(match, patch);
      writes += 1;
      batch.set(db.collection('matches').doc(match.id), { ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  }

  if (writes) await batch.commit();
  return { matches };
}

function resolveSlot(slot, byId, groupSlots, bestThirds, usedThirdGroups) {
  if (!slot) return 'Por definir';
  if (/^[12]º Grupo /i.test(slot)) return groupSlots[slot] || slot;
  if (/^Mejor 3º /i.test(slot)) return resolveBestThird(slot, bestThirds, usedThirdGroups) || slot;
  if (/^Ganador /i.test(slot)) {
    const ref = byId.get(slot.replace('Ganador ', '').trim());
    return getWinner(ref) || slot;
  }
  if (/^Perdedor /i.test(slot)) {
    const ref = byId.get(slot.replace('Perdedor ', '').trim());
    return getLoser(ref) || slot;
  }
  return slot;
}

function resolveBestThird(slot, bestThirds, usedThirdGroups) {
  const allowed = slot.replace('Mejor 3º ', '').split('/').map((item) => item.trim());
  const candidate = bestThirds.find((team) => allowed.includes(team.group) && !usedThirdGroups.has(team.group));
  if (!candidate) return null;
  usedThirdGroups.add(candidate.group);
  return candidate.team;
}

function normalizeStandings(standings) {
  return standings.map((entry) => ({
    group: normalizeGroupCode(entry.group || entry.stage || ''),
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
  })).filter((entry) => entry.group);
}

function buildGroupSlots(standings) {
  const groupSlots = {};
  const thirds = [];
  standings.forEach((entry) => {
    const letter = entry.group;
    const sorted = [...entry.table].sort((a, b) => a.position - b.position);
    if (sorted[0]) groupSlots[`1º Grupo ${letter}`] = sorted[0].team;
    if (sorted[1]) groupSlots[`2º Grupo ${letter}`] = sorted[1].team;
    if (sorted[2]) thirds.push({ group: letter, team: sorted[2].team, points: sorted[2].points, gd: sorted[2].goalDifference, gf: sorted[2].goalsFor });
  });
  const bestThirds = thirds.sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.team.localeCompare(b.team, 'es')).slice(0, 8);
  return { groupSlots, bestThirds };
}

function buildRanking(matches, bets, users) {
  const matchById = new Map(matches.map((match) => [match.id, match]));
  return users.map((user) => {
    const uid = user.uid || user.id;
    const userBets = bets.filter((bet) => bet.uid === uid);
    let points = 0;
    let exact = 0;
    let outcomes = 0;
    for (const bet of userBets) {
      const match = matchById.get(bet.matchId);
      if (!match || !hasFinalResult(match)) continue;
      const betPoints = calculatePointsForBet(bet, match);
      points += betPoints;
      if (bet.home === match.resultHome && bet.away === match.resultAway) exact += 1;
      if (getOutcome(bet.home, bet.away) === getOutcome(match.resultHome, match.resultAway)) outcomes += 1;
    }
    return { uid, name: user.displayName || user.email || 'Usuario', email: user.email || '', points, exact, outcomes, bets: userBets.length };
  }).sort((a, b) => b.points - a.points || b.exact - a.exact || b.outcomes - a.outcomes || a.name.localeCompare(b.name, 'es'));
}

function calculatePointsForBet(bet, match) {
  if (!hasFinalResult(match)) return 0;
  if (bet.home === match.resultHome && bet.away === match.resultAway) return STAGE_META[match.stage]?.exactPoints || 4;
  if (getOutcome(bet.home, bet.away) === getOutcome(match.resultHome, match.resultAway)) return 2;
  return 1;
}

function buildBracketPayload(matches) {
  return Object.keys(STAGE_META).filter((stage) => STAGE_META[stage].stageOrder > 1).map((stage) => ({
    stage,
    matches: matches.filter((match) => match.stage === stage).sort((a, b) => a.sortOrder - b.sortOrder).map((match) => ({
      id: match.id,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      resultHome: match.resultHome,
      resultAway: match.resultAway,
      kickoffAt: match.kickoffAt,
      dateKey: match.dateKey,
    })),
  }));
}

async function sendViaAppsScript(payload) {
  const response = await fetch(APPS_SCRIPT_WEBAPP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: APPS_SCRIPT_SHARED_TOKEN, ...payload }),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_error) { throw new Error(`Apps Script devolvió una respuesta no JSON: ${text}`); }
  if (!response.ok || !data.ok) throw new Error(`Apps Script rechazó la petición: ${text}`);
  console.log('Apps Script response:', text);
}

async function markNotified(db, match) {
  await db.collection('matches').doc(match.id).set({
    lastNotifiedResult: `${match.resultHome}-${match.resultAway}`,
    lastNotifiedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

function buildEmailHtml({ user, match, bet, points, row, position, ranking }) {
  const exactValue = STAGE_META[match.stage]?.exactPoints || 4;
  const top = ranking.slice(0, 5).map((r, i) => `<li>${i + 1}. ${escapeHtml(r.name)} · ${r.points} pts</li>`).join('');
  const cta = SITE_URL ? `<p><a href="${SITE_URL}" target="_blank" rel="noreferrer">Abrir El Prode Mundialista</a></p>` : '';
  return `<div style="font-family:Arial,sans-serif;color:#14314f;line-height:1.55"><h2 style="margin:0 0 12px">El Prode Mundialista</h2><p>Hola <strong>${escapeHtml(user.displayName || user.email || 'usuario')}</strong>, ya se actualizó un partido.</p><p><strong>${escapeHtml(match.homeTeam)} ${match.resultHome}-${match.resultAway} ${escapeHtml(match.awayTeam)}</strong></p><p>Tu apuesta fue <strong>${bet.home}-${bet.away}</strong> y sumaste <strong>${points} ${points === 1 ? 'punto' : 'puntos'}</strong>.</p><p>Regla aplicada en ${escapeHtml(match.stage)}: exacto = ${exactValue}, signo = 2, fallo con apuesta = 1, sin jugar = 0.</p><p>Ahora estás en la posición <strong>#${position}</strong> con <strong>${row?.points || 0} pts</strong>.</p><h3 style="margin:20px 0 8px">Clasificación actual</h3><ol style="padding-left:20px;margin:0">${top}</ol>${cta}</div>`;
}

function buildEmailText({ user, match, bet, points, row, position, ranking }) {
  const exactValue = STAGE_META[match.stage]?.exactPoints || 4;
  return [
    'El Prode Mundialista',
    '',
    `Hola ${user.displayName || user.email || 'usuario'}, ya se actualizó un partido.`,
    `${match.homeTeam} ${match.resultHome}-${match.resultAway} ${match.awayTeam}`,
    `Tu apuesta: ${bet.home}-${bet.away}`,
    `Puntos ganados: ${points}`,
    `Regla aplicada en ${match.stage}: exacto=${exactValue}, signo=2, fallo con apuesta=1, sin jugar=0`,
    `Posición actual: #${position}`,
    `Puntos totales: ${row?.points || 0}`,
    '',
    'Clasificación actual:',
    ...ranking.slice(0, 5).map((r, i) => `${i + 1}. ${r.name} · ${r.points} pts`),
    SITE_URL ? `Abrir app: ${SITE_URL}` : ''
  ].join('\n');
}

function hasFinalResult(match) { return Number.isInteger(match.resultHome) && Number.isInteger(match.resultAway); }
function getOutcome(home, away) { return home > away ? 'home' : home < away ? 'away' : 'draw'; }
function hasConcreteTeam(name) { return !!name && !hasPlaceholderLike(name); }
function hasPlaceholderLike(name) { return /^(1º|2º|Mejor 3º|Ganador|Perdedor|Por definir)/i.test(String(name || '')); }
function getWinner(match) { if (!match || !hasFinalResult(match)) return null; if (match.resultHome > match.resultAway) return match.homeTeam; if (match.resultAway > match.resultHome) return match.awayTeam; return `${match.homeTeam} / ${match.awayTeam}`; }
function getLoser(match) { if (!match || !hasFinalResult(match)) return null; if (match.resultHome < match.resultAway) return match.homeTeam; if (match.resultAway < match.resultHome) return match.awayTeam; return `${match.homeTeam} / ${match.awayTeam}`; }

function normalizeMatch(raw) {
  const stage = raw.stage || 'Fase de grupos';
  const stageMeta = STAGE_META[stage] || STAGE_META['Fase de grupos'];
  const kickoffAt = raw.kickoffAt || `${raw.dateKey || '2026-06-11'}T12:00:00Z`;
  return {
    ...raw,
    stage,
    stageOrder: Number.isInteger(raw.stageOrder) ? raw.stageOrder : stageMeta.stageOrder,
    group: raw.group || '',
    homeTeam: raw.homeTeam || raw.slotHome || raw.home || 'Por definir',
    awayTeam: raw.awayTeam || raw.slotAway || raw.away || 'Por definir',
    slotHome: raw.slotHome || raw.home || null,
    slotAway: raw.slotAway || raw.away || null,
    kickoffAt,
    kickoffAtMs: raw.kickoffAtMs || Date.parse(kickoffAt),
    dateKey: raw.dateKey || kickoffAt.slice(0, 10),
    venue: raw.venue || 'Por definir',
    sortOrder: Number.isInteger(raw.sortOrder) ? raw.sortOrder : 999,
    resultHome: Number.isInteger(raw.resultHome) ? raw.resultHome : null,
    resultAway: Number.isInteger(raw.resultAway) ? raw.resultAway : null,
    status: raw.status || 'scheduled',
  };
}

function normalizeApiStage(stage) {
  const value = String(stage || '').toUpperCase();
  if (!value || value.includes('GROUP')) return 'Fase de grupos';
  for (const [name, meta] of Object.entries(STAGE_META)) {
    if ((meta.apiAliases || []).includes(value)) return name;
  }
  return null;
}

function normalizeApiTeam(name) {
  const n = String(name || '').trim();
  const aliases = {
    'United States': 'Estados Unidos', 'USA': 'Estados Unidos', 'Korea Republic': 'Corea del Sur', 'Czechia': 'Chequia', 'Netherlands': 'Países Bajos',
    'IR Iran': 'Irán', 'Ivory Coast': 'Costa de Marfil', 'DR Congo': 'RD Congo', 'Cape Verde': 'Cabo Verde', 'Saudi Arabia': 'Arabia Saudita',
    'New Zealand': 'Nueva Zelanda', 'Bosnia-Herzegovina': 'Bosnia y Herzegovina', 'Scotland': 'Escocia', 'England': 'Inglaterra'
  };
  if (!n || /TBD|TO BE DETERMINED|WINNER|RUNNER-UP/i.test(n)) return '';
  return aliases[n] || n;
}

function normalizeGroupCode(value) {
  const raw = String(value || '').toUpperCase();
  const match = raw.match(/([A-L])$/);
  return match ? match[1] : '';
}

function toNullableInt(value) { return Number.isInteger(value) ? Number(value) : null; }
function mapApiStatus(apiStatus, home, away) { if (Number.isInteger(home) && Number.isInteger(away)) return 'played'; if (['IN_PLAY', 'PAUSED', 'LIVE'].includes(apiStatus)) return 'in_play'; return 'scheduled'; }
function buildCompositeKey(homeTeam, awayTeam, kickoffAt) { return `${String(homeTeam || '').trim().toLowerCase()}__${String(awayTeam || '').trim().toLowerCase()}__${kickoffAt || ''}`; }
function parseJsonEnv(name) { const raw = process.env[name]; return raw ? JSON.parse(raw) : null; }
async function readJsonFile(path) { const raw = await readFile(path, 'utf-8'); return JSON.parse(raw); }
async function fetchJson(url, apiKey) { const response = await fetch(url, { headers: { 'X-Auth-Token': apiKey } }); if (!response.ok) throw new Error(`Error ${response.status} consultando ${url}: ${await response.text()}`); return response.json(); }
function escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
