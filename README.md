# Pont Péage Pesée — Poste Tauri (offline)

## Lancer
```cmd
cd pont-peage-pesee
npm.cmd run tauri dev
```
Build installateur Windows :
```cmd
npm.cmd run tauri build
```

## Fonctionnalités V1 incluses
- Poids live RS232 (`src-tauri/src/lib.rs:read_serial_once`) + détection stable/instable (Mettler continu), mode `SIMU` sans matériel.
- Pesée simple + double pesée entrée/sortie, calcul net `|P2-P1|`.
- Tarification péage (`compute_tariff`) : forfait catégorie + F/tonne + pénalité surcharge.
- Tickets SQLite `peage.db` (`src-tauri/schema.sql`), journal, annulation, impression ticket 80mm.
- Caisse du jour par moyen (espèces/mobile/badge/facture), stats header.
- Grille tarifs VL/PL2/PL3/PL4+, config port/baud/proto, test trame.
- 100% offline (tauri-plugin-sql + SQLite).

## Fichiers clés
- `src-tauri/src/lib.rs` : commandes Rust poids/tarif
- `src-tauri/schema.sql` + `public/schema.sql` : schéma DB
- `src/lib/peage.ts` : accès DB + invoke
- `src/App.tsx` : écrans Pesée/Tickets/Tarifs/Caisse/Config

## Phase 2 (option Go)
Serveur Go central multi-postes + synchro `synced` + ANPR/caméras/barrières TCP/Modbus.
Go n'est pas installé sur ce PC — V1 Tauri tourne sans Go.
