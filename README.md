# PRONOTE - Assistant Notes & Devoirs IA

<p align="center"><img src="icons/icon128.png" width="96" alt="pronote-simulateur"></p>

Dépôt GitHub : **https://github.com/Les-Doubles-A/pronote-simulateur**

Extension navigateur (Manifest V3) adaptative qui s'ajuste automatiquement à la page PRONOTE au premier plan :
- **Sur la page Notes** : simulateur de notes/moyennes en temps réel avec coefficients exacts et courbe d'évolution.
- **Sur la page Cahier de textes / Travail à faire** : analyse, résumé et planification des devoirs à faire grâce à une connexion locale à **LM Studio**.

<!-- installeur-release -->
## Installation

Téléchargez **`pronote-simulateur-Setup-2.0.1.exe`** depuis la [dernière release](https://github.com/Les-Doubles-A/pronote-simulateur/releases/latest), puis lancez-le.

L'installeur copie l'extension dans `%LOCALAPPDATA%\Programs\pronote-simulateur\extension` puis affiche la marche à suivre :

1. Ouvrez la page des extensions du navigateur (`chrome://extensions`, `edge://extensions`, `vivaldi://extensions`...).
2. Activez le **Mode développeur**.
3. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier `extension` (raccourci dans le menu Démarrer).

L'installeur n'est pas signé : si Windows SmartScreen s'affiche, cliquez sur « Informations complémentaires » puis « Exécuter quand même ».

## Fonctionnalités

- **Détection automatique de la page au premier plan** : le bouton flottant et le panneau basculent automatiquement entre le module **Notes** et le module **Devoirs IA** selon l'onglet ouvert sur PRONOTE (avec bascule manuelle possible à tout moment).
- **Analyse & Résumé des devoirs via LM Studio local** :
  - Connexion locale sécurisée (`http://localhost:1234` configurable) via le service worker de l'extension (sans blocage CORS/HTTPS).
  - Détection automatique des devoirs à faire (avec filtre *Non faits uniquement* et sélection manuelle).
  - 3 modes d'analyse : **Résumé & Analyse complète**, **Synthèse rapide** et **Planning priorisé**, plus un champ de **question libre**.
- **Simulation de notes en direct** : ajout de notes simulées dans n'importe quelle matière avec barème personnalisé (`/20`, `/10`, etc.) et coefficient exact (nombre ou fraction `1/3`, `1/2`...).
- **Création de matières simulées** : ajout de nouvelles matières (couleur, coefficient, première note) directement dans le tableau PRONOTE.
- **Recalcul instantané** : mise à jour de la moyenne de chaque matière (mode `/20` ou en points) et de la moyenne générale avec affichage de l'écart (`+` / `-`).
- **Graphique d'évolution** : courbe d'évolution de la moyenne générale ou par matière en distinguant les notes réelles et simulées.

### Utiliser l'analyse des devoirs avec LM Studio

1. Ouvrez **LM Studio**, chargez un modèle local et démarrez le **Local Server** (port `1234` par défaut).
2. Sur PRONOTE, ouvrez **Cahier de textes → Travail à faire** : le bouton passe automatiquement en **📚 Devoirs IA**.
3. Cliquez sur **✨ Analyser & Résumer les devoirs** (ou configurez l'URL/modèle via **⚙️ Config**).

### Recréer l'installeur

Lancer [Inno Setup 6](https://jrsoftware.org/isinfo.php) : `iscc installer\pronote-simulateur.iss`. Le setup est créé dans `installer\Output\`.
