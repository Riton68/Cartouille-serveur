/**
 * MOTEUR DE JEU - Jeu de cartes original
 * -----------------------------------------
 * 42 cartes (40 classiques 5→As + 2 Jokers), 4 joueurs maxi.
 * Règles : voir résumé dans la conversation avec l'utilisateur.
 *
 * Ce fichier ne contient AUCUNE dépendance réseau : c'est le moteur pur,
 * destiné à tourner côté SERVEUR uniquement (jamais côté client, sinon
 * triche possible). On pourra le brancher sur Socket.io ensuite.
 */

'use strict';

// ---------------------------------------------------------------------------
// 1. CONSTANTES ET CRÉATION DU JEU DE CARTES
// ---------------------------------------------------------------------------

const COULEURS = ['pique', 'coeur', 'carreau', 'trefle'];
const VALEURS = [5, 6, 7, 8, 9, 10, 'valet', 'dame', 'roi', 'as'];

function creerJeuDeCartes() {
  const cartes = [];
  for (const couleur of COULEURS) {
    for (const valeur of VALEURS) {
      cartes.push({ id: `${valeur}_${couleur}`, valeur, couleur });
    }
  }
  cartes.push({ id: 'joker_1', valeur: 'joker', couleur: null });
  cartes.push({ id: 'joker_2', valeur: 'joker', couleur: null });
  return cartes; // 42 cartes
}

function melanger(cartes) {
  const jeu = [...cartes];
  for (let i = jeu.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [jeu[i], jeu[j]] = [jeu[j], jeu[i]];
  }
  return jeu;
}

function valeurPoints(carte) {
  if (carte.valeur === 'joker') return 20;
  if (carte.valeur === 'as') return 11;
  if (carte.valeur === 'roi') return 4;
  if (carte.valeur === 'dame') return 3;
  if (carte.valeur === 'valet') return 2;
  return carte.valeur; // 5 à 10 = valeur faciale
}

// ---------------------------------------------------------------------------
// 2. VALIDATION D'UN COUP (fonction critique, appelée côté serveur)
// ---------------------------------------------------------------------------

function estJoker(carte) { return carte.valeur === 'joker'; }
function est9(carte) { return carte.valeur === 9; }

function carteEstJouable(carteJouee, carteHaut, couleurActive) {
  if (estJoker(carteHaut)) {
    // Sur un Joker : ni Joker ni 9, seulement la couleur demandée
    if (estJoker(carteJouee) || est9(carteJouee)) return false;
    return carteJouee.couleur === couleurActive;
  }

  if (est9(carteHaut)) {
    // Sur un 9 : pas de Joker ; un 9 toujours possible ; sinon couleur demandée
    if (estJoker(carteJouee)) return false;
    if (est9(carteJouee)) return true;
    return carteJouee.couleur === couleurActive;
  }

  // Sur une carte normale : Joker et 9 toujours jouables
  if (estJoker(carteJouee) || est9(carteJouee)) return true;
  return carteJouee.couleur === carteHaut.couleur || carteJouee.valeur === carteHaut.valeur;
}

function cartesJouables(main, carteHaut, couleurActive) {
  return main.filter((carte) => carteEstJouable(carte, carteHaut, couleurActive));
}

// ---------------------------------------------------------------------------
// 3. INITIALISATION DE LA PARTIE / D'UNE MANCHE
// ---------------------------------------------------------------------------

function initialiserPartie(idsJoueurs) {
  if (idsJoueurs.length < 2 || idsJoueurs.length > 4) {
    throw new Error('La partie se joue de 2 à 4 joueurs.');
  }
  const state = {
    joueurs: Object.fromEntries(idsJoueurs.map((id) => [id, { id, main: [], score: 0 }])),
    ordreJoueurs: [...idsJoueurs],
    dealerIndex: 0,
    tourIndex: null, // fixé dans demarrerManche
    pioche: [],
    defausse: [],
    couleurActive: null,
    manche: 0,
    aPioche: false, // le joueur courant a-t-il déjà pioché ce tour ?
    enCours: true,
    perdants: [],
  };
  demarrerManche(state);
  return state;
}

