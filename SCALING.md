# Montée en charge — poste + multi-postes

## Fait (V2 locale, build OK)
- SQLite : WAL, synchronous NORMAL, cache 64MB, busy_timeout 5s (`src-tauri/schema.sql`)
- 12 index : created_at, entree_le, immat, statut, ticket, synced, produit, transporteur... (`schema.sql`)
- Journal paginé serveur : 50 lignes/page, recherche debounce 350ms, filtre statut, COUNT + LIMIT/OFFSET (`src/lib/peage.ts:fetchTicketsPage`)
- Rapports en GROUP BY SQL Top 50, plus d'agrégation JS (`reportAgg`)
- Maintenance (Config) : diagnostic taille/nb lignes, VACUUM+ANALYZE, archivage +6 mois, test charge lots x500 (`stressInsert`)
- Table `outbox` prête pour synchro centrale (entite, payload, sent_at).

## Seuils
- 1 poste SQLite : OK jusqu'à ~500k tickets (~150MB). Au-delà : 1 DB/an + archivage.
- Test charge intégré : Config > Maintenance > Test charge. Visez >2000 inserts/s en local.

## Phase suivante si volume/sites augmentent
1. Central Go + PostgreSQL : polling `outbox WHERE sent_at IS NULL`, UPSERT par `entite_id`, marquage sent.
2. 1 DB SQLite par poste + code site dans ticket (`T- SITE -...`) pour éviter collisions.
3. Sauvegarde auto : copie `peage.db` à la fermeture shift (à brancher côté Rust `app_data_dir`).
4. Photos : stocker chemins, pas BLOB ; purge >12 mois.
