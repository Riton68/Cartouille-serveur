/**
 * INTERFACE DE TEST EN LIGNE DE COMMANDE
 * ---------------------------------------
 * Permet de jouer une vraie partie dans le terminal, contre 3 bots,
 * pour valider "à la main" que les règles fonctionnent comme prévu.
 *
 * Lancer avec : node jouer-cli.js
 */

'use strict';

const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const moteur = require('./moteur-jeu-cartes');

const rl = readline.createInterface({ input, output });

const COULEURS = ['pique', 'coeur', 'carreau', 'trefle'];
const HUMAIN = 'Vous';
const BOTS = ['Bob', 'Chloé', 'David'];

// ---------------------------------------------------------------------------
// AFFICHAGE
// ---------------------------------------------------------------------------

function nomCarte(carte) {
  if (carte.valeur === 'joker') return '🃏 Joker';
  const valeurs = { valet: 'Valet', dame: 'Dame', roi: 'Roi', as: 'As' };
  const v = valeurs[carte.valeur] || carte.valeur;
  return `${v} de ${carte.couleur}`;
}

function afficherEtat(state) {
  const top = state.defausse[state.defausse.length - 1];
  console.log('\n' + '─'.repeat(50));
  console.log(`Manche ${state.manche} | Carte du dessus : ${nomCarte(top)}`);
  console.log(`Couleur active : ${state.couleurActive}`);
  console.log('Scores :', Object.entries(moteur.scoresActuels(state))
    .map(([id, s]) => `${id}=${s}`).join('  '));
  console.log('Cartes en main :', state.ordreJoueurs
    .map((id) => `${id}(${state.joueurs[id].main.length})`).join('  '));
  console.log('─'.repeat(50));
}

function afficherMain(main) {
  main.forEach((carte, i) => console.log(`  [${i}] ${nomCarte(carte)}`));
}

// ---------------------------------------------------------------------------
// LOGIQUE DES BOTS (stratégie simple)
// ---------------------------------------------------------------------------

function couleurLaPlusFrequente(main) {
  const compte = {};
  for (const c of main) {
    if (c.couleur) compte[c.couleur] = (compte[c.couleur] || 0) + 1;
  }
  let meilleure = COULEURS[0];
  let max = -1;
  for (const c of COULEURS) {
    if ((compte[c] || 0) > max) { max = compte[c] || 0; meilleure = c; }
  }
  return meilleure;
}

function jouerTourBot(state, botId) {
  const joueur = state.joueurs[botId];
  const top = state.defausse[state.defausse.length - 1];
  let jouables = moteur.cartesJouables(joueur.main, top, state.couleurActive);

  if (jouables.length === 0) {
    const res = moteur.piocherCarte(state, botId);
    console.log(`${botId} pioche une carte.`);
    if (!res.jouableMaintenant) {
      console.log(`${botId} ne peut pas jouer, tour suivant.`);
      return;
    }
    jouables = [res.carte];
  }

  // Stratégie : garder les cartes spéciales (Joker/9) pour la fin si possible
  const normales = jouables.filter((c) => c.valeur !== 'joker' && c.valeur !== 9);
  const carte = normales.length > 0 ? normales[0] : jouables[0];
  const couleurDemandee = (carte.valeur === 'joker' || carte.valeur === 9)
    ? couleurLaPlusFrequente(joueur.main.filter((c) => c.id !== carte.id))
    : undefined;

  const resultat = moteur.jouerCarte(state, botId, carte.id, couleurDemandee);
  console.log(`${botId} joue : ${nomCarte(carte)}` + (couleurDemandee ? ` (demande ${couleurDemandee})` : ''));
  return resultat;
}

// ---------------------------------------------------------------------------
// TOUR DU JOUEUR HUMAIN
// ---------------------------------------------------------------------------

async function demanderCouleur() {
  while (true) {
    const rep = (await rl.question(`Quelle couleur demandez-vous ? (${COULEURS.join('/')}) `)).trim().toLowerCase();
    if (COULEURS.includes(rep)) return rep;
    console.log('Couleur invalide, réessayez.');
  }
}

async function jouerTourHumain(state) {
  const joueur = state.joueurs[HUMAIN];
  const top = state.defausse[state.defausse.length - 1];
  const jouables = moteur.cartesJouables(joueur.main, top, state.couleurActive);

  console.log('\nVotre main :');
  afficherMain(joueur.main);

  if (jouables.length === 0) {
    await rl.question('Aucune carte jouable. Appuyez sur Entrée pour piocher...');
    const res = moteur.piocherCarte(state, HUMAIN);
    console.log(`Vous piochez : ${nomCarte(res.carte)}`);
    if (!res.jouableMaintenant) {
      console.log('Cette carte n\'est pas jouable, votre tour est terminé.');
      return;
    }
    const jouer = (await rl.question('Voulez-vous la jouer ? (o/n) ')).trim().toLowerCase();
    if (jouer !== 'o') {
      moteur.passerTour(state, HUMAIN);
      console.log('Vous passez votre tour.');
      return;
    }
    const couleurDemandee = (res.carte.valeur === 'joker' || res.carte.valeur === 9)
      ? await demanderCouleur() : undefined;
    return moteur.jouerCarte(state, HUMAIN, res.carte.id, couleurDemandee);
  }

  while (true) {
    const rep = await rl.question('Quelle carte jouer ? (numéro) ');
    const index = parseInt(rep, 10);
    const carte = joueur.main[index];
    if (!carte) { console.log('Numéro invalide.'); continue; }
    if (!moteur.carteEstJouable(carte, top, state.couleurActive)) {
      console.log('Cette carte n\'est pas jouable ici.');
      continue;
    }
    const couleurDemandee = (carte.valeur === 'joker' || carte.valeur === 9)
      ? await demanderCouleur() : undefined;
    return moteur.jouerCarte(state, HUMAIN, carte.id, couleurDemandee);
  }
}

// ---------------------------------------------------------------------------
// BOUCLE PRINCIPALE
// ---------------------------------------------------------------------------

async function jouerPartie() {
  console.log('=== Nouvelle partie : Vous contre Bob, Chloé et David ===');
  const state = moteur.initialiserPartie([HUMAIN, ...BOTS]);

  while (state.enCours) {
    afficherEtat(state);
    const idActuel = state.ordreJoueurs[state.tourIndex];

    let resultat;
    if (idActuel === HUMAIN) {
      resultat = await jouerTourHumain(state);
    } else {
      resultat = jouerTourBot(state, idActuel);
    }

    if (resultat && resultat.evenement === 'manche_terminee') {
      console.log(`\n🏁 Manche ${resultat.prochaineManche - 1} terminée ! Gagnée par ${resultat.gagnantManche}.`);
      console.log('Scores cumulés :', resultat.scores);
      await rl.question('Appuyez sur Entrée pour continuer...');
    } else if (resultat && resultat.evenement === 'partie_terminee') {
      console.log('\n🎉 PARTIE TERMINÉE 🎉');
      console.log('Perdant(s) :', resultat.perdants.join(', '));
      console.log('Scores finaux :', resultat.scores);
    }
  }

  rl.close();
}

jouerPartie().catch((err) => {
  console.error('Erreur :', err.message);
  rl.close();
});