function demarrerManche(state) {
  state.manche += 1;
  const nbJoueurs = state.ordreJoueurs.length;

  let deck = melanger(creerJeuDeCartes());

  // Distribution : 6 cartes par joueur
  for (const id of state.ordreJoueurs) {
    state.joueurs[id].main = deck.splice(0, 6);
  }

  // On retourne la première carte : on évite de démarrer sur un Joker
  // (règle maison raisonnable, à confirmer si besoin) pour ne pas bloquer
  // la manche dès le départ sans qu'aucun joueur n'ait pu agir.
  let carteDepart = deck.shift();
  while (estJoker(carteDepart)) {
    deck.push(carteDepart);
    deck = melanger(deck);
    carteDepart = deck.shift();
  }

  state.pioche = deck;
  state.defausse = [carteDepart];
  // Si la carte de départ est un 9, sa couleur "active" est simplement la sienne.
  state.couleurActive = carteDepart.couleur;

  // Le donneur ne joue pas en premier : c'est le joueur suivant qui commence.
  state.tourIndex = (state.dealerIndex + 1) % nbJoueurs;
  state.aPioche = false;
}

// ---------------------------------------------------------------------------
// 4. ACTIONS DE JEU
// ---------------------------------------------------------------------------

function joueurCourant(state) {
  return state.ordreJoueurs[state.tourIndex];
}

function carteHaut(state) {
  return state.defausse[state.defausse.length - 1];
}

function passerAuJoueurSuivant(state) {
  const nbJoueurs = state.ordreJoueurs.length;
  state.tourIndex = (state.tourIndex + 1) % nbJoueurs;
  state.aPioche = false;
}

function reconstituerPiocheSiVide(state) {
  if (state.pioche.length > 0) return;
  const derniere = state.defausse.pop(); // on garde la carte active de côté
  state.pioche = melanger(state.defausse);
  state.defausse = [derniere];
}

/**
 * Joue une carte pour le joueur donné.
 * @param {string} couleurDemandee - obligatoire si la carte jouée est un Joker ou un 9
 */
function jouerCarte(state, joueurId, carteId, couleurDemandee) {
  if (!state.enCours) throw new Error("La partie est terminée.");
  if (joueurCourant(state) !== joueurId) throw new Error("Ce n'est pas votre tour.");

  const joueur = state.joueurs[joueurId];
  const carte = joueur.main.find((c) => c.id === carteId);
  if (!carte) throw new Error("Cette carte n'est pas dans votre main.");

  if (!carteEstJouable(carte, carteHaut(state), state.couleurActive)) {
    throw new Error('Ce coup n\'est pas autorisé.');
  }

  const estDerniereCarte = joueur.main.length === 1;

  // Une couleur n'est exigée que si la partie continue après ce coup : si
  // c'est la dernière carte du joueur, la manche s'arrête immédiatement et
  // la couleur demandée ne servirait à personne.
  if ((estJoker(carte) || est9(carte)) && !estDerniereCarte) {
    if (!COULEURS.includes(couleurDemandee)) {
      throw new Error('Vous devez annoncer une couleur valide en jouant cette carte.');
    }
  }

  // On retire la carte de la main et on l'ajoute à la défausse
  joueur.main = joueur.main.filter((c) => c.id !== carteId);
  state.defausse.push(carte);
  if (!estDerniereCarte) {
    state.couleurActive = (estJoker(carte) || est9(carte)) ? couleurDemandee : carte.couleur;
  }

  // Fin de manche ?
  if (joueur.main.length === 0) {
    return terminerManche(state, joueurId, carte);
  }

  passerAuJoueurSuivant(state);
  return { evenement: 'carte_jouee', joueurId, carte };
}

/**
 * Le joueur courant pioche une carte. Autorisé à tout moment pendant son
 * tour, même s'il possède déjà une carte jouable en main (stratégie libre).
 */
function piocherCarte(state, joueurId) {
  if (!state.enCours) throw new Error('La partie est terminée.');
  if (joueurCourant(state) !== joueurId) throw new Error("Ce n'est pas votre tour.");
  if (state.aPioche) throw new Error('Vous avez déjà pioché ce tour.');

  const joueur = state.joueurs[joueurId];

  reconstituerPiocheSiVide(state);
  const carte = state.pioche.shift();
  joueur.main.push(carte);
  state.aPioche = true;

  const jouableMaintenant = carteEstJouable(carte, carteHaut(state), state.couleurActive);
  if (!jouableMaintenant) {
    // Le joueur ne peut pas la jouer : son tour s'arrête automatiquement.
    passerAuJoueurSuivant(state);
  }

  return { evenement: 'carte_piochee', joueurId, carte, jouableMaintenant };
}

/**
 * Si le joueur a pioché une carte jouable mais préfère ne pas la jouer.
 */
function passerTour(state, joueurId) {
  if (joueurCourant(state) !== joueurId) throw new Error("Ce n'est pas votre tour.");
  if (!state.aPioche) throw new Error('Vous devez piocher avant de pouvoir passer.');
  passerAuJoueurSuivant(state);
  return { evenement: 'tour_passe', joueurId };
}

