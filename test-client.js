/**
 * TEST AUTOMATISÉ DU SERVEUR
 * ----------------------------
 * Simule 4 joueurs qui se connectent, rejoignent le même salon,
 * et jouent automatiquement jusqu'à la fin de la partie.
 *
 * Prérequis : le serveur doit tourner (node server.js) avant de lancer ce script.
 * Lancement : node test-client.js
 */

'use strict';

const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const COULEURS = ['pique', 'coeur', 'carreau', 'trefle'];
const NOMS = ['Alice', 'Bob', 'Chloé', 'David'];

function couleurAleatoire() {
  return COULEURS[Math.floor(Math.random() * COULEURS.length)];
}

function jouerAutomatiquement(socket, etat) {
  if (etat.statut !== 'en_cours') return;
  if (etat.tourActuel !== socket.data.joueurId) return; // pas notre tour

  const jouables = etat.maMain.filter((carte) => {
    // On ne peut pas recalculer carteEstJouable ici facilement sans dupliquer
    // la logique, donc on tente de jouer une carte, et si le serveur refuse,
    // on essaie la suivante (ou on pioche).
    return true;
  });

  function essayerCartes(index) {
    if (index >= jouables.length) {
      // Aucune carte n'a fonctionné, on pioche
      socket.emit('piocher_carte', {}, (res) => {
        if (res.succes && res.jouableMaintenant) {
          const couleurDemandee = (res.carte.valeur === 'joker' || res.carte.valeur === 9)
            ? couleurAleatoire() : undefined;
          socket.emit('jouer_carte', { carteId: res.carte.id, couleurDemandee }, () => {});
        } else if (res.succes) {
          socket.emit('passer_tour', {}, () => {});
        }
      });
      return;
    }
    const carte = jouables[index];
    const couleurDemandee = (carte.valeur === 'joker' || carte.valeur === 9)
      ? couleurAleatoire() : undefined;
    socket.emit('jouer_carte', { carteId: carte.id, couleurDemandee }, (res) => {
      if (!res.succes) essayerCartes(index + 1);
    });
  }

  essayerCartes(0);
}

async function creerBot(nom, codePartageRef, estHote) {
  const socket = io(URL, { transports: ['websocket'] });
  socket.data = {};

  await new Promise((resolve) => socket.on('connect', resolve));

  if (estHote) {
    await new Promise((resolve) => {
      socket.emit('creer_partie', { pseudo: nom }, (res) => {
        if (!res.succes) throw new Error(res.erreur);
        socket.data.joueurId = res.joueurId;
        codePartageRef.code = res.code;
        console.log(`${nom} a créé le salon ${res.code}`);
        resolve();
      });
    });
  } else {
    // attendre que le code soit disponible
    while (!codePartageRef.code) await new Promise((r) => setTimeout(r, 100));
    await new Promise((resolve) => {
      socket.emit('rejoindre_partie', { code: codePartageRef.code, pseudo: nom }, (res) => {
        if (!res.succes) throw new Error(res.erreur);
        socket.data.joueurId = res.joueurId;
        console.log(`${nom} a rejoint le salon ${codePartageRef.code}`);
        resolve();
      });
    });
  }

  socket.on('etat_partie', (etat) => {
    if (etat.statut === 'terminee') return;
    jouerAutomatiquement(socket, etat);
  });

  socket.on('partie_terminee', ({ perdants, scores }) => {
    console.log(`\n[${nom} voit] PARTIE TERMINÉE — Perdant(s) : ${perdants.join(', ')}`);
    console.log(`[${nom} voit] Scores finaux :`, scores);
  });

  return socket;
}

async function main() {
  console.log('=== Test automatisé : 4 bots jouent une partie complète ===\n');
  const codePartageRef = {};

  const bots = [];
  bots.push(await creerBot(NOMS[0], codePartageRef, true));
  for (let i = 1; i < NOMS.length; i++) {
    bots.push(await creerBot(NOMS[i], codePartageRef, false));
  }

  // Petit délai pour que tout le monde soit bien dans le salon
  await new Promise((r) => setTimeout(r, 500));

  bots[0].emit('demarrer_partie', {}, (res) => {
    if (!res.succes) console.error('Erreur au démarrage :', res.erreur);
    else console.log('Partie démarrée !\n');
  });

  // Laisse la simulation tourner ; le script se termine via Ctrl+C
  // ou automatiquement après un délai de sécurité.
  setTimeout(() => {
    console.log('\nDélai de sécurité atteint, arrêt du test.');
    process.exit(0);
  }, 30000);
}

main();
