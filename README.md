# Smart Cut Health — Portail Partenaires Résultats

Portail sécurisé pour les laboratoires, centres d'imagerie et administrateurs : recherche de commandes payées, dépôt des résultats, demandes de correction, revue, transfert au patient, règlements et journal d'audit.

## Contenu

- `health-partner-results.html`, `.css`, `.js` : interface partenaire et administration.
- `functions/health/partnerResults.js` : endpoints Cloud Functions (fabrique à intégrer au backend Smart Cut Health existant).
- `functions/health/lib/` : règles métier, paiements partenaires, validation et tests.
- `services/health-results-scanner/` : service ClamAV qui analyse les fichiers avant leur publication.
- `integrations/` : patches ciblés pour le menu admin, l'espace patient et les règles Firestore/Storage du site hôte.

## Architecture et sécurité

Ce dépôt isole le module Résultats; ce n'est pas une copie complète du site Smart Cut Services. Le backend dépend de l'initialisation Firebase Admin, de l'authentification et des helpers partagés du projet hôte. Le scanner doit être déployé comme service privé séparé. Il faut intégrer et valider les patches dans le dépôt du site avant tout déploiement Firebase.

Les fichiers médicaux restent privés dans Storage. Les lectures passent par des URLs temporaires émises par des fonctions authentifiées et journalisées. Un résultat n'apparaît au patient qu'après revue et transfert explicite par l'administration. L'analyse antivirus échoue de manière fermée si le scanner est absent ou indisponible.

## Intégration au projet hôte

1. Copier les fichiers du portail à la racine Hosting du site et confirmer que `firebase-init.js` utilise la configuration du projet attendu.
2. Copier `functions/health/partnerResults.js` et ses bibliothèques nécessaires dans `functions/health/` du backend existant. Ajouter `...require('./partnerResults')(sstInternals)` au retour de `buildHealth` dans `functions/health/index.js`.
3. Fusionner `integrations/patient-and-admin-ui.patch` depuis la racine du dépôt hôte. Il ajoute le lien administrateur et la vue « Mes Résultats » avec ouverture sécurisée des fichiers.
4. Fusionner `integrations/firestore-and-storage-rules.patch` avec les règles actuelles. Ne pas remplacer les règles complètes du site par ce patch.
5. Ajouter l'index `healthPartnerResults` défini dans `integrations/firestore-indexes.json` à `firestore.indexes.json`.
6. Déployer le scanner dans un environnement privé; configurer `HEALTH_RESULTS_SCANNER_URL` pour les Cloud Functions et vérifier l'accès IAM entre les fonctions et Cloud Run.
7. Exécuter les tests, puis déployer Hosting, Functions, Firestore Rules/Indexes, Storage Rules et le scanner depuis le dépôt hôte, selon sa procédure de release.

Les patches sont des références d'intégration, pas des fichiers de règles complets. Vérifier les contextes avec les versions actuelles du site hôte avant application.

## Tests locaux

Prérequis : Node.js 22 ou supérieur.

```sh
npm test
```

Les tests de règles Firebase doivent aussi être exécutés dans le dépôt hôte avec ses émulateurs Firestore et Storage, car les règles complètes et leurs fixtures appartiennent à ce dépôt.

## Configuration

Le client utilise le projet Firebase `smartcutservices-9ce54` et les fonctions `us-central1`, comme le site hôte. La configuration Firebase Web est publique; aucun secret serveur ne doit être ajouté à ce dépôt. Les secrets MonCash et l'identité du compte de service restent configurés côté backend hôte.
