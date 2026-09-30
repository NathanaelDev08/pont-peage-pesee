import Database from "@tauri-apps/plugin-sql";
import { invoke } from "@tauri-apps/api/core";
import { SCHEMA as BUILTIN_SCHEMA } from "./schema";

let db: Database | null = null;
export async function getDb() {
  if (!db) db = await Database.load("sqlite:peage.db");
  return db;
}

export async function initDb(schemaSql?: string) {
  const d = await getDb();
  await d.execute("PRAGMA journal_mode=WAL").catch(() => {});
  await d.execute("PRAGMA synchronous=NORMAL").catch(() => {});
  await d.execute("PRAGMA busy_timeout=5000").catch(() => {});
  // Source : parametre, sinon /schema.sql, sinon schema embarque.
  let sql = schemaSql ?? "";
  if (!sql) {
    try {
      const r = await fetch("/schema.sql");
      const t = await r.text();
      if (r.ok && !t.trimStart().startsWith("<")) sql = t;
    } catch { /* fallback embarque */ }
  }
  if (!sql) sql = BUILTIN_SCHEMA;
  // Retire les lignes de commentaires --... (sinon un chunk entier est saute
  // ou une seed apres un commentaire est ignoree).
  const cleaned = sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  const errors: string[] = [];
  for (const stmt of cleaned.split(";").map((s) => s.trim()).filter(Boolean)) {
    if (stmt.startsWith("PRAGMA")) continue;
    try { await d.execute(stmt); }
    catch (e: any) { errors.push(`${stmt.slice(0, 60)}... => ${e}`); }
  }
  // Verification bloquante : la table tarifs doit exister.
  try {
    await d.select("SELECT COUNT(*) c FROM tarifs");
  } catch (e: any) {
    throw new Error(`init DB echouee (tarifs absente). ${errors.length} erreurs SQL. 1ere : ${errors[0] ?? e}`);
  }
  // Migration : seuil pont-vide sur bases existantes
  await d.execute("ALTER TABLE ponts ADD COLUMN seuil_vide_kg INTEGER NOT NULL DEFAULT 1000").catch(() => {});
  // Migration ProRock : remorque + tare remorque + chantier
  await d.execute("ALTER TABLE pesees ADD COLUMN remorque TEXT DEFAULT ''").catch(() => {});
  await d.execute("ALTER TABLE pesees ADD COLUMN tare_rem INTEGER DEFAULT 0").catch(() => {});
  await d.execute("ALTER TABLE pesees ADD COLUMN chantier TEXT DEFAULT ''").catch(() => {});
  if (errors.length) console.warn("[initDb] erreurs non bloquantes:", errors);
}

export type Weight = { kg: number; stable: boolean; raw: string; proto: string };

export async function readWeight(port: string, baud: number, proto: string): Promise<Weight> {
  return await invoke<Weight>("read_serial_once", { portName: port, baud, proto });
}

export async function listPorts(): Promise<string[]> {
  try { return await invoke<string[]>("list_serial_ports"); }
  catch { return []; }
}

export async function computeTariff(forfait: number, prix_tonne: number, net_kg: number, seuil_kg: number, penalite: number) {
  return await invoke<{ montant: number; part_poids: number; surcharge: boolean }>("compute_tariff", {
    t: { forfait, prix_tonne, net_kg, seuil_kg, penalite },
  });
}

// ---------- Conformite : journal d'audit inviolable (insert-only) ----------
export async function audit(qui: string, action: string, detail: string) {
  try {
    const d = await getDb();
    await d.execute("INSERT INTO audit(qui,action,detail) VALUES(?,?,?)", [qui || "?", action, detail || ""]);
  } catch { /* l'audit ne doit jamais bloquer l'exploitation */ }
}

// ---------- Montee en charge : acces pagine + maintenance ----------
export const PAGE_SIZE = 50;

