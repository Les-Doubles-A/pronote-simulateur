# PRONOTE - Simulateur de Notes & Moyennes

<p align="center"><img src="icons/icon128.png" width="96" alt="pronote-simulateur"></p>

Dépôt GitHub : **https://github.com/Les-Doubles-A/pronote-simulateur**

Extension navigateur (Manifest V3) qui ajoute un simulateur interactif directement dans PRONOTE : ajoutez des notes ou matières simulées avec barèmes (`/X`) et coefficients exacts (décimaux ou fractions comme `1/3`), recalculez vos moyennes par matière et votre moyenne générale en temps réel, et visualisez la courbe d'évolution.

<!-- installeur-release -->
## Installation

Téléchargez **`pronote-simulateur-Setup-1.0.0.exe`** depuis la [dernière release](https://github.com/Les-Doubles-A/pronote-simulateur/releases/latest), puis lancez-le.

L'installeur copie l'extension dans `%LOCALAPPDATA%\Programs\pronote-simulateur\extension` puis affiche la marche à suivre :

1. Ouvrez la page des extensions du navigateur (`chrome://extensions`, `edge://extensions`, `vivaldi://extensions`...).
2. Activez le **Mode développeur**.
3. Cliquez sur **Charger l'extension non empaquetée** et choisissez le dossier `extension` (raccourci dans le menu Démarrer).

L'installeur n'est pas signé : si Windows SmartScreen s'affiche, cliquez sur « Informations complémentaires » puis « Exécuter quand même ».

## Fonctionnalités

- **Simulation de notes en direct** : ajout de notes simulées dans n'importe quelle matière avec barème personnalisé (`/20`, `/10`, etc.) et coefficient exact (nombre ou fraction `1/3`, `1/2`...).
- **Création de matières simulées** : ajout de nouvelles matières (couleur, coefficient, première note) directement dans le tableau PRONOTE.
- **Recalcul instantané** : mise à jour de la moyenne de chaque matière (mode `/20` ou en points) et de la moyenne générale avec affichage de l'écart (`+` / `-`).
- **Graphique d'évolution** : courbe d'évolution de la moyenne générale ou par matière en distinguant les notes réelles et simulées.

### Recréer l'installeur

Lancer [Inno Setup 6](https://jrsoftware.org/isinfo.php) : `iscc installer\pronote-simulateur.iss`. Le setup est créé dans `installer\Output\`.
