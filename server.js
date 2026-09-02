/**
 * SERVEUR TEMPS RÉEL - Jeu de cartes multijoueur
 * ------------------------------------------------
 * Gère : création/rejoindre un salon via code, démarrage de partie,
 * actions de jeu, diffusion de l'état (vue privée par joueur),
 * et reconnexion en cas de coupure.
 *
 * Installation :
 *   npm init -y
 *   npm install express socket.io
 *
 * Lancement :
 *   node server.js
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { Server } = require('socket.io');
const moteur = require('./moteur-jeu-cartes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }, // à restreindre à votre domaine en production
});

const PORT = process.env.PORT || 3000;
const COULEURS = ['pique', 'coeur', 'carreau', 'trefle'];

// ---------------------------------------------------------------------------
// STOCKAGE EN MÉMOIRE DES PARTIES
// ---------------------------------------------------------------------------
// party = {
//   code, hostId, statut: 'lobby' | 'en_cours',
//   joueursInfo: { [joueurId]: { pseudo, socketId, connecte } },
//   ordreJoueurs: [joueurId, ...],  // ordre d'arrivée dans le lobby
//   state: <état du moteur, présent seulement si statut === 'en_cours'>
// }
const parties = new Map();

function genererCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans caractères ambigus
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (parties.has(code));
  return code;
}

function nomAffiche(party, joueurId) {
  return party.joueursInfo[joueurId]?.pseudo || 'Joueur inconnu';
}

function estBot(party, joueurId) {
  return !!party.joueursInfo[joueurId]?.estBot;
}

// ---------------------------------------------------------------------------
// LOGIQUE DES BOTS (stratégie simple, réutilisée du script de test)
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

function executerCoupBot(party, joueurId) {
  const state = party.state;
  const joueur = state.joueurs[joueurId];
  const top = state.defausse[state.defausse.length - 1];
  const jouables = moteur.cartesJouables(joueur.main, top, state.couleurActive);

  if (jouables.length > 0) {
    // Le bot garde ses cartes spéciales (Joker/9) en réserve tant qu'il a autre chose à jouer
    const normales = jouables.filter((c) => c.valeur !== 'joker' && c.valeur !== 9);
    const carte = normales.length > 0 ? normales[0] : jouables[0];
    const couleurDemandee = (carte.valeur === 'joker' || carte.valeur === 9)
      ? couleurLaPlusFrequente(joueur.main.filter((c) => c.id !== carte.id))
      : undefined;
    return moteur.jouerCarte(state, joueurId, carte.id, couleurDemandee);
  }

  const piocheRes = moteur.piocherCarte(state, joueurId);
  if (piocheRes.jouableMaintenant) {
    const carte = piocheRes.carte;
    const couleurDemandee = (carte.valeur === 'joker' || carte.valeur === 9)
      ? couleurLaPlusFrequente(joueur.main.filter((c) => c.id !== carte.id))
      : undefined;
    return moteur.jouerCarte(state, joueurId, carte.id, couleurDemandee);
  }
  // Sinon : le moteur a déjà fait passer le tour automatiquement (carte piochée injouable)
  return undefined;
}

function emettreResultatManche(party, resultat) {
  if (!resultat) return;
  if (resultat.evenement === 'partie_terminee') {
    io.to(party.code).emit('partie_terminee', { perdants: resultat.perdants, scores: resultat.scores });
  } else if (resultat.evenement === 'manche_terminee') {
    io.to(party.code).emit('manche_terminee', { gagnantManche: resultat.gagnantManche, scores: resultat.scores });
  }
}

// Vérifie si c'est le tour d'un bot et, si oui, joue à sa place après un
// petit délai (pour que ça ne paraisse pas instantané/robotique).
function planifierTourBotSiNecessaire(party, delaiSupplementaire = 0) {
  if (!party.state || !party.state.enCours) return;
  const joueurId = party.state.ordreJoueurs[party.state.tourIndex];
  if (!estBot(party, joueurId)) return;

  const delai = 900 + Math.random() * 700 + delaiSupplementaire;
  setTimeout(() => {
    // Le salon ou la partie a pu changer entre-temps (déconnexion, etc.)
    if (!parties.has(party.code) || !party.state || !party.state.enCours) return;
    if (party.state.ordreJoueurs[party.state.tourIndex] !== joueurId) return;

    const resultat = executerCoupBot(party, joueurId);
    diffuserEtat(party);
    emettreResultatManche(party, resultat);

    // Si une manche vient de se terminer, on laisse le temps aux joueurs
    // humains de voir le récap avant que les bots n'enchaînent.
    const delaiSuivant = resultat?.evenement === 'manche_terminee' ? 3500 : 0;
    planifierTourBotSiNecessaire(party, delaiSuivant);
  }, delai);
}

// ---------------------------------------------------------------------------
// CONSTRUCTION DE LA VUE PRIVÉE POUR UN JOUEUR (ne montre jamais les mains adverses)
// ---------------------------------------------------------------------------
function etatPourJoueur(party, joueurId) {
  const { state } = party;

  if (!state) {
    return {
      statut: 'lobby',
      code: party.code,
      hostId: party.hostId,
      joueurs: party.ordreJoueurs.map((id) => ({
        id,
        pseudo: nomAffiche(party, id),
        connecte: party.joueursInfo[id].connecte,
        estHote: id === party.hostId,
        estBot: estBot(party, id),
      })),
    };
  }

  const top = state.defausse[state.defausse.length - 1];
  return {
    statut: state.enCours ? 'en_cours' : 'terminee',
    code: party.code,
    hostId: party.hostId,
    manche: state.manche,
    carteHaut: top,
    couleurActive: state.couleurActive,
    tourActuel: state.ordreJoueurs[state.tourIndex],
    aDejaPioche: state.aPioche,
    scores: moteur.scoresActuels(state),
    perdants: state.perdants,
    maMain: state.joueurs[joueurId] ? state.joueurs[joueurId].main : [],
    joueurs: state.ordreJoueurs.map((id) => ({
      id,
      pseudo: nomAffiche(party, id),
      connecte: party.joueursInfo[id].connecte,
      nombreCartes: state.joueurs[id].main.length,
      estBot: estBot(party, id),
    })),
  };
}

function diffuserEtat(party) {
  for (const joueurId of party.ordreJoueurs) {
    const socketId = party.joueursInfo[joueurId].socketId;
    if (socketId) {
      io.to(socketId).emit('etat_partie', etatPourJoueur(party, joueurId));
    }
  }
}

// ---------------------------------------------------------------------------
// GESTION DES CONNEXIONS SOCKET.IO
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`Connexion : ${socket.id}`);

  // -- Créer un salon --------------------------------------------------------
  socket.on('creer_partie', ({ pseudo }, callback) => {
    try {
      const code = genererCode();
      const joueurId = crypto.randomUUID();
      const jeton = crypto.randomUUID();

      const party = {
        code,
        hostId: joueurId,
        statut: 'lobby',
        joueursInfo: {
          [joueurId]: { pseudo: pseudo || 'Joueur 1', socketId: socket.id, connecte: true, jeton },
        },
        ordreJoueurs: [joueurId],
        state: null,
      };
      parties.set(code, party);

      socket.join(code);
      socket.data.code = code;
      socket.data.joueurId = joueurId;

      callback({ succes: true, code, joueurId, jeton });
      diffuserEtat(party);
    } catch (err) {
      callback({ succes: false, erreur: err.message });
    }
  });

  // -- Rejoindre un salon existant --------------------------------------------
  socket.on('rejoindre_partie', ({ code, pseudo }, callback) => {
    const party = parties.get(code);
    if (!party) return callback({ succes: false, erreur: 'Ce salon n\'existe pas.' });
    if (party.statut !== 'lobby') return callback({ succes: false, erreur: 'La partie a déjà commencé.' });
    if (party.ordreJoueurs.length >= 4) return callback({ succes: false, erreur: 'Le salon est complet (4 joueurs maxi).' });

    const joueurId = crypto.randomUUID();
    const jeton = crypto.randomUUID();
    party.joueursInfo[joueurId] = { pseudo: pseudo || `Joueur ${party.ordreJoueurs.length + 1}`, socketId: socket.id, connecte: true, jeton };
    party.ordreJoueurs.push(joueurId);

    socket.join(code);
    socket.data.code = code;
    socket.data.joueurId = joueurId;

    callback({ succes: true, code, joueurId, jeton });
    diffuserEtat(party);
  });

  // -- Reconnexion après coupure -----------------------------------------------
  socket.on('reconnecter', ({ code, joueurId, jeton }, callback) => {
    const party = parties.get(code);
    if (!party || !party.joueursInfo[joueurId] || party.joueursInfo[joueurId].jeton !== jeton) {
      return callback({ succes: false, erreur: 'Reconnexion impossible, jeton invalide.' });
    }
    party.joueursInfo[joueurId].socketId = socket.id;
    party.joueursInfo[joueurId].connecte = true;

    socket.join(code);
    socket.data.code = code;
    socket.data.joueurId = joueurId;

    callback({ succes: true });
    diffuserEtat(party);
  });

  // -- Ajouter un bot (hôte uniquement, en lobby) -------------------------------
  socket.on('ajouter_bot', (_data, callback) => {
    const { code, joueurId } = socket.data;
    const party = parties.get(code);
    if (!party) return callback?.({ succes: false, erreur: 'Salon introuvable.' });
    if (party.hostId !== joueurId) return callback?.({ succes: false, erreur: "Seul l'hôte peut ajouter un bot." });
    if (party.statut !== 'lobby') return callback?.({ succes: false, erreur: 'La partie a déjà commencé.' });
    if (party.ordreJoueurs.length >= 4) return callback?.({ succes: false, erreur: 'Le salon est complet (4 joueurs maxi).' });

    const nbBotsExistants = party.ordreJoueurs.filter((id) => estBot(party, id)).length;
    const botId = crypto.randomUUID();
    party.joueursInfo[botId] = {
      pseudo: `Bot ${nbBotsExistants + 1} 🤖`,
      socketId: null,
      connecte: true,
      estBot: true,
      jeton: null,
    };
    party.ordreJoueurs.push(botId);

    callback?.({ succes: true });
    diffuserEtat(party);
  });

  // -- Retirer un bot (hôte uniquement, en lobby) --------------------------------
  socket.on('retirer_bot', ({ joueurId: botId }, callback) => {
    const { code, joueurId } = socket.data;
    const party = parties.get(code);
    if (!party) return callback?.({ succes: false, erreur: 'Salon introuvable.' });
    if (party.hostId !== joueurId) return callback?.({ succes: false, erreur: "Seul l'hôte peut retirer un bot." });
    if (party.statut !== 'lobby') return callback?.({ succes: false, erreur: 'La partie a déjà commencé.' });
    if (!estBot(party, botId)) return callback?.({ succes: false, erreur: "Ce n'est pas un bot." });

    delete party.joueursInfo[botId];
    party.ordreJoueurs = party.ordreJoueurs.filter((id) => id !== botId);

    callback?.({ succes: true });
    diffuserEtat(party);
  });

  // -- Démarrer la partie (hôte uniquement) -------------------------------------
  socket.on('demarrer_partie', (_data, callback) => {
    const { code, joueurId } = socket.data;
    const party = parties.get(code);
    if (!party) return callback?.({ succes: false, erreur: 'Salon introuvable.' });
    if (party.hostId !== joueurId) return callback?.({ succes: false, erreur: "Seul l'hôte peut démarrer la partie." });
    if (party.ordreJoueurs.length < 2) return callback?.({ succes: false, erreur: 'Il faut au moins 2 joueurs.' });

    try {
      party.state = moteur.initialiserPartie(party.ordreJoueurs);
      party.statut = 'en_cours';
      callback?.({ succes: true });
      diffuserEtat(party);
      planifierTourBotSiNecessaire(party);
    } catch (err) {
      callback?.({ succes: false, erreur: err.message });
    }
  });

  // -- Jouer une carte ----------------------------------------------------------
  socket.on('jouer_carte', ({ carteId, couleurDemandee }, callback) => {
    const { code, joueurId } = socket.data;
    const party = parties.get(code);
    if (!party?.state) return callback?.({ succes: false, erreur: 'Partie introuvable ou non démarrée.' });

    try {
      const resultat = moteur.jouerCarte(party.state, joueurId, carteId, couleurDemandee);
      callback?.({ succes: true });
      diffuserEtat(party);
      emettreResultatManche(party, resultat);
      const delaiSuivant = resultat?.evenement === 'manche_terminee' ? 3500 : 0;
      planifierTourBotSiNecessaire(party, delaiSuivant);
    } catch (err) {
      callback?.({ succes: false, erreur: err.message });
    }
  });

  // -- Piocher une carte ----------------------------------------------------------
  socket.on('piocher_carte', (_data, callback) => {
    const { code, joueurId } = socket.data;
    const party = parties.get(code);
    if (!party?.state) return callback?.({ succes: false, erreur: 'Partie introuvable ou non démarrée.' });

    try {
      const resultat = moteur.piocherCarte(party.state, joueurId);
      callback?.({ succes: true, carte: resultat.carte, jouableMaintenant: resultat.jouableMaintenant });
      diffuserEtat(party);
      planifierTourBotSiNecessaire(party);
    } catch (err) {
      callback?.({ succes: false, erreur: err.message });
    }
  });

  // -- Passer son tour après une pioche non jouée --------------------------------
  socket.on('passer_tour', (_data, callback) => {
    const { code, joueurId } = socket.data;
    const party = parties.get(code);
    if (!party?.state) return callback?.({ succes: false, erreur: 'Partie introuvable ou non démarrée.' });

    try {
      moteur.passerTour(party.state, joueurId);
      callback?.({ succes: true });
      diffuserEtat(party);
      planifierTourBotSiNecessaire(party);
    } catch (err) {
      callback?.({ succes: false, erreur: err.message });
    }
  });

  // -- Rejouer avec les mêmes joueurs (hôte uniquement, une fois la partie finie) --
  socket.on('rejouer', (_data, callback) => {
    const { code, joueurId } = socket.data;
    const party = parties.get(code);
    if (!party) return callback?.({ succes: false, erreur: 'Salon introuvable.' });
    if (party.hostId !== joueurId) return callback?.({ succes: false, erreur: "Seul l'hôte peut relancer une partie." });
    if (!party.state || party.state.enCours) return callback?.({ succes: false, erreur: "La partie n'est pas terminée." });

    party.state = null;
    party.statut = 'lobby';
    callback?.({ succes: true });
    diffuserEtat(party);
  });

  // -- Déconnexion ------------------------------------------------------------
  socket.on('disconnect', () => {
    const { code, joueurId } = socket.data;
    const party = parties.get(code);
    if (!party || !party.joueursInfo[joueurId]) return;

    party.joueursInfo[joueurId].connecte = false;
    console.log(`Déconnexion : ${nomAffiche(party, joueurId)} (salon ${code})`);
    diffuserEtat(party);

    // Nettoyage : si tout le monde est déconnecté, on libère le salon après un délai
    setTimeout(() => {
      const encoreLa = party.ordreJoueurs.some((id) => party.joueursInfo[id].connecte);
      if (!encoreLa) {
        parties.delete(code);
        console.log(`Salon ${code} supprimé (tous les joueurs sont partis).`);
      }
    }, 5 * 60 * 1000); // 5 minutes de grâce pour se reconnecter
  });
});

server.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
