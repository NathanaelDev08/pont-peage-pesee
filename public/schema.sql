-- Système Pont-Bascule Péage — Schéma SQLite v2 (montée en charge)
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA cache_size=-64000;
PRAGMA temp_store=MEMORY;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ponts (
  id TEXT PRIMARY KEY,
  site_id TEXT REFERENCES sites(id),
  nom TEXT NOT NULL,
  capacite_kg INTEGER NOT NULL DEFAULT 80000,
  echelon_kg INTEGER NOT NULL DEFAULT 20,
  seuil_vide_kg INTEGER NOT NULL DEFAULT 1000,
  indicateur_port TEXT DEFAULT 'COM1',
  indicateur_baud INTEGER DEFAULT 9600,
  indicateur_proto TEXT DEFAULT 'METTLER_CONT', -- METTLER_CONT | TOLEDO_SMA | MODBUS_TCP | SIMU
  indicateur_ip TEXT DEFAULT '',
  indicateur_tcp_port INTEGER DEFAULT 4001,
  actif INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS utilisateurs (
  id TEXT PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  nom TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operateur', -- admin | superviseur | operateur | caissier
  actif INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  operateur_id TEXT REFERENCES utilisateurs(id),
  pont_id TEXT REFERENCES ponts(id),
  ouvert_le TEXT NOT NULL,
  ferme_le TEXT,
  fond_ouverture INTEGER DEFAULT 0,
  total_especes INTEGER DEFAULT 0,
  total_mobile INTEGER DEFAULT 0,
  total_badge INTEGER DEFAULT 0,
  statut TEXT DEFAULT 'ouvert'
);

CREATE TABLE IF NOT EXISTS transporteurs (id TEXT PRIMARY KEY, nom TEXT NOT NULL, tel TEXT DEFAULT '', blacklist INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS chauffeurs (id TEXT PRIMARY KEY, nom TEXT NOT NULL, tel TEXT DEFAULT '', permis TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS vehicules (
  id TEXT PRIMARY KEY, immat TEXT UNIQUE NOT NULL, categorie TEXT DEFAULT 'PL2',
  essieux INTEGER DEFAULT 2, tare_prevue INTEGER DEFAULT 0,
  transporteur_id TEXT REFERENCES transporteurs(id), badge_rfid TEXT DEFAULT '', abonne INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS produits (id TEXT PRIMARY KEY, nom TEXT NOT NULL, prix_tonne INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS partenaires (id TEXT PRIMARY KEY, nom TEXT NOT NULL, type TEXT DEFAULT 'client', tel TEXT DEFAULT '');

CREATE TABLE IF NOT EXISTS tarifs (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  categorie TEXT NOT NULL, -- PL2, PL3, PL4+, VL, CONVOI
  prix_forfait INTEGER NOT NULL DEFAULT 0,
  prix_tonne_net INTEGER NOT NULL DEFAULT 0,
  seuil_surcharge_kg INTEGER DEFAULT 0,
  penalite_surcharge INTEGER DEFAULT 0,
  actif INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS abonnes (
  id TEXT PRIMARY KEY, vehicule_id TEXT REFERENCES vehicules(id),
  formule TEXT DEFAULT 'prepaye', solde INTEGER DEFAULT 0, actif INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pesees (
  id TEXT PRIMARY KEY,
  ticket TEXT UNIQUE NOT NULL,
  pont_id TEXT REFERENCES ponts(id),
  shift_id TEXT REFERENCES shifts(id),
  sens TEXT NOT NULL DEFAULT 'simple', -- simple | entree | sortie (double pesée)
  statut TEXT DEFAULT 'ouvert', -- ouvert | clos | annule
  immat TEXT NOT NULL,
  transporteur TEXT DEFAULT '', chauffeur TEXT DEFAULT '', produit TEXT DEFAULT '',
  provenance TEXT DEFAULT '', destination TEXT DEFAULT '',
  poids1 INTEGER NOT NULL, stable1 INTEGER DEFAULT 1,
  poids2 INTEGER, stable2 INTEGER DEFAULT 0,
  net INTEGER, surcharge INTEGER DEFAULT 0,
  montant INTEGER DEFAULT 0, paiement TEXT DEFAULT 'especes', -- especes|mobile|badge|facture
  entree_le TEXT NOT NULL, sortie_le TEXT,
  operateur TEXT DEFAULT '', photo1 TEXT DEFAULT '', photo2 TEXT DEFAULT '',
  note TEXT DEFAULT '', synced INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS paiements (
  id TEXT PRIMARY KEY, pesee_id TEXT REFERENCES pesees(id),
  montant INTEGER NOT NULL, moyen TEXT NOT NULL, ref TEXT DEFAULT '', le TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, le TEXT DEFAULT (datetime('now')), qui TEXT DEFAULT '', action TEXT NOT NULL, detail TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS alertes (id INTEGER PRIMARY KEY AUTOINCREMENT, le TEXT DEFAULT (datetime('now')), immat TEXT, net INTEGER, seuil INTEGER, message TEXT);

-- File d'envoi multi-postes / central (montée en charge phase 2)
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, entite TEXT NOT NULL, entite_id TEXT NOT NULL,
  payload TEXT NOT NULL, tentatives INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), sent_at TEXT
);

-- Index montée en charge (recherches + pagination + rapports)
CREATE INDEX IF NOT EXISTS idx_pesees_created ON pesees(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pesees_entree ON pesees(entree_le DESC);
CREATE INDEX IF NOT EXISTS idx_pesees_immat ON pesees(immat);
CREATE INDEX IF NOT EXISTS idx_pesees_statut ON pesees(statut);
CREATE INDEX IF NOT EXISTS idx_pesees_ticket ON pesees(ticket);
CREATE INDEX IF NOT EXISTS idx_pesees_sync ON pesees(synced);
CREATE INDEX IF NOT EXISTS idx_pesees_produit ON pesees(produit);
CREATE INDEX IF NOT EXISTS idx_pesees_transp ON pesees(transporteur);
CREATE INDEX IF NOT EXISTS idx_pay_pesee ON paiements(pesee_id);
CREATE INDEX IF NOT EXISTS idx_pay_le ON paiements(le DESC);
CREATE INDEX IF NOT EXISTS idx_alertes_le ON alertes(le DESC);
CREATE INDEX IF NOT EXISTS idx_audit_le ON audit(le DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_sent ON outbox(sent_at);

-- Jeux par défaut
INSERT OR IGNORE INTO sites(id,code,nom) VALUES ('site1','PK0','Poste Péage Principal');
INSERT OR IGNORE INTO ponts(id,site_id,nom) VALUES ('pont1','site1','Pont 60T - Voie 1');
INSERT OR IGNORE INTO tarifs(id,nom,categorie,prix_forfait,prix_tonne_net,seuil_surcharge_kg,penalite_surcharge) VALUES
 ('t-vl','VL / Pick-up','VL',500,0,3500,2000),
 ('t-pl2','PL 2 essieux','PL2',2500,0,19000,5000),
 ('t-pl3','PL 3 essieux','PL3',4000,150,26000,8000),
 ('t-pl4','PL 4 essieux et +','PL4+',6000,200,38000,15000);
INSERT OR IGNORE INTO utilisateurs(id,login,pass_hash,nom,role) VALUES ('u-admin','admin','admin','Chef de poste','admin');
