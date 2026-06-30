import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const WRITE_DETAIL = args.includes('--write-detail');

function parseJsonEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable ${name}`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`La variable ${name} no contiene un JSON válido`);
  }
}

function norm(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' y ')
    .replace(/\./g, '')
    .replace(/países bajos/gi, 'paises bajos')
    .replace(/netherlands/gi, 'paises bajos')
    .replace(/south africa/gi, 'sudafrica')
    .replace(/czechia/gi, 'chequia')
    .replace(/czech republic/gi, 'chequia')
    .replace(/bosnia and herzegovina/gi, 'bosnia y herzegovina')
    .replace(/dr congo/gi, 'rd congo')
    .replace(/congo dr/gi, 'rd congo')
    .replace(/morocco/gi, 'marruecos')
    .replace(/japan/gi, 'japon')
    .replace(/brazil/gi, 'brasil')
    .replace(/germany/gi, 'alemania')
    .replace(/paraguay/gi, 'paraguay')
    .replace(/canada/gi, 'canada')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function numberFrom(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

function matchResult(match) {
  const resultHome = numberFrom(match.resultHome, match.homeResult, match.homeGoals, match.scoreHome);
  const resultAway = numberFrom(match.resultAway, match.awayResult, match.awayGoals, match.scoreAway);

  if (!Number.isInteger(resultHome) || !Number.isInteger(resultAway)) return null;

  return { resultHome, resultAway };
}

function hasResult(match) {
  return Boolean(matchResult(match));
}

function getMs(match) {
  if (typeof match.kickoffAtMs === 'number') return match.kickoffAtMs;

  if (match.kickoffAt) {
    const ms = Date.parse(match.kickoffAt);
    if (!Number.isNaN(ms)) return ms;
  }

  if (match.dateKey) {
    const ms = Date.parse(`${match.dateKey}T12:00:00Z`);
    if (!Number.isNaN(ms)) return ms;
  }

  return 0;
}

function getBetScores(bet) {
  return {
    home: numberFrom(
      bet.home,
      bet.homeScore,
      bet.scoreHome,
      bet.predHome,
      bet.predictionHome,
      bet.resultHome,
      bet.homeGoals,
      bet.goalsHome,
      bet.local,
      bet.h
    ),
    away: numberFrom(
      bet.away,
      bet.awayScore,
      bet.scoreAway,
      bet.predAway,
      bet.predictionAway,
      bet.resultAway,
      bet.awayGoals,
      bet.goalsAway,
      bet.visitante,
      bet.a
    ),
  };
}

function stageExactValue(stage) {
  const values = {
    'Fase de grupos': 4,
    'Dieciseisavos': 5,
    'Octavos': 6,
    'Cuartos': 7,
    'Semifinales': 8,
    '3º puesto': 8,
    'Tercer puesto': 8,
    'Final': 9,
  };

  return values[stage] || 4;
}

function computePoints(match, bet) {
  const real = matchResult(match);
  if (!real) return null;

  const predicted = getBetScores(bet);
  if (!Number.isInteger(predicted.home) || !Number.isInteger(predicted.away)) {
    return null;
  }

  const exact = predicted.home === real.resultHome && predicted.away === real.resultAway;

  if (exact) {
    return {
      points: stageExactValue(match.stage),
      exact: true,
      secondary: false,
      label: 'exacto',
      betHome: predicted.home,
      betAway: predicted.away,
      resultHome: real.resultHome,
      resultAway: real.resultAway,
    };
  }

  const realSign = Math.sign(real.resultHome - real.resultAway);
  const betSign = Math.sign(predicted.home - predicted.away);

  // Regla segura:
  // - Acierta ganador o empate => 2 puntos.
  // - En eliminatorias, empate real 1-1 y apuesta 2-2 => +2.
  // - No se exige clasificado para no convertir un empate acertado en fallo.
  if (realSign === betSign) {
    return {
      points: 2,
      exact: false,
      secondary: true,
      label: 'signo/acierto',
      betHome: predicted.home,
      betAway: predicted.away,
      resultHome: real.resultHome,
      resultAway: real.resultAway,
    };
  }

  return {
    points: 1,
    exact: false,
    secondary: false,
    label: 'fallo con apuesta',
    betHome: predicted.home,
    betAway: predicted.away,
    resultHome: real.resultHome,
    resultAway: real.resultAway,
  };
}

function guessMatchId(docId, bet, matchIds) {
  const direct = bet.matchId || bet.matchRef || bet.match_id || bet.idPartido || bet.partidoId;

  if (direct && matchIds.has(String(direct))) return String(direct);
  if (bet.match && matchIds.has(String(bet.match))) return String(bet.match);

  for (const id of matchIds) {
    if (docId === id || docId.includes(id)) return id;
  }

  return direct ? String(direct) : null;
}

function guessUserId(docId, bet, userIds) {
  const direct = bet.userId || bet.uid || bet.userRef || bet.idUsuario || bet.usuarioId;

  if (direct && userIds.has(String(direct))) return String(direct);

  for (const id of userIds) {
    if (docId === id || docId.includes(id)) return id;
  }

  return direct ? String(direct) : null;
}

async function main() {
  const serviceAccount = parseJsonEnv('FIREBASE_SERVICE_ACCOUNT_JSON');

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  const db = admin.firestore();

  const [usersSnap, matchesSnap, betsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('matches').get(),
    db.collection('bets').get(),
  ]);

  const users = usersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const matches = matchesSnap.docs
    .map((doc) => ({ id: doc.id, ...doc.data(), _ms: getMs(doc.data()) }))
    .sort((a, b) => a._ms - b._ms || String(a.id).localeCompare(String(b.id)));

  const matchMap = new Map(matches.map((match) => [match.id, match]));
  const matchIds = new Set(matches.map((match) => match.id));
  const userIds = new Set(users.map((user) => user.id));

  const scoreboard = new Map();

  for (const user of users) {
    scoreboard.set(user.id, {
      userId: user.id,
      name: user.displayName || user.name || user.email || user.id,
      email: user.email || '',
      points: 0,
      exacts: 0,
      secondaries: 0,
      played: 0,

      // aliases para el frontend actual
      exactos: 0,
      aciertos: 0,
      pronosticos: 0,
    });
  }

  let scoredBets = 0;
  let ignoredBets = 0;
  const details = [];

  for (const doc of betsSnap.docs) {
    const bet = doc.data();
    const userId = guessUserId(doc.id, bet, userIds);
    const matchId = guessMatchId(doc.id, bet, matchIds);

    if (!userId || !matchId) {
      ignoredBets += 1;
      continue;
    }

    const match = matchMap.get(matchId);

    if (!match || !hasResult(match)) {
      ignoredBets += 1;
      continue;
    }

    const result = computePoints(match, bet);

    if (!result) {
      ignoredBets += 1;
      continue;
    }

    if (!scoreboard.has(userId)) {
      scoreboard.set(userId, {
        userId,
        name: userId,
        email: '',
        points: 0,
        exacts: 0,
        secondaries: 0,
        played: 0,
        exactos: 0,
        aciertos: 0,
        pronosticos: 0,
      });
    }

    const row = scoreboard.get(userId);

    row.points += result.points;
    row.played += 1;
    row.pronosticos += 1;

    if (result.exact) {
      row.exacts += 1;
      row.exactos += 1;
    }

    if (result.secondary) {
      row.secondaries += 1;
      row.aciertos += 1;
    }

    scoredBets += 1;

    if (WRITE_DETAIL) {
      details.push({
        userId,
        userName: row.name,
        matchId,
        stage: match.stage || '',
        homeTeam: match.homeTeam || '',
        awayTeam: match.awayTeam || '',
        resultHome: result.resultHome,
        resultAway: result.resultAway,
        betHome: result.betHome,
        betAway: result.betAway,
        points: result.points,
        label: result.label,
      });
    }
  }

  const rows = [...scoreboard.values()].sort((a, b) => {
    return (
      b.points - a.points ||
      b.exacts - a.exacts ||
      b.secondaries - a.secondaries ||
      a.name.localeCompare(b.name)
    );
  });

  rows.forEach((row, index) => {
    row.position = index + 1;
  });

  console.log('🏆 Ranking recalculado desde Firestore');
  for (const row of rows) {
    console.log(
      `${row.position}. ${row.name} · ${row.points} pts · ` +
      `exactos ${row.exactos} · aciertos ${row.aciertos} · pronósticos ${row.pronosticos}`
    );
  }

  console.log('');
  console.log(`- Usuarios: ${users.length}`);
  console.log(`- Partidos totales: ${matches.length}`);
  console.log(`- Partidos con resultHome/resultAway: ${matches.filter(hasResult).length}`);
  console.log(`- Apuestas leídas: ${betsSnap.docs.length}`);
  console.log(`- Apuestas puntuadas: ${scoredBets}`);
  console.log(`- Apuestas ignoradas/no puntuables: ${ignoredBets}`);

  if (WRITE_DETAIL) {
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync(
      path.join('reports', 'ranking-detail-safe-recalculate.json'),
      JSON.stringify(details, null, 2),
      'utf8'
    );
    console.log('- Detalle escrito en reports/ranking-detail-safe-recalculate.json');
  }

  if (!APPLY) {
    console.log('');
    console.log('Modo dry-run: no se escribió nada. Usa --apply para guardar ranking/current.');
    return;
  }

  await db.collection('ranking').doc('current').set(
    {
      rows,
      totalUsers: rows.length,
      totalMatches: matches.length,
      matchesWithResult: matches.filter(hasResult).length,
      scoredBets,
      ignoredBets,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: 'safe-recalculate-no-result-fetch-v2',
    },
    { merge: true }
  );

  console.log('');
  console.log('✅ ranking/current guardado en Firestore.');
  console.log('✅ No se consultó ninguna API externa.');
  console.log('✅ No se modificó ningún resultado en matches.');
}

main().catch((error) => {
  console.error('❌ Error:', error.message);
  process.exit(1);
});