// ---------------------------------------------------------------------------
// 5. FIN DE MANCHE / SCORES / FIN DE PARTIE
// ---------------------------------------------------------------------------

function terminerManche(state, gagnantId, derniereCarteJouee) {
  const bonusJokerFinal = estJoker(derniereCarteJouee);
  const pointsGagnesCetteManche = {};
  for (const id of state.ordreJoueurs) pointsGagnesCetteManche[id] = 0;

  for (const id of state.ordreJoueurs) {
    if (id === gagnantId) continue;
    const joueur = state.joueurs[id];
    let points = joueur.main.reduce((total, c) => total + valeurPoints(c), 0);
    if (bonusJokerFinal) points += 20;
    pointsGagnesCetteManche[id] = points;
    joueur.score += points;
  }

  const perdants = state.ordreJoueurs.filter((id) => state.joueurs[id].score > 100);

  // On capture le nombre de cartes qu'il restait à chacun À LA FIN de cette
  // manche (avant que la nouvelle donne ne remplace les mains).
  const cartesRestantes = {};
  for (const id of state.ordreJoueurs) cartesRestantes[id] = state.joueurs[id].main.length;

  if (perdants.length > 0) {
    state.enCours = false;
    state.perdants = perdants;
    return {
      evenement: 'partie_terminee',
      gagnantManche: gagnantId,
      perdants,
      scores: scoresActuels(state),
    };
  }

  // Manche suivante : rotation du donneur
  state.dealerIndex = (state.dealerIndex + 1) % state.ordreJoueurs.length;
  demarrerManche(state);

  return {
    evenement: 'manche_terminee',
    gagnantManche: gagnantId,
    scoresManche: pointsGagnesCetteManche, // points gagnés UNIQUEMENT sur cette manche (0 pour le gagnant)
    scores: scoresActuels(state), // scores cumulés, au cas où
    prochaineManche: state.manche,
    derniereCarte: derniereCarteJouee,
    cartesRestantes, // nombre de cartes de chacun à la fin de LA MANCHE QUI VIENT DE FINIR
  };
}

function scoresActuels(state) {
  return Object.fromEntries(state.ordreJoueurs.map((id) => [id, state.joueurs[id].score]));
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  creerJeuDeCartes,
  melanger,
  valeurPoints,
  carteEstJouable,
  cartesJouables,
  initialiserPartie,
  jouerCarte,
  piocherCarte,
  passerTour,
  scoresActuels,
};

// ---------------------------------------------------------------------------
// 6. SIMULATION DE TEST (exécuter avec : node moteur-jeu-cartes.js)
// ---------------------------------------------------------------------------

if (require.main === module) {
  console.log('=== Simulation automatique (4 joueurs, coups aléatoires) ===\n');

  const joueurs = ['Alice', 'Bob', 'Chloé', 'David'];
  const state = initialiserPartie(joueurs);

  let securite = 0; // évite toute boucle infinie en cas de bug
  while (state.enCours && securite < 5000) {
    securite += 1;
    const idActuel = joueurCourant(state);
    const joueur = state.joueurs[idActuel];
    const jouables = cartesJouables(joueur.main, carteHaut(state), state.couleurActive);

    if (jouables.length > 0) {
      const carte = jouables[Math.floor(Math.random() * jouables.length)];
      const couleurDemandee = (estJoker(carte) || est9(carte))
        ? COULEURS[Math.floor(Math.random() * COULEURS.length)]
        : undefined;
      const resultat = jouerCarte(state, idActuel, carte.id, couleurDemandee);

      if (resultat.evenement === 'manche_terminee') {
        console.log(
          `Manche ${resultat.prochaineManche - 1} terminée, gagnée par ${resultat.gagnantManche}.`
        );
        console.log('Scores cumulés :', resultat.scores, '\n');
      } else if (resultat.evenement === 'partie_terminee') {
        console.log('--- PARTIE TERMINÉE ---');
        console.log('Perdant(s) :', resultat.perdants.join(', '));
        console.log('Scores finaux :', resultat.scores);
      }
    } else {
      const resultat = piocherCarte(state, idActuel);
      if (resultat.jouableMaintenant) {
        // 50% de chances de jouer la carte piochée, sinon on passe
        if (Math.random() < 0.5) {
          const couleurDemandee = (estJoker(resultat.carte) || est9(resultat.carte))
            ? COULEURS[Math.floor(Math.random() * COULEURS.length)]
            : undefined;
          jouerCarte(state, idActuel, resultat.carte.id, couleurDemandee);
        } else {
          passerTour(state, idActuel);
        }
      }
    }
  }

  if (securite >= 5000) {
    console.log('Simulation arrêtée par sécurité (boucle trop longue) — vérifier la logique.');
  }
}