export async function fetchTicketsPage(page: number, q: string, statut: string) {
  const d = await getDb();
  const like = `%${q.trim().toUpperCase()}%`;
  const where: string[] = [];
  const params: any[] = [];
  if (q.trim()) { where.push("(immat LIKE ? OR ticket LIKE ?)"); params.push(like, `%${q.trim()}%`); }
  if (statut !== "tous") { where.push("statut=?"); params.push(statut); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const total = (await d.select<any[]>(`SELECT COUNT(*) c FROM pesees ${w}`, params))[0]?.c ?? 0;
  const rows = await d.select<any[]>(`SELECT * FROM pesees ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, PAGE_SIZE, page * PAGE_SIZE]);
  return { rows, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

export async function reportAgg(d1: string, d2: string) {
  const d = await getDb();
  const params: any[] = [];
  let w = "statut!='annule'";
  if (d1) { w += " AND entree_le>=?"; params.push(d1); }
  if (d2) { w += " AND entree_le<=?"; params.push(d2 + "T23:59"); }
  const byProduit = await d.select<any[]>(`SELECT produit k, COUNT(*) n, SUM(COALESCE(net,0)) kg, SUM(COALESCE(montant,0)) f FROM pesees WHERE ${w} GROUP BY produit ORDER BY n DESC LIMIT 50`, params);
  const byTransp = await d.select<any[]>(`SELECT transporteur k, COUNT(*) n, SUM(COALESCE(net,0)) kg FROM pesees WHERE ${w} GROUP BY transporteur ORDER BY n DESC LIMIT 50`, params);
  const tot = (await d.select<any[]>(`SELECT COUNT(*) n, SUM(COALESCE(net,0)) kg, SUM(COALESCE(montant,0)) f FROM pesees WHERE ${w}`, params))[0];
  return { byProduit, byTransp, tot };
}

export async function dbStats() {
  const d = await getDb();
  const tables = ["pesees", "paiements", "vehicules", "alertes", "audit", "outbox"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    try { out[t] = (await d.select<any[]>(`SELECT COUNT(*) c FROM ${t}`))[0]?.c ?? 0; } catch { out[t] = -1; }
  }
  let pageCount = 0, pageSize = 0;
  try {
    const r: any[] = await d.select("PRAGMA page_count");
    const r2: any[] = await d.select("PRAGMA page_size");
    pageCount = Object.values(r[0] ?? {})[0] as number ?? 0;
    pageSize = Object.values(r2[0] ?? {})[0] as number ?? 0;
  } catch { /* ignore */ }
  return { tables: out, sizeMB: ((pageCount * pageSize) / 1048576).toFixed(2) };
}

export async function dbVacuum() {
  const d = await getDb();
  await d.execute("VACUUM");
  await d.execute("ANALYZE");
}

export async function dbArchive(monthsOld: number) {
  // Archive : supprime les tickets annulés anciens + purge audit (jamais les clos facturables sans export)
  const d = await getDb();
  await d.execute("DELETE FROM pesees WHERE statut='annule' AND created_at < date('now', ?)", [`-${monthsOld} months`]);
  await d.execute("DELETE FROM audit WHERE le < date('now', ?)", [`-${monthsOld} months`]);
  await d.execute("DELETE FROM alertes WHERE le < date('now', ?)", [`-${monthsOld} months`]);
}

export function isTauri() {
  return typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;
}

// ---------- Donnees de test realistes ----------
export async function seedTestData(onMsg?: (m: string) => void) {
  const d = await getDb();
  const log = (m: string) => onMsg?.(m);
  // Garde-fous FK : site + pont par defaut
  await d.execute("INSERT OR IGNORE INTO sites(id,code,nom) VALUES('site1','PK0','Poste Peage Principal')");
  await d.execute("INSERT OR IGNORE INTO ponts(id,site_id,nom) VALUES('pont1','site1','Pont 60T - Voie 1')");
  // Referentiels fixes (INSERT OR IGNORE -> rejouable)
  const transporteurs = [
    ["tr1", "Trans Sahel Express", "+228 90 11 22 33"], ["tr2", "SOTRAL Fret", "+228 91 44 55 66"],
    ["tr3", "Africa Logistics", "+228 92 77 88 99"], ["tr4", "Trans Kigali Cargo", "+250 78 111 222"],
    ["tr5", "Bamako Transporteurs Unis", "+223 70 123 456"], ["tr6", "Express Cimenterie", "+228 93 000 111"],
    ["tr7", "Nes Trans", "+228 90 555 666"], ["tr8", "Sahel Bennes Services", "+228 91 999 000"],
  ];
  for (const [id, nom, tel] of transporteurs)
    await d.execute("INSERT OR IGNORE INTO transporteurs(id,nom,tel) VALUES(?,?,?)", [id, nom, tel]);
  const chauffeurs = [
    ["ch1", "Kossi Agbeko", "+228 90 100 200"], ["ch2", "Ama Mensah", "+228 91 200 300"],
    ["ch3", "Yao Koffi", "+228 92 300 400"], ["ch4", "Afi Dovi", "+228 93 400 500"],
    ["ch5", "Kwame Asante", "+233 24 500 600"], ["ch6", "Moussa Traore", "+223 70 600 700"],
    ["ch7", "Jean-Baptiste Ouedraogo", "+226 60 700 800"], ["ch8", "Fatou Diallo", "+221 77 800 900"],
  ];
  for (const [id, nom, tel] of chauffeurs)
    await d.execute("INSERT OR IGNORE INTO chauffeurs(id,nom,tel) VALUES(?,?,?)", [id, nom, tel]);
  const vehicules = [
    ["vh1", "TG-4521-AB", "PL3"], ["vh2", "TG-7830-CD", "PL2"], ["vh3", "TG-1290-EF", "PL4+"],
    ["vh4", "GH-3345-21", "PL3"], ["vh5", "TG-9054-GH", "PL2"], ["vh6", "BF-2210-IJ", "PL3"],
    ["vh7", "TG-6677-KL", "VL"], ["vh8", "ML-8834-MN", "PL4+"], ["vh9", "TG-3102-OP", "PL3"], ["vh10", "TG-5544-QR", "PL2"],
  ];
  for (const [id, im, cat] of vehicules)
    await d.execute("INSERT OR IGNORE INTO vehicules(id,immat,categorie) VALUES(?,?,?)", [id, im, cat]);
  const produits = ["Ciment CPJ 45", "Riz parfume 50kg", "Mais en vrac", "Fer a beton", "Sable lagunaire", "Gravier concasse", "Sucre roux", "Huile vegetale", "Clinker", "Engrais NPK"];
  for (let i = 0; i < produits.length; i++)
    await d.execute("INSERT OR IGNORE INTO produits(id,nom) VALUES(?,?)", [`pr${i + 1}`, produits[i]]);
  const partenaires = [
    ["pa1", "Cimenterie Lome", "client"], ["pa2", "Minoteries du Golfe", "client"],
    ["pa3", "ETS Kossi & Fils", "fournisseur"], ["pa4", "Quincaillerie Centrale", "client"], ["pa5", "Coop Agricole Vo", "fournisseur"],
  ];
  for (const [id, nom, type] of partenaires)
    await d.execute("INSERT OR IGNORE INTO partenaires(id,nom,type) VALUES(?,?,?)", [id, nom, type]);
  log("Referentiels OK.");

  // Pesees : 14 jours, ~12/jour, repartition realiste
  const tarifs = await d.select<any[]>("SELECT * FROM tarifs");
  const byCat: Record<string, any> = {};
  for (const t of tarifs) byCat[t.categorie] = t;
  const tares: Record<string, [number, number]> = { VL: [1500, 2500], PL2: [6000, 9000], PL3: [9000, 13000], "PL4+": [13000, 18000] };
  const charges: Record<string, [number, number]> = { VL: [500, 2000], PL2: [4000, 12000], PL3: [10000, 18000], "PL4+": [15000, 25000] };
  const rnd = (a: number, b: number) => Math.floor(a + Math.random() * (b - a));
  const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  const moyens = ["especes", "especes", "especes", "mobile", "mobile", "badge", "facture"];
  const provenances = ["Port de Lome", "Cimenterie", "Frontiere Benin", "Frontiere Ghana", "Carriere Dalavemon", "Zone franche"];
  const destinations = ["Lome", "Atakpame", "Sokode", "Kara", "Dapaong", "Ouagadougou", "Niamey"];
  let n = 0;
  for (let day = 13; day >= 0; day--) {
    const nb = day === 0 ? 5 : rnd(8, 15);
    for (let i = 0; i < nb; i++) {
      const v: any = pick(vehicules);
      const cat = v[2];
      const [t0, t1] = tares[cat];
      const [c0, c1] = charges[cat];
      const tare = rnd(t0, t1);
      const net = rnd(c0, c1);
      const brut = tare + net;
      const chargePremier = Math.random() < 0.5;
      const p1 = chargePremier ? brut : tare;
      const p2 = chargePremier ? tare : brut;
      const t = byCat[cat];
      let montant = 0;
      if (t) {
        montant = t.prix_forfait + Math.round((net / 1000) * t.prix_tonne_net);
        if (t.seuil_surcharge_kg > 0 && net > t.seuil_surcharge_kg) montant += t.penalite_surcharge;
      }
      const hh = rnd(6, 19), mm = rnd(0, 59);
      const dt = new Date();
      dt.setDate(dt.getDate() - day);
      dt.setHours(hh, mm, rnd(0, 59), 0);
      const iso = dt.toISOString();
      const id = `seed_${dt.getTime()}_${i}`;
      const tk = `T${iso.slice(0, 10).split("-").join("")}-${String(hh).padStart(2, "0")}${String(mm).padStart(2, "0")}${String(n % 100).padStart(2, "0")}`;
      await d.execute(
        "INSERT OR IGNORE INTO pesees(id,ticket,pont_id,sens,statut,immat,transporteur,chauffeur,produit,provenance,destination,poids1,poids2,net,montant,paiement,entree_le,sortie_le,operateur,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [id, tk, "pont1", "simple", "clos", v[1], pick(transporteurs)[1], pick(chauffeurs)[1], pick(produits), pick(provenances), pick(destinations), p1, p2, net, montant, pick(moyens), iso, iso, "admin", iso]
      );
      if (montant) await d.execute("INSERT OR IGNORE INTO paiements(id,pesee_id,montant,moyen,le) VALUES(?,?,?,?,?)", [`seep_${id}`, id, montant, pick(moyens), iso]);
      n++;
    }
  }
  // 3 tickets ouverts + 1 annule pour tester les statuts
  for (let i = 0; i < 3; i++) {
    const v: any = pick(vehicules);
    const id = `seed_open_${Date.now()}_${i}`;
    await d.execute("INSERT OR IGNORE INTO pesees(id,ticket,pont_id,sens,statut,immat,transporteur,produit,poids1,entree_le,operateur,paiement) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      [id, `T-OPEN-00${i}`, "pont1", "entree", "ouvert", v[1], pick(transporteurs)[1], pick(produits), rnd(9000, 14000), new Date().toISOString(), "admin", "especes"]);
  }
  await d.execute("INSERT OR IGNORE INTO pesees(id,ticket,pont_id,sens,statut,immat,poids1,entree_le,sortie_le,operateur,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    [`seed_ann_${Date.now()}`, "T-ANNULE-01", "pont1", "simple", "annule", "TG-0000-XX", 12000, new Date().toISOString(), new Date().toISOString(), "admin", "ANNULE par admin: erreur saisie"]);
  log(`${n} pesees generees sur 14 jours + ouverts/annule.`);
  return n;
}
export async function stressInsert(n: number, onProgress?: (i: number) => void) {
  const d = await getDb();
  const t0 = performance.now();
  const CHUNK = 500;
  for (let base = 0; base < n; base += CHUNK) {
    const m = Math.min(CHUNK, n - base);
    const vals: string[] = [];
    const params: any[] = [];
    for (let i = 0; i < m; i++) {
      const k = base + i;
      vals.push("(?,?,?,?,?,?,?,?,?,?,?,?)");
      params.push(`st_${Date.now()}_${k}`, `STRESS-${k}`, "pont1", "simple", "clos", `XX-${k % 1000}`, 20000 + (k % 15000), 20000 + (k % 15000), 0, new Date().toISOString(), new Date().toISOString(), "stress");
    }
    await d.execute(`INSERT INTO pesees(id,ticket,pont_id,sens,statut,immat,poids1,net,montant,entree_le,sortie_le,operateur) VALUES ${vals.join(",")}`, params);
    onProgress?.(base + m);
  }
  return { ms: Math.round(performance.now() - t0), perSec: Math.round((n / (performance.now() - t0)) * 1000) };
}

export function ticketNo() {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  const rnd = Math.floor(Math.random() * 90 + 10);
  return `T${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ms}${rnd}`;
}
export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
