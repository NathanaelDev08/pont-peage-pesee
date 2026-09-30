import { useEffect, useRef, useState } from "react";
import { LayoutDashboard, Scale, Ticket, FolderOpen, BarChart3, Wallet, Users as UsersIcon, Settings, Check, RefreshCw, Printer, X, Plus, Download, LogIn, LogOut, Link2 } from "lucide-react";
import "./App.css";
import { getDb, initDb, readWeight, listPorts, computeTariff, ticketNo, uid, audit, isTauri, type Weight } from "./lib/peage";

// ---------- Types ----------
type Tarif = { id: string; nom: string; categorie: string; prix_forfait: number; prix_tonne_net: number; seuil_surcharge_kg: number; penalite_surcharge: number };
type Pesee = { id: string; ticket: string; immat: string; sens: string; statut: string; poids1: number; poids2: number | null; net: number | null; montant: number; entree_le: string; sortie_le: string | null; transporteur: string; produit: string; chauffeur: string; provenance: string; destination: string; paiement: string; remorque?: string; tare_rem?: number; chantier?: string };
type User = { id: string; login: string; nom: string; role: string; actif: number };
type Pont = { id: string; nom: string; capacite_kg: number; echelon_kg: number; seuil_vide_kg: number; indicateur_port: string; indicateur_baud: number; indicateur_proto: string; actif: number };
type Session = { login: string; nom: string; role: string };

type Tab = "dashboard" | "pesee" | "tickets" | "referentiels" | "rapports" | "caisse" | "users" | "config";

const LVL: Record<string, number> = { operateur: 1, caissier: 1, superviseur: 2, admin: 3 };

export default function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [ready, setReady] = useState(false);
  const [ports, setPorts] = useState<string[]>([]);
  const [port, setPort] = useState("COM1");
  const [baud, setBaud] = useState(9600);
  const [proto, setProto] = useState("SIMU");
  const [live, setLive] = useState<Weight>({ kg: 0, stable: false, raw: "-", proto: "" });
  const [auto, setAuto] = useState(true);
  const timer = useRef<number | null>(null);

  // pesée
  const [immat, setImmat] = useState("");
  const [categorie, setCategorie] = useState("PL2");
  const [produit, setProduit] = useState("");
  const [transporteur, setTransporteur] = useState("");
  const [chauffeur, setChauffeur] = useState("");
  const [client, setClient] = useState("");
  const [provenance, setProvenance] = useState("");
  const [destination, setDestination] = useState("");
  const [tareManuelle, setTareManuelle] = useState("");
  const [remorque, setRemorque] = useState("");
  const [tareRem, setTareRem] = useState("");
  const [chantier, setChantier] = useState("");
  const [paiement, setPaiement] = useState("especes");
  const [mode, setMode] = useState<"simple" | "double-auto" | "double-entree" | "double-sortie">("double-auto");
  const [peageActif, setPeageActif] = useState(true);
  const [printAuto, setPrintAuto] = useState(false);

  const [tarifs, setTarifs] = useState<Tarif[]>([]);
  const [tickets, setTickets] = useState<Pesee[]>([]);
  const [ouverts, setOuverts] = useState<Pesee[]>([]);
  const [msg, setMsg] = useState("");
  const [lastRes, setLastRes] = useState<any>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [stats, setStats] = useState({ n: 0, total: 0, tonnes: 0, ouverts: 0 });

  // session + securite (pilier 5)
  const [session, setSession] = useState<Session | null>(() => {
    try { return JSON.parse(localStorage.getItem("peage_session") || "null"); } catch { return null; }
  });
  const lvl = LVL[session?.role ?? ""] ?? 0;
  const can = (need: number) => lvl >= need;

  // multi-ponts (pilier 2)
  const [ponts, setPonts] = useState<Pont[]>([]);
  const [pontId, setPontId] = useState("pont1");
  const pont = ponts.find((p) => p.id === pontId) ?? ponts[0];

  useEffect(() => {
    (async () => {
      try {
        await initDb(); // schema embarque, plus de fetch fragile
        await refresh();
        const p = await listPorts();
        setPorts(p);
      } catch (e: any) { setMsg("Init: " + (e?.message ?? e)); }
      setReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!auto || !ready || tab !== "pesee") return;
    timer.current = window.setInterval(async () => {
      try { setLive(await readWeight(port, baud, proto)); }
      catch (e: any) { setLive((l) => ({ ...l, raw: String(e).slice(0, 120) })); }
    }, 800);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [auto, ready, tab, port, baud, proto]);

  async function refresh() {
    const d = await getDb();
    const t = await d.select<Tarif[]>("SELECT * FROM tarifs WHERE actif=1 ORDER BY categorie");
    setTarifs(t);
    const pts = await d.select<Pont[]>("SELECT * FROM ponts WHERE actif=1 ORDER BY nom");
    setPonts(pts);
    if (pts.length && !pts.some((p) => p.id === pontId)) {
      setPontId(pts[0].id);
      setPort(pts[0].indicateur_port); setBaud(pts[0].indicateur_baud); setProto(pts[0].indicateur_proto);
    }
    const rows = await d.select<Pesee[]>("SELECT * FROM pesees ORDER BY created_at DESC LIMIT 200");
    setTickets(rows);
    const ov = await d.select<Pesee[]>("SELECT * FROM pesees WHERE statut='ouvert' ORDER BY created_at DESC");
    setOuverts(ov);
    const s = await d.select<any[]>("SELECT COUNT(*) n, COALESCE(SUM(montant),0) total, COALESCE(SUM(net),0) tonnes FROM pesees WHERE date(created_at)=date('now') AND statut!='annule'");
    setStats({ n: s[0]?.n ?? 0, total: s[0]?.total ?? 0, tonnes: Math.round(((s[0]?.tonnes ?? 0) as number) / 1000), ouverts: ov.length });
  }

  // ---------- Actions pesée standard (logique ProRock : Brut - Tare veh. - Tare rem. = Net) ----------
  function missStyle(k: string): any {
    return missing.includes(k) ? { borderColor: "#ef4444", background: "#2a1215" } : {};
  }
  function brutTareNet(p1: number, p2: number | null, tareM: number, tareRem = 0): { brut: number; tare: number; tareRem: number; net: number } {
    if (p2 === null || p2 === undefined) {
      const tare = tareM || 0;
      return { brut: p1, tare, tareRem, net: Math.max(0, p1 - tare - tareRem) };
    }
    const brut = Math.max(p1, p2);
    const tare = Math.min(p1, p2);
    return { brut, tare, tareRem, net: Math.max(0, brut - tare - tareRem) };
  }

  async function valider(manuel?: number) {
    const kg = manuel ?? live.kg;
    // Tous les champs obligatoires (sauf tare manuelle et client)
    const req: [string, string][] = [
      ["immat", immat.trim()], ["produit", produit.trim()], ["transporteur", transporteur.trim()],
      ["chauffeur", chauffeur.trim()], ["provenance", provenance.trim()], ["destination", destination.trim()],
    ];
    const miss = req.filter(([, v]) => !v).map(([k]) => k);
    setMissing(miss);
    if (miss.length) { setMsg(`Formulaire incomplet - remplissez : ${miss.join(", ")}.`); return; }
    if (!live.stable && manuel === undefined && proto !== "SIMU") { setMsg("Poids instable - attendez STABLE ou utilisez saisie manuelle."); return; }
    // Pont vide : aucun poids ne part sans camion (seuil configurable par pont)
    const seuilVide = pont?.seuil_vide_kg ?? 1000;
    if (kg < seuilVide) { setMsg(`PONT VIDE : ${kg} kg < seuil ${seuilVide} kg - montez le camion sur le pont.`); return; }
    const capa = pont?.capacite_kg ?? 80000;
    if (kg > capa) {
      await audit(session?.login ?? "?", "DEPASSEMENT_PONT", `${immat.toUpperCase()} ${kg} kg > capacite ${capa} (${pont?.nom})`);
      setMsg(`BLOQUE : ${kg} kg depasse la capacite du pont (${capa} kg). Desengagez puis repesez.`);
      return;
    }
    const tarif = tarifs.find((t) => t.categorie === categorie) ?? tarifs[0];
    const d = await getDb();
    const now = new Date().toISOString();
    const tareM = Number(tareManuelle) || 0;
    const tareRemV = Number(tareRem) || 0;
    const qui = session?.login ?? "?";
    // Double pesee automatique : 1er poids mis en attente, 2e passage detecte seul
    let m = mode;
    if (m === "double-auto") {
      const open = await d.select<any[]>("SELECT id FROM pesees WHERE immat=? AND statut='ouvert' LIMIT 1", [immat.toUpperCase()]);
      m = open.length ? "double-sortie" : "double-entree";
    }
    try {
      if (m === "simple") {
        const { net } = brutTareNet(kg, null, tareM, tareRemV);
        let montant = 0, surcharge = false, partPoids = 0;
        if (peageActif && tarif) {
          const c: any = await computeTariff(tarif.prix_forfait, tarif.prix_tonne_net, net, tarif.seuil_surcharge_kg, tarif.penalite_surcharge);
          montant = c.montant; surcharge = c.surcharge; partPoids = c.part_poids;
        }
        const id = uid("pes");
        const tk = ticketNo();
        await d.execute(
          "INSERT INTO pesees(id,ticket,pont_id,sens,statut,immat,transporteur,chauffeur,produit,provenance,destination,poids1,stable1,net,montant,paiement,entree_le,sortie_le,operateur,note,remorque,tare_rem,chantier) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [id, tk, pontId, "simple", "clos", immat.toUpperCase(), transporteur, chauffeur, produit || client, provenance, destination, kg, 1, net, montant, paiement, now, now, qui, tareM ? `tare Man:${tareM}` : "", remorque.toUpperCase(), tareRemV, chantier]
        );
        if (montant) await d.execute("INSERT INTO paiements(id,pesee_id,montant,moyen) VALUES(?,?,?,?)", [uid("pay"), id, montant, paiement]);
        // mémorise véhicule + tare prévue
        await d.execute("INSERT OR IGNORE INTO vehicules(id,immat,categorie) VALUES(?,?,?)", [uid("veh"), immat.toUpperCase(), categorie]);
        await audit(qui, "PESEE_SIMPLE", `${tk} ${immat.toUpperCase()} net=${net} montant=${montant} pont=${pontId}`);
        const resSimple = { kind: "simple", ticket: tk, immat: immat.toUpperCase(), p1: kg, p2: null, brut: kg, tare: tareM, tareRem: tareRemV, net, forfait: tarif?.prix_forfait ?? 0, partPoids, penalite: surcharge ? tarif?.penalite_surcharge ?? 0 : 0, montant, surcharge, paiement, produit: produit || client, transporteur, remorque: remorque.toUpperCase(), chantier };
        setLastRes(resSimple);
        if (printAuto) setTimeout(() => printTicketStatic({ ticket: tk, entree_le: now, immat: resSimple.immat, transporteur, produit: resSimple.produit, poids1: kg, poids2: null, net, montant, paiement }), 400);
        setMsg(`Pesee simple : Brut ${kg.toLocaleString()} - Tare ${tareM.toLocaleString()} = Net ${net.toLocaleString()} kg${peageActif ? ` -> ${montant.toLocaleString()} F${surcharge ? " ! SURCHARGE" : ""}` : ""}`);
      } else if (m === "double-entree") {
        const id = uid("pes");
        const tk = ticketNo();
        await d.execute("INSERT INTO pesees(id,ticket,pont_id,sens,statut,immat,transporteur,chauffeur,produit,provenance,destination,poids1,stable1,entree_le,operateur,paiement,remorque,tare_rem,chantier) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [id, tk, pontId, "entree", "ouvert", immat.toUpperCase(), transporteur, chauffeur, produit || client, provenance, destination, kg, 1, now, qui, paiement, remorque.toUpperCase(), tareRemV, chantier]);
        await audit(qui, "PESEE_ENTREE", `${tk} ${immat.toUpperCase()} p1=${kg} pont=${pontId}`);
        setMsg(mode === "double-auto"
          ? `1er poids ${kg} kg mis EN ATTENTE pour ${immat.toUpperCase()} - faites passer le camion au 2e passage.`
          : `1re pesee (entree) : ${kg} kg - ticket ouvert, en attente 2e pesee.`);
      } else {
        const open = await d.select<any[]>("SELECT * FROM pesees WHERE immat=? AND statut='ouvert' ORDER BY created_at DESC LIMIT 1", [immat.toUpperCase()]);
        if (!open.length) { setMsg("Aucune 1re pesee ouverte pour cette immat - faites d'abord une Entree."); return; }
        const e = open[0];
        const { brut, tare, net } = brutTareNet(e.poids1, kg, tareM, tareRemV);
        const remV = remorque || e.remorque || "";
        const chantV = chantier || e.chantier || "";
        let montant = 0, surcharge = false, partPoids = 0;
        if (peageActif && tarif) {
          const c: any = await computeTariff(tarif.prix_forfait, tarif.prix_tonne_net, net, tarif.seuil_surcharge_kg, tarif.penalite_surcharge);
          montant = c.montant; surcharge = c.surcharge; partPoids = c.part_poids;
        }
        await d.execute("UPDATE pesees SET poids2=?, net=?, montant=?, statut='clos', sortie_le=?, paiement=?, chauffeur=?, produit=?, remorque=?, tare_rem=?, chantier=? WHERE id=?",
          [kg, net, montant, now, paiement, chauffeur || e.chauffeur, produit || e.produit, remV.toUpperCase(), tareRemV || e.tare_rem || 0, chantV, e.id]);
        if (montant) await d.execute("INSERT INTO paiements(id,pesee_id,montant,moyen) VALUES(?,?,?,?)", [uid("pay"), e.id, montant, paiement]);
        if (peageActif && tarif && surcharge) await d.execute("INSERT INTO alertes(immat,net,seuil,message) VALUES(?,?,?,?)", [immat.toUpperCase(), net, tarif.seuil_surcharge_kg, `Surcharge ${net} kg`]);
        await audit(qui, "PESEE_SORTIE", `${e.ticket} net=${net} montant=${montant} pont=${pontId}`);
        const resSortie = { kind: "sortie", ticket: e.ticket, immat: immat.toUpperCase(), p1: e.poids1, p2: kg, brut, tare, tareRem: tareRemV || e.tare_rem || 0, net, forfait: tarif?.prix_forfait ?? 0, partPoids, penalite: surcharge ? tarif?.penalite_surcharge ?? 0 : 0, montant, surcharge, paiement, produit: produit || e.produit, transporteur: transporteur || e.transporteur, remorque: remV.toUpperCase(), chantier: chantV };
        setLastRes(resSortie);
        if (printAuto) setTimeout(() => printTicketStatic({ ticket: e.ticket, entree_le: e.entree_le, immat: resSortie.immat, transporteur: resSortie.transporteur, produit: resSortie.produit, poids1: e.poids1, poids2: kg, net, montant, paiement }), 400);
        setMsg(`2e pesee : Brut ${brut.toLocaleString()} - Tare ${tare.toLocaleString()} = Net ${net.toLocaleString()} kg${peageActif ? ` -> ${montant.toLocaleString()} F${surcharge ? " ! SURCHARGE" : ""}` : ""}`);
      }
      setImmat(""); setTareManuelle(""); setMissing([]); setRemorque(""); setTareRem("");
      await refresh();
    } catch (e: any) { setMsg("Erreur: " + e); }
  }

  async function annuler(id: string) {
    if (!can(2)) { setMsg("Annulation reservee au superviseur."); return; }
    const motif = prompt("Motif d'annulation (trace dans l'audit) :") || "";
    if (!motif.trim()) { setMsg("Annulation abandonnee : motif obligatoire."); return; }
    const d = await getDb();
    const r = await d.select<any[]>("SELECT ticket,immat FROM pesees WHERE id=?", [id]);
    await d.execute("UPDATE pesees SET statut='annule', note=? WHERE id=?", [`ANNULE par ${session?.login}: ${motif}`, id]);
    await audit(session?.login ?? "?", "ANNULATION", `${r[0]?.ticket} ${r[0]?.immat} motif=${motif}`);
    setMsg("Ticket annule (trace conservee).");
    await refresh();
  }

  // Impression sans popup (bloque en WebView) : zone dediee + window.print()
  const [printHtml, setPrintHtml] = useState<string | null>(null);
  function firePrint(inner: string) { setPrintHtml(inner); }
  function printNow() { setTimeout(() => window.print(), 150); }
  useEffect(() => {
    const h = (e: any) => setPrintHtml(e.detail);
    window.addEventListener("print-doc", h);
    return () => window.removeEventListener("print-doc", h);
  }, []);

  function printTicket(t: Pesee, duplicata = true) {
    const F = (n: any) => Number(n ?? 0).toLocaleString();
    firePrint(`
      <div class="tk">
      <h2>STE PONT-BASCULE<br>POSTE DE PESEE</h2>
      <div class="c">${duplicata ? "*** DUPLICATA ***" : "*** ORIGINAL ***"}<br>Ticket : <b>${t.ticket}</b></div><hr>
      <div class="row"><span>Entree : ${String(t.entree_le).slice(0, 16)}</span></div>
      <div class="row"><span>Sortie : ${String(t.sortie_le ?? "-").slice(0, 16)}</span></div>
      <div class="row"><span>Immat : <b>${t.immat}</b></span><span>${t.sens}/${t.statut}</span></div>
      <div>Remorque : ${(t as any).remorque || "-"} - Tare rem. : ${F((t as any).tare_rem)} kg</div>
      <div>Chantier : ${(t as any).chantier || "-"}</div>
      <div>Transporteur : ${t.transporteur || "-"}</div>
      <div>Chauffeur : ${(t as any).chauffeur || "-"}</div>
      <div>Produit : ${t.produit || "-"}</div>
      <div>${t.provenance || "-"} -&gt; ${t.destination || "-"}</div><hr>
      <div class="row"><span>Poids 1 :</span><span>${F(t.poids1)} kg</span></div>
      <div class="row"><span>Poids 2 :</span><span>${t.poids2 == null ? "-" : F(t.poids2) + " kg"}</span></div>
      <div class="row tot"><span>NET :</span><span>${F(t.net)} kg</span></div>
      <div class="row tot"><span>A PAYER :</span><span>${F(t.montant)} F</span></div>
      <div class="row"><span>Reglement :</span><span>${t.paiement}</span></div><hr>
      <div class="row"><span>Operateur : ${session?.login ?? "?"}</span></div>
      <div class="c">Signature : ....................<br>Merci de votre passage<br>Ticket infalsifiable - reclamez votre recu</div>
      </div>`);
  }

  function exportCSV(rows: any[], name: string) {
    if (!rows.length) { setMsg("Rien à exporter."); return; }
    const cols = Object.keys(rows[0]);
    const csv = [cols.join(";")].concat(rows.map((r) => cols.map((c) => String(r[c] ?? "")).join(";"))).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" }));
    a.download = name; a.click();
  }

  const TABS: { id: Tab; label: string; icon: any; min: number }[] = [
    { id: "dashboard", label: "Tableau", icon: LayoutDashboard, min: 1 },
    { id: "pesee", label: "Pesee", icon: Scale, min: 1 },
    { id: "tickets", label: "Tickets", icon: Ticket, min: 1 },
    { id: "referentiels", label: "Referentiels", icon: FolderOpen, min: 1 },
    { id: "rapports", label: "Rapports", icon: BarChart3, min: 1 },
    { id: "caisse", label: "Caisse", icon: Wallet, min: 1 },
    { id: "users", label: "Users", icon: UsersIcon, min: 3 },
    { id: "config", label: "Config", icon: Settings, min: 3 },
  ];
  const visibleTabs = TABS.filter((t) => lvl >= t.min);

  function logout() {
    audit(session?.login ?? "?", "LOGOUT", "").finally(() => {});
    localStorage.removeItem("peage_session");
    setSession(null);
  }

  if (!session) return <Login onOk={(s) => { setSession(s); localStorage.setItem("peage_session", JSON.stringify(s)); }} />;

  return (
    <main className="app">
      <header className="top">
        <div className="brand"><h1><Scale size={20} /> Pesee Pont-Bascule</h1><small>{ready ? `${session.nom} (${session.role})` : "Init..."}</small><button title="Deconnexion" onClick={logout}><LogOut size={14} /> Sortie</button></div>
        <div className="day"><div className="chips">
          <span className="chip"><Ticket size={13} /> {stats.n} tickets</span>
          <span className="chip"><Scale size={13} /> {stats.tonnes} T</span>
          <span className="chip"><Wallet size={13} /> {stats.total.toLocaleString()} F</span>
          <span className="chip">{stats.ouverts} en cours</span>
        </div></div>
      </header>

      <nav className="tabs">{visibleTabs.map((t) => { const I = t.icon; return <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}><I size={15} /> {t.label}</button>; })}</nav>
      {!isTauri() && <div className="msg" style={{ background: "#7c2d12", borderColor: "#f59e0b" }}>Version navigateur : base SQLite et port serie inactifs ici. Utilisez la fenetre desktop PONT PEAGE (lancee par npm run tauri dev).</div>}
      {msg && <div className="msg">{msg}</div>}

      {tab === "dashboard" && <Dashboard stats={stats} ouverts={ouverts} onGo={setTab} onPrint={printTicket} onSeed={can(3) ? async () => {
        const { seedTestData } = await import("./lib/peage");
        const n = await seedTestData((m) => setMsg(m));
        await refresh();
        setMsg(`Donnees chargees : ${n} pesees. Ouverture des tickets...`);
        setTab("tickets");
      } : undefined} />}
      {tab === "pesee" && (
        <section>
        <div className={`poids hero ${live.stable && live.kg >= (pont?.seuil_vide_kg ?? 1000) ? "stable" : "instable"}`}>
          <span className="val">{live.kg.toLocaleString()} kg</span>
          <span className="st">{live.kg < (pont?.seuil_vide_kg ?? 1000) ? "Pont vide" : live.stable ? "Stable - camion present" : "Instable - attente"}</span>
          <small>{pont?.nom ?? ""} - {String(live.raw).slice(0, 80)}</small>
        </div>
        <section className="grid2">
          <div className="card">
            <h2>Nouvelle pesee - {proto === "SIMU" ? "mode DEMO" : proto}</h2>
            <StepBar immat={immat} ouverts={ouverts} liveKg={live.kg} seuil={pont?.seuil_vide_kg ?? 1000} />
            <div className="row">
              <label>Pont-bascule
                <select value={pontId} onChange={(e) => {
                  const p = ponts.find((x) => x.id === e.target.value);
                  setPontId(e.target.value);
                  if (p) { setPort(p.indicateur_port); setBaud(p.indicateur_baud); setProto(p.indicateur_proto); }
                }}>
                  {ponts.map((p) => <option key={p.id} value={p.id}>{p.nom} ({p.capacite_kg / 1000}T)</option>)}
                </select></label>
              <label style={{ maxWidth: 130 }}>Capacite<input value={String((pont?.capacite_kg ?? 0) / 1000) + " T"} readOnly /></label>
            </div>
            <div className="row">
              <label>Mode
                <select value={mode} onChange={(e) => setMode(e.target.value as any)}>
                  <option value="double-auto">DOUBLE AUTO (1er poids en attente, 2e passage auto)</option>
                  <option value="simple">Pesee SIMPLE ( brut - tare manuelle )</option>
                </select></label>
              <label style={{ maxWidth: 110 }}>Auto<input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /></label>
              <button title="Relire" onClick={async () => { try { setLive(await readWeight(port, baud, proto)); } catch (e: any) { setMsg(String(e)); } }}><RefreshCw size={15} /></button>
            </div>
            <details><summary>Modes avances (entree/sortie forcee)</summary>
              <div className="row">
                <button onClick={() => setMode("double-entree")}>Forcer 1re pesee</button>
                <button onClick={() => setMode("double-sortie")}>Forcer 2e pesee</button>
                <span>Mode actuel : <b>{mode}</b></span>
              </div>
            </details>
            <div className="form-section">Pesees en attente ({ouverts.length}) - cliquez pour le 2e passage</div>
            {ouverts.length === 0 ? <p><i>Aucune pesee en attente - pont libre.</i></p> : (
              <div className="tabs" style={{ margin: "4px 0 8px" }}>
                {ouverts.map((o) => (
                  <button key={o.id} className={immat === o.immat ? "on" : ""} onClick={() => {
                    setImmat(o.immat); setTransporteur(o.transporteur || ""); setProduit(o.produit || "");
                    setChauffeur((o as any).chauffeur || ""); setProvenance(o.provenance || ""); setDestination(o.destination || "");
                    setPaiement(o.paiement || "especes"); setRemorque(o.remorque || ""); setChantier(o.chantier || "");
                    setTareRem(o.tare_rem ? String(o.tare_rem) : "");
                    setMsg(`2e passage : ${o.immat}${o.remorque ? " + " + o.remorque : ""} - 1er poids ${o.poids1.toLocaleString()} kg rappele. Validez la 2e pesee.`);
                  }}>
                    <Ticket size={14} /> {o.immat} - {o.poids1.toLocaleString()} kg
                  </button>))}
              </div>)}
            <div className="form-section">Camion</div>
            <div className="row">
              <label>Immat *<input className="immat-big" style={missStyle("immat")} value={immat} onChange={(e) => setImmat(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") valider(); }} placeholder="AB-1234-CD" list="immats" /></label>
              <datalist id="immats">{ouverts.map((o) => <option key={o.id} value={o.immat} />)}</datalist>
              <label>Categorie *<select value={categorie} onChange={(e) => setCategorie(e.target.value)}>{["VL", "PL2", "PL3", "PL4+"].map((c) => <option key={c}>{c}</option>)}</select></label>
              <label>Tare veh. (kg)<input value={tareManuelle} onChange={(e) => setTareManuelle(e.target.value)} placeholder="0" /></label>
            </div>
            <div className="row">
              <label>Remorque<input value={remorque} onChange={(e) => setRemorque(e.target.value.toUpperCase())} placeholder="PR-80950" /></label>
              <label>Tare rem. (kg)<input value={tareRem} onChange={(e) => setTareRem(e.target.value)} placeholder="0" /></label>
              <label>Chantier<input value={chantier} onChange={(e) => setChantier(e.target.value)} placeholder="Projet / chantier" /></label>
            </div>
            <div className="row">
              <button title="Copier le poids live comme Tare veh." onClick={() => setTareManuelle(String(live.kg))}>Capturer Tare veh. ({live.kg.toLocaleString()})</button>
              <button title="Copier le poids live comme Tare rem." onClick={() => setTareRem(String(live.kg))}>Capturer Tare rem.</button>
              <span><i>Net prevu : <b>{Math.max(0, live.kg - (Number(tareManuelle) || 0) - (Number(tareRem) || 0)).toLocaleString()} kg</b> / Charge max : <b>{((pont?.capacite_kg ?? 0) / 1000).toFixed(0)} T</b></i></span>
            </div>
            <details><summary>Details (optionnel - auto-remplis au 2e passage)</summary>
            <div className="form-section">Marchandise</div>
            <div className="row">
              <label>Produit *<input style={missStyle("produit")} value={produit} onChange={(e) => setProduit(e.target.value)} placeholder="Ciment, riz, fer..." /></label>
              <label>Client<input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Client destinataire" /></label>
            </div>
            <div className="form-section">Transport</div>
            <div className="row">
              <label>Transporteur *<input style={missStyle("transporteur")} value={transporteur} onChange={(e) => setTransporteur(e.target.value)} /></label>
              <label>Chauffeur *<input style={missStyle("chauffeur")} value={chauffeur} onChange={(e) => setChauffeur(e.target.value)} /></label>
            </div>
            <div className="row">
              <label>Provenance *<input style={missStyle("provenance")} value={provenance} onChange={(e) => setProvenance(e.target.value)} /></label>
              <label>Destination *<input style={missStyle("destination")} value={destination} onChange={(e) => setDestination(e.target.value)} /></label>
            </div>
            </details>
            <div className="form-section">Paiement</div>
            <div className="row">
              <label>Paiement<select value={paiement} onChange={(e) => setPaiement(e.target.value)}><option value="especes">Especes</option><option value="mobile">Mobile Money</option><option value="badge">Badge</option><option value="facture">Facture</option></select></label>
              <label>Peage actif<input type="checkbox" checked={peageActif} onChange={(e) => setPeageActif(e.target.checked)} /></label>
              <label title="Ouvre l'apercu d'impression juste apres validation">Imprimer auto<input type="checkbox" checked={printAuto} onChange={(e) => setPrintAuto(e.target.checked)} /></label>
            </div>
            <button className="big sticky-validate" onClick={() => valider()}><Check size={17} /> FIGER & VALIDER - {live.kg.toLocaleString()} kg</button>
            <details><summary>Secours manuel / tare prédéterminée</summary><Manual onValider={(v) => valider(v)} /></details>
            {lastRes && <ResultCard r={lastRes} onPrint={() => {
              printTicketStatic({ ticket: lastRes.ticket, entree_le: new Date().toISOString(), immat: lastRes.immat, remorque: lastRes.remorque, transporteur: lastRes.transporteur, produit: lastRes.produit, poids1: lastRes.p1, poids2: lastRes.p2, net: lastRes.net, montant: lastRes.montant, paiement: lastRes.paiement });
            }} onClose={() => setLastRes(null)} />}
          </div>
          <div className="card">
            <RightPanelTickets ouverts={ouverts} tickets={tickets} onPrint={printTicket} />
          </div>
        </section>
        </section>
      )}
      {tab === "tickets" && <Tickets onPrint={printTicket} onAnnuler={annuler} onRefresh={refresh} onExport={exportCSV} onMsg={setMsg} />}
      {tab === "referentiels" && <Referentiels onMsg={setMsg} />}
      {tab === "rapports" && <Rapports onExport={exportCSV} />}
      {tab === "caisse" && <Caisse stats={stats} onRefresh={refresh} />}
      {tab === "users" && (can(3) ? <Users onMsg={setMsg} /> : <section className="card"><p>Reserve a l'administrateur.</p></section>)}
      {tab === "config" && (can(3) ? (
        <section className="card"><h2>Configuration poste & ponts</h2>
          <div className="row">
            <label>Port indicateur<select value={port} onChange={(e) => setPort(e.target.value)}>{ports.map((p) => <option key={p}>{p}</option>)}<option>COM1</option><option>COM3</option></select></label>
            <label>Baud<select value={baud} onChange={(e) => setBaud(Number(e.target.value))}><option value={4800}>4800</option><option value={9600}>9600</option><option value={19200}>19200</option><option value={115200}>115200</option></select></label>
            <label>Protocole<select value={proto} onChange={(e) => setProto(e.target.value)}><option value="SIMU">SIMU - demo</option><option value="METTLER_CONT">Mettler continu</option><option value="TOLEDO_SMA">Toledo SMA</option></select></label>
          </div>
          <Ponts onRefresh={refresh} ponts={ponts} />
          <Tarifs onRefresh={refresh} tarifs={tarifs} onMsg={setMsg} />
          <Maintenance onMsg={setMsg} onRefresh={refresh} />
          <AuditView />
        </section>) : <section className="card"><p>Reserve a l'administrateur.</p></section>)}
      {printHtml && (
        <div id="print-modal"><div className="sheet">
          <div dangerouslySetInnerHTML={{ __html: printHtml }} />
          <div className="row no-print">
            <button className="big" style={{ maxWidth: 220 }} onClick={printNow}><Printer size={16} /> Imprimer</button>
            <button style={{ maxWidth: 160 }} onClick={() => setPrintHtml(null)}><X size={14} /> Fermer</button>
          </div>
        </div></div>)}
      <div id="print-area" dangerouslySetInnerHTML={{ __html: printHtml ?? "" }} />
    </main>
  );
}

// ---------- Sous-ecrans ----------
function Login({ onOk }: { onOk: (s: Session) => void }) {
  const [login, setLogin] = useState("admin");
  const [pw, setPw] = useState("admin");
  const [err, setErr] = useState("");
  async function go(e?: any) {
    e?.preventDefault();
    try {
      const d = await getDb();
      const r = await d.select<any[]>("SELECT login,nom,role FROM utilisateurs WHERE login=? AND pass_hash=? AND actif=1", [login.trim(), pw]);
      if (!r.length) { setErr("Login ou mot de passe incorrect, ou compte desactive."); return; }
      await audit(r[0].login, "LOGIN", "");
      onOk({ login: r[0].login, nom: r[0].nom, role: r[0].role });
    } catch (e: any) { setErr("Init DB requise : " + (e?.message ?? e)); }
  }
  return (
    <main className="app"><section className="card" style={{ maxWidth: 380, margin: "60px auto" }}>
      <h2><LogIn size={16} /> Connexion poste pesee</h2>
      <form onSubmit={go}>
        <label>Login<input value={login} onChange={(e) => setLogin(e.target.value)} autoFocus /></label>
        <label>Mot de passe<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        {err && <p style={{ color: "#f87171" }}>{err}</p>}
        <button className="big" type="submit"><LogIn size={16} /> Se connecter</button>
      </form>
      <p><i>Defaut : admin / admin. Changez-le dans Users.</i></p>
    </section></main>
  );
}

function Ponts({ ponts, onRefresh }: { ponts: Pont[]; onRefresh: () => void }) {
  const [nom, setNom] = useState(""); const [capa, setCapa] = useState("60000"); const [seuil, setSeuil] = useState("1000");
  const [port, setPort] = useState("COM1"); const [baud, setBaud] = useState("9600"); const [proto, setProto] = useState("SIMU");
  async function add() {
    if (!nom.trim()) return;
    const d = await getDb();
    await d.execute("INSERT INTO ponts(id,site_id,nom,capacite_kg,seuil_vide_kg,indicateur_port,indicateur_baud,indicateur_proto) VALUES(?,?,?,?,?,?,?,?)",
      [uid("pont"), "site1", nom, Number(capa) || 60000, Number(seuil) || 1000, port, Number(baud) || 9600, proto]);
    setNom(""); onRefresh();
  }
  async function toggle(p: Pont) {
    const d = await getDb();
    await d.execute("UPDATE ponts SET actif=? WHERE id=?", [p.actif ? 0 : 1, p.id]);
    onRefresh();
  }
  async function editSpecs(p: Pont) {
    const capa = prompt(`Capacite kg pour ${p.nom} :`, String(p.capacite_kg));
    if (capa === null) return;
    const seuil = prompt(`Seuil pont-vide kg pour ${p.nom} :`, String(p.seuil_vide_kg ?? 1000));
    if (seuil === null) return;
    const d = await getDb();
    await d.execute("UPDATE ponts SET capacite_kg=?, seuil_vide_kg=? WHERE id=?", [Number(capa) || p.capacite_kg, Number(seuil) || 1000, p.id]);
    onRefresh();
  }
  return (
    <div className="card"><h3>Ponts-bascules ({ponts.length}) - multi-balances</h3>
      <table><thead><tr><th>Nom</th><th>Capacite kg</th><th>Seuil vide kg</th><th>Port</th><th>Baud</th><th>Proto</th><th>Actif</th><th></th></tr></thead><tbody>
        {ponts.map((p) => <tr key={p.id}><td>{p.nom}</td><td>{p.capacite_kg}</td><td>{p.seuil_vide_kg ?? 1000}</td><td>{p.indicateur_port}</td><td>{p.indicateur_baud}</td><td>{p.indicateur_proto}</td><td>{p.actif ? "oui" : "non"}</td><td><button onClick={() => editSpecs(p)}>Regler</button> <button onClick={() => toggle(p)}>{p.actif ? "Desactiver" : "Activer"}</button></td></tr>)}
      </tbody></table>
      <div className="row"><input value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Nom ex Pont 80T - Voie 2" style={{ flex: 2 }} />
        <input value={capa} onChange={(e) => setCapa(e.target.value)} placeholder="Capacite kg" style={{ maxWidth: 120 }} />
        <input value={seuil} onChange={(e) => setSeuil(e.target.value)} placeholder="Seuil vide kg" style={{ maxWidth: 120 }} />
        <input value={port} onChange={(e) => setPort(e.target.value)} placeholder="COMx" style={{ maxWidth: 90 }} />
        <input value={baud} onChange={(e) => setBaud(e.target.value)} placeholder="Baud" style={{ maxWidth: 80 }} />
        <select value={proto} onChange={(e) => setProto(e.target.value)}><option value="SIMU">SIMU</option><option value="METTLER_CONT">Mettler</option><option value="TOLEDO_SMA">Toledo</option></select>
        <button onClick={add}><Plus size={14} /> Ajouter</button></div>
    </div>
  );
}

function AuditView() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { (async () => { const d = await getDb(); setRows(await d.select("SELECT le,qui,action,detail FROM audit ORDER BY id DESC LIMIT 100")); })(); }, []);
  return (
    <div className="card"><h3>Audit - tracabilite (insert-only, 100 derniers)</h3>
      <table><thead><tr><th>Date</th><th>Qui</th><th>Action</th><th>Detail</th></tr></thead><tbody>
        {rows.map((r, i) => <tr key={i}><td>{r.le}</td><td>{r.qui}</td><td>{r.action}</td><td>{String(r.detail).slice(0, 90)}</td></tr>)}
      </tbody></table></div>
  );
}

function Dashboard({ stats, ouverts, onGo, onPrint, onSeed }: any) {
  const empty = stats.n === 0 && stats.ouverts === 0;
  return (
    <section>
      {empty && (
        <div className="card" style={{ borderColor: "#f59e0b" }}><h2>Bienvenue - demarrage en 2 etapes</h2>
          <p><b>1.</b> Chargez des donnees de demonstration, <b>2.</b> faites une pesee, <b>3.</b> imprimez le ticket.</p>
          {onSeed && <button className="big" onClick={onSeed} style={{ maxWidth: 340 }}><Plus size={16} /> 1. Charger les donnees demo</button>}
          {!onSeed && <p><i>Connectez-vous en admin pour charger la demo.</i></p>}
        </div>)}
      <div className="kpis">
        <div className="kpi"><Ticket size={22} color="#60a5fa" /><div><span className="n">{stats.n}</span><span className="l">Pesees du jour</span></div></div>
        <div className="kpi"><Scale size={22} color="#34d399" /><div><span className="n">{stats.tonnes} T</span><span className="l">Tonnage net</span></div></div>
        <div className="kpi"><Wallet size={22} color="#fbbf24" /><div><span className="n">{stats.total.toLocaleString()} F</span><span className="l">Recettes peage</span></div></div>
        <div className="kpi"><LayoutDashboard size={22} color="#c084fc" /><div><span className="n">{stats.ouverts}</span><span className="l">Tickets en cours</span></div></div>
      </div>
      <div className="grid2">
        <div className="card"><h2>Que voulez-vous faire ?</h2>
          <div className="actions">
            <button className="big" onClick={() => onGo("pesee")}><Scale size={20} /> Peser un camion</button>
            <button className="big" style={{ background: "#2563eb", borderColor: "#2563eb" }} onClick={() => onGo("tickets")}><Ticket size={20} /> Voir les tickets</button>
            <button className="big" style={{ background: "#7c3aed", borderColor: "#7c3aed" }} onClick={() => onGo("caisse")}><Wallet size={20} /> Caisse / recu</button>
          </div>
        </div>
        <div className="card"><h2>Tickets ouverts ({ouverts.length})</h2>
          {ouverts.length === 0 ? <p><i>Aucun - pont libre.</i></p> :
            <table><thead><tr><th>Immat</th><th>P1</th><th>Entree</th><th></th></tr></thead><tbody>
              {ouverts.map((o: any) => <tr key={o.id}><td>{o.immat}</td><td>{o.poids1}</td><td>{String(o.entree_le).slice(0, 16)}</td><td><button onClick={() => onPrint(o)}><Printer size={14} /></button></td></tr>)}
            </tbody></table>}
        </div>
      </div>
    </section>
  );
}

function Tickets({ onPrint, onAnnuler, onRefresh, onExport, onMsg }: any) {
  const [q, setQ] = useState("");
  const [qq, setQq] = useState("");
  const [statut, setStatut] = useState("tous");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [ms, setMs] = useState(0);
  const [err, setErr] = useState("");
  async function load(p = page, query = qq, st = statut) {
    try {
      const t0 = performance.now();
      const { fetchTicketsPage } = await import("./lib/peage");
      const r = await fetchTicketsPage(p, query, st);
      setRows(r.rows); setTotal(r.total); setPages(r.pages);
      setMs(Math.round(performance.now() - t0)); setErr("");
    } catch (e: any) { setErr("Lecture tickets : " + (e?.message ?? e)); onMsg?.("Lecture tickets : " + (e?.message ?? e)); }
  }
  useEffect(() => { load(0, qq, statut); setPage(0); }, [statut]);
  useEffect(() => { const h = setTimeout(() => { load(0, q, statut); setQq(q); setPage(0); }, 350); return () => clearTimeout(h); }, [q]);
  useEffect(() => { load(); }, []);
  return (
    <section className="card"><h2>Tickets - {total} lignes ({ms} ms, page {page + 1}/{pages})</h2>
      <div className="row"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Recherche immat / ticket..." style={{ flex: 2 }} />
        <select value={statut} onChange={(e) => setStatut(e.target.value)}><option value="tous">Tous</option><option value="ouvert">Ouverts</option><option value="clos">Clos</option><option value="annule">Annules</option></select>
        <button onClick={() => { onRefresh(); load(); }}><RefreshCw size={14} /></button><button onClick={() => onExport(rows, "tickets-page.csv")}><Download size={14} /> CSV</button></div>
      {err && <div className="msg">{err}</div>}
      {total === 0 && !err && <div className="msg">Aucun ticket ici. Allez sur Pesee pour peser un camion, ou chargez la demo depuis le Tableau de bord.</div>}
      <div style={{ overflowX: "auto" }}><table><thead><tr><th>Ticket</th><th>Immat</th><th>Sens</th><th>P1</th><th>P2</th><th>Net</th><th>Montant</th><th>Entree</th><th>Sortie</th><th>Statut</th><th></th></tr></thead>
        <tbody>{rows.map((t: any) => <tr key={t.id}><td>{t.ticket}</td><td><b>{t.immat}</b></td><td>{t.sens}</td><td>{t.poids1.toLocaleString()}</td><td>{t.poids2 == null ? "-" : Number(t.poids2).toLocaleString()}</td><td>{t.net == null ? "-" : Number(t.net).toLocaleString()}</td><td>{Number(t.montant).toLocaleString()}</td><td>{String(t.entree_le).slice(0, 16)}</td><td>{String(t.sortie_le ?? "-").slice(0, 16)}</td><td><span className={`pill ${t.statut}`}>{t.statut}</span></td>
          <td><button onClick={() => onPrint(t)}><Printer size={14} /></button> <button onClick={async () => { await onAnnuler(t.id); load(); }}><X size={14} /></button></td></tr>)}</tbody></table></div>
      <div className="row"><button disabled={page <= 0} onClick={() => { const p = page - 1; setPage(p); load(p); }}>Prev</button>
        <span>Page {page + 1} / {pages} — {total} resultats</span>
        <button disabled={page + 1 >= pages} onClick={() => { const p = page + 1; setPage(p); load(p); }}>Next</button></div>
    </section>
  );
}

const REF_CONF: Record<string, { cols: [string, string][]; label: string; extraLabel: string }> = {
  transporteurs: { label: "Transporteurs", extraLabel: "Tel", cols: [["nom", "Nom"], ["tel", "Tel"]] },
  chauffeurs: { label: "Chauffeurs", extraLabel: "Tel", cols: [["nom", "Nom"], ["tel", "Tel"]] },
  vehicules: { label: "Vehicules", extraLabel: "Categorie", cols: [["immat", "Immat"], ["categorie", "Categorie"]] },
  produits: { label: "Produits", extraLabel: "", cols: [["nom", "Nom"]] },
  partenaires: { label: "Clients / Fournisseurs", extraLabel: "Type", cols: [["nom", "Nom"], ["type", "Type"]] },
};

function Referentiels({ onMsg }: { onMsg: (m: string) => void }) {
  const [table, setTable] = useState<keyof typeof REF_CONF>("transporteurs");
  const [rows, setRows] = useState<any[]>([]);
  const [nom, setNom] = useState(""); const [extra, setExtra] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editVals, setEditVals] = useState<Record<string, string>>({});
  const conf = REF_CONF[table];
  async function load() {
    const d = await getDb();
    setRows(await d.select(`SELECT * FROM ${table} ORDER BY ${conf.cols[0][0]} LIMIT 200`));
    setEditId(null);
  }
  useEffect(() => { setNom(""); setExtra(""); load(); }, [table]);
  async function add() {
    if (!nom.trim()) { onMsg("Nom requis."); return; }
    const d = await getDb(); const id = uid(table.slice(0, 3));
    try {
      const c0 = conf.cols[0][0];
      const vals: Record<string, string> = { [c0]: table === "vehicules" ? nom.toUpperCase() : nom };
      if (conf.cols[1]) vals[conf.cols[1][0]] = extra || (table === "partenaires" ? "client" : table === "vehicules" ? "PL2" : "");
      const keys = ["id", ...Object.keys(vals)];
      await d.execute(`INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`, [id, ...Object.values(vals)]);
      setNom(""); setExtra(""); await load(); onMsg("Ajoute.");
    } catch (e: any) { onMsg("Erreur: " + (e?.message ?? e)); }
  }
  function startEdit(r: any) {
    setEditId(r.id);
    const v: Record<string, string> = {};
    for (const [k] of conf.cols) v[k] = String(r[k] ?? "");
    setEditVals(v);
  }
  async function saveEdit(id: string) {
    const d = await getDb();
    try {
      const sets = conf.cols.map(([k]) => `${k}=?`).join(",");
      await d.execute(`UPDATE ${table} SET ${sets} WHERE id=?`, [...conf.cols.map(([k]) => editVals[k] ?? ""), id]);
      await load(); onMsg("Modifie.");
    } catch (e: any) { onMsg("Erreur: " + (e?.message ?? e)); }
  }
  async function del(r: any) {
    if (!confirm(`Supprimer ${r[conf.cols[0][0]]} ?`)) return;
    const d = await getDb();
    try { await d.execute(`DELETE FROM ${table} WHERE id=?`, [r.id]); await load(); onMsg("Supprime."); }
    catch (e: any) { onMsg("Suppression refusee (utilise ?) : " + (e?.message ?? e)); }
  }
  return (
    <section className="card"><h2>Referentiels - CRUD complet</h2>
      <div className="row">{(Object.keys(REF_CONF) as (keyof typeof REF_CONF)[]).map((t) => <button key={t} className={table === t ? "on" : ""} onClick={() => setTable(t)} style={{ background: table === t ? "#2563eb" : undefined }}>{REF_CONF[t].label}</button>)}
        <button onClick={load}><RefreshCw size={14} /></button></div>
      <div className="row"><input value={nom} onChange={(e) => setNom(e.target.value)} placeholder={`${conf.cols[0][1]}...`} style={{ flex: 2 }} />
        {conf.cols[1] && <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={`${conf.cols[1][1]}...`} />}
        <button onClick={add}><Plus size={14} /> Ajouter</button></div>
      <table><thead><tr><th>{conf.cols[0][1]}</th>{conf.cols[1] && <th>{conf.cols[1][1]}</th>}<th>Actions</th></tr></thead><tbody>
        {rows.map((r) => editId === r.id ? (
          <tr key={r.id}>
            <td><input value={editVals[conf.cols[0][0]] ?? ""} onChange={(e) => setEditVals({ ...editVals, [conf.cols[0][0]]: e.target.value })} /></td>
            {conf.cols[1] && <td><input value={editVals[conf.cols[1][0]] ?? ""} onChange={(e) => setEditVals({ ...editVals, [conf.cols[1][0]]: e.target.value })} /></td>}
            <td><button onClick={() => saveEdit(r.id)}><Check size={14} /> OK</button> <button onClick={() => setEditId(null)}><X size={14} /></button></td>
          </tr>
        ) : (
          <tr key={r.id}><td><b>{r[conf.cols[0][0]]}</b></td>{conf.cols[1] && <td>{r[conf.cols[1][0]]}</td>}
            <td><button onClick={() => startEdit(r)}>Modifier</button> <button onClick={() => del(r)}><X size={14} /></button></td></tr>
        ))}
      </tbody></table>
    </section>
  );
}

function Rapports({ onExport }: any) {
  const [d1, setD1] = useState(""); const [d2, setD2] = useState("");
  const [agg, setAgg] = useState<{ byProduit: any[]; byTransp: any[]; tot: any }>({ byProduit: [], byTransp: [], tot: { n: 0, kg: 0, f: 0 } });
  const [ms, setMs] = useState(0);
  async function load() {
    const t0 = performance.now();
    const { reportAgg } = await import("./lib/peage");
    setAgg(await reportAgg(d1, d2));
    setMs(Math.round(performance.now() - t0));
  }
  useEffect(() => { load(); }, []);
  return (
    <section className="grid2">
      <div className="card"><h2>Rapports SQL ({ms} ms)</h2>
        <div className="row"><label>Du<input type="date" value={d1} onChange={(e) => setD1(e.target.value)} /></label><label>Au<input type="date" value={d2} onChange={(e) => setD2(e.target.value)} /></label>
          <button onClick={load}><RefreshCw size={14} /> Calculer</button>
          <button onClick={() => onExport(agg.byProduit, "rapport-produits.csv")}><Download size={14} /> Export CSV</button></div>
        <p>Pesees : <b>{agg.tot?.n ?? 0}</b> - Net total : <b>{((agg.tot?.kg ?? 0) / 1000).toFixed(1)} T</b> - Recettes : <b>{Number(agg.tot?.f ?? 0).toLocaleString()} F</b></p>
        <h3>Par produit (Top 50, GROUP BY SQL)</h3><table><thead><tr><th>Produit</th><th>Nb</th><th>Kg</th><th>F</th></tr></thead><tbody>
          {agg.byProduit.map((r: any, i: number) => <tr key={i}><td>{r.k || "(sans)"}</td><td>{r.n}</td><td>{Number(r.kg).toLocaleString()}</td><td>{Number(r.f).toLocaleString()}</td></tr>)}</tbody></table>
        <h3>Par transporteur (Top 50)</h3><table><thead><tr><th>Transporteur</th><th>Nb</th><th>Kg</th></tr></thead><tbody>
          {agg.byTransp.map((r: any, i: number) => <tr key={i}><td>{r.k || "(sans)"}</td><td>{r.n}</td><td>{Number(r.kg).toLocaleString()}</td></tr>)}</tbody></table>
      </div>
      <div className="card"><h2>Surcharges</h2>
        <SurchargeList />
      </div>
      <div className="card"><h2>Integration ERP / compta / stocks</h2>
        <details><summary>Exports avances (ERP, compta, webhook)</summary>
        <ErpPush d1={d1} d2={d2} onExport={onExport} />
        </details>
      </div>
    </section>
  );
}

function download(name: string, content: string, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + content], { type }));
  a.download = name; a.click();
}

function ErpPush({ d1, d2, onExport }: any) {
  const [url, setUrl] = useState(() => localStorage.getItem("peage_erp_url") || "");
  const [res, setRes] = useState("");
  async function range() {
    const d = await getDb();
    let w = "statut!='annule'"; const p: any[] = [];
    if (d1) { w += " AND entree_le>=?"; p.push(d1); }
    if (d2) { w += " AND entree_le<=?"; p.push(d2 + "T23:59"); }
    return await d.select<any[]>(`SELECT ticket,entree_le,sortie_le,immat,transporteur,chauffeur,produit,provenance,destination,poids1,poids2,net,montant,paiement,operateur,pont_id FROM pesees WHERE ${w} ORDER BY entree_le`, p);
  }
  return (
    <div>
      <div className="row">
        <button onClick={async () => onExport(await range(), "export-erp.csv")}><Download size={14} /> Export ERP (CSV)</button>
        <button onClick={async () => {
          const rows = await range();
          download("export-erp.json", JSON.stringify(rows, null, 1), "application/json");
        }}><Download size={14} /> Export JSON</button>
      </div>
      <div className="row">
        <button onClick={async () => {
          const rows = await range();
          const lines = ["date;piece;compte;libelle;debit;credit;moyen", ...rows.map((r: any) => `${String(r.entree_le).slice(0, 10)};${r.ticket};411000;Peage ${r.immat};${r.montant};0;${r.paiement}`)];
          download("ecritures-compta.csv", lines.join("\n"));
        }}><Download size={14} /> Ecritures compta (CSV)</button>
        <button onClick={async () => {
          const d = await getDb();
          const rows = await d.select<any[]>("SELECT produit, SUM(COALESCE(net,0)) kg, COUNT(*) n FROM pesees WHERE statut='clos' GROUP BY produit");
          onExport(rows, "stocks.csv");
        }}><Download size={14} /> Mouvements stocks</button>
      </div>
      <div className="row"><input value={url} onChange={(e) => { setUrl(e.target.value); localStorage.setItem("peage_erp_url", e.target.value); }} placeholder="URL webhook ERP https://..." style={{ flex: 2 }} />
        <button onClick={async () => {
          if (!url) { setRes("URL manquante."); return; }
          try {
            const rows = await range();
            const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "pont-peage", count: rows.length, rows }) });
            setRes(`Push ${rows.length} lignes -> HTTP ${r.status}`);
          } catch (e: any) { setRes("Echec push : " + e); }
        }}><Link2 size={14} /> Push ERP</button></div>
      <p>{res}</p>
    </div>
  );
}

function SurchargeList() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { (async () => { const d = await getDb(); setRows(await d.select("SELECT * FROM alertes ORDER BY le DESC LIMIT 50")); })(); }, []);
  if (!rows.length) return <p><i>Aucune alerte.</i></p>;
  return <table><thead><tr><th>Date</th><th>Immat</th><th>Net</th><th>Seuil</th><th>Msg</th></tr></thead><tbody>
    {rows.map((r, i) => <tr key={i}><td>{r.le}</td><td>{r.immat}</td><td>{r.net}</td><td>{r.seuil}</td><td>{r.message}</td></tr>)}</tbody></table>;
}

function Caisse({ stats, onRefresh }: any) {
  const [rows, setRows] = useState<any[]>([]);
  const [list, setList] = useState<any[]>([]);
  useEffect(() => { (async () => { const d = await getDb();
    setRows(await d.select("SELECT paiement moyen, COUNT(*) n, SUM(montant) total FROM pesees WHERE date(created_at)=date('now') AND statut!='annule' GROUP BY paiement"));
    setList(await d.select("SELECT ticket,entree_le,immat,net,montant,paiement,operateur FROM pesees WHERE date(created_at)=date('now') AND statut='clos' ORDER BY entree_le"));
  })(); }, [stats]);
  async function cloturer() {
    const d = await getDb();
    const qui = JSON.parse(localStorage.getItem("peage_session") || '{"login":"?"}').login;
    const fond = Number(prompt("Fond de caisse d'ouverture (F) :") || "0");
    const tot = list.reduce((a: number, t: any) => a + (t.montant || 0), 0);
    const tonnes = list.reduce((a: number, t: any) => a + (t.net || 0), 0) / 1000;
    const u = await d.select<any[]>("SELECT id FROM utilisateurs WHERE login=?", [qui]);
    const uidOp = u[0]?.id ?? null;
    await d.execute("INSERT INTO shifts(id,operateur_id,pont_id,ouvert_le,ferme_le,fond_ouverture,statut) VALUES(?,?,?,?,?,?,?)",
      [`sh_${Date.now()}`, uidOp, "pont1", new Date().toISOString().slice(0, 10) + "T06:00", new Date().toISOString(), fond, "ferme"]);
    const { audit } = await import("./lib/peage");
    await audit(qui, "CLOTURE_CAISSE", `tickets=${list.length} total=${tot} fond=${fond}`);
    printRecu(list, rows, tot, tonnes, fond, qui);
    onRefresh();
  }
  return <section className="card"><h2>Caisse du jour - {stats.total.toLocaleString()} F ({stats.n} tickets)</h2>
    <table><thead><tr><th>Moyen</th><th>Nb</th><th>Total</th></tr></thead><tbody>
      {rows.map((r, i) => <tr key={i}><td>{r.moyen}</td><td>{r.n}</td><td>{Number(r.total).toLocaleString()}</td></tr>)}</tbody></table>
    <div className="row"><button onClick={onRefresh}><RefreshCw size={14} /> Actualiser</button>
      <button onClick={() => printRecu(list, rows, list.reduce((a: number, t: any) => a + (t.montant || 0), 0), list.reduce((a: number, t: any) => a + (t.net || 0), 0) / 1000, 0, JSON.parse(localStorage.getItem("peage_session") || '{"login":"?"}').login)}><Printer size={14} /> Recu final (apercu)</button>
      <button onClick={cloturer}><Check size={14} /> Cloturer + recu final</button></div>
    <h3>Tickets du jour ({list.length})</h3>
    <table><thead><tr><th>Ticket</th><th>Heure</th><th>Immat</th><th>Net</th><th>Montant</th><th></th></tr></thead><tbody>
      {list.map((t: any) => <tr key={t.ticket}><td>{t.ticket}</td><td>{String(t.entree_le).slice(11, 16)}</td><td>{t.immat}</td><td>{t.net}</td><td>{t.montant}</td><td><button onClick={() => printTicketStatic(t)}><Printer size={14} /></button></td></tr>)}
    </tbody></table></section>;
}

// Evenement global : les ecrans hors App demandent une impression
function emitPrint(html: string) {
  window.dispatchEvent(new CustomEvent("print-doc", { detail: html }));
}

  function printTicketStatic(t: any) {
    const F = (n: any) => Number(n ?? 0).toLocaleString();
    emitPrint(`
      <div class="tk">
      <h2>STE PONT-BASCULE<br>TICKET DE PESEE</h2>
      <div class="c">*** DUPLICATA ***<br>Ticket : <b>${t.ticket}</b></div><hr>
      <div>Date : ${t.entree_le ?? t.created_at ?? ""}</div>
      <div>Immat : <b>${t.immat}</b>${t.remorque ? " + " + t.remorque : ""}</div>
      <div>Transporteur : ${t.transporteur || "-"}</div>
      <div>Produit : ${t.produit || "-"}</div><hr>
      <div class="row"><span>Poids 1 :</span><span>${F(t.poids1)} kg</span></div>
      <div class="row"><span>Poids 2 :</span><span>${t.poids2 == null ? "-" : F(t.poids2) + " kg"}</span></div>
      <div class="row tot"><span>NET :</span><span>${F(t.net)} kg</span></div>
      <div class="row tot"><span>A PAYER :</span><span>${F(t.montant)} F (${t.paiement || "-"})</span></div><hr>
      <div>Operateur : ${t.operateur || "?"} - Signature : ............</div>
      <div class="c">Ticket non modifiable</div>
      </div>`);
  }

  function printRecu(list: any[], byMoyen: any[], total: number, tonnes: number, fond: number, qui: string) {
    const F = (n: any) => Number(n ?? 0).toLocaleString();
    const lines = list.map((t: any) => `<div class="row"><span>${String(t.entree_le).slice(11, 16)} ${t.ticket.slice(-8)} ${t.immat}</span><span>${F(t.net)} / ${F(t.montant)}</span></div>`).join("");
    const moyens = byMoyen.map((r: any) => `<div class="row"><span>${r.moyen} x${r.n}</span><span>${F(r.total)} F</span></div>`).join("");
    emitPrint(`
      <div class="tk">
      <h2>RECU FINAL DE CLOTURE<br>STE PONT-BASCULE</h2>
      <div class="c">${new Date().toLocaleString()} - Par : ${qui}</div><hr>
      ${lines || "(aucun ticket)"}<hr>
      <div class="row"><span>Nb tickets :</span><span>${list.length}</span></div>
      <div class="row"><span>Tonnage :</span><span>${tonnes.toFixed(1)} T</span></div><hr>
      ${moyens}<hr>
      <div class="row tot"><span>TOTAL :</span><span>${F(total)} F</span></div>
      <div class="row"><span>Fond :</span><span>${F(fond)} F</span></div>
      <div class="row tot"><span>Attendu :</span><span>${F(total + fond)} F</span></div><hr>
      <div>Signature caissier : ............</div>
      <div>Signature chef : ............</div>
      </div>`);
  }

function Users({ onMsg }: { onMsg: (m: string) => void }) {
  const [rows, setRows] = useState<User[]>([]); const [login, setLogin] = useState(""); const [nom, setNom] = useState(""); const [role, setRole] = useState("operateur"); const [pw, setPw] = useState("");
  async function load() { const d = await getDb(); setRows(await d.select<User[]>("SELECT id,login,nom,role,actif FROM utilisateurs")); }
  useEffect(() => { load(); }, []);
  async function add() {
    if (!login.trim() || !nom.trim() || !pw) { onMsg("Login + nom + mot de passe requis."); return; }
    const d = await getDb();
    try { await d.execute("INSERT INTO utilisateurs(id,login,pass_hash,nom,role) VALUES(?,?,?,?,?)", [uid("u"), login.trim(), pw, nom, role]); setLogin(""); setNom(""); setPw(""); await load(); onMsg("Compte cree."); }
    catch (e: any) { onMsg("Erreur (login existant ?): " + e); }
  }
  async function resetPw(u: User) {
    const np = prompt(`Nouveau mot de passe pour ${u.login} :`) || "";
    if (!np) return;
    const d = await getDb();
    await d.execute("UPDATE utilisateurs SET pass_hash=? WHERE id=?", [np, u.id]);
    onMsg("Mot de passe mis a jour.");
  }
  async function toggle(u: User) { const d = await getDb(); await d.execute("UPDATE utilisateurs SET actif=? WHERE id=?", [u.actif ? 0 : 1, u.id]); await load(); }
  return <section className="card"><h2>Utilisateurs et roles</h2>
    <p><i>operateur/caissier : exploitation. superviseur : + annulations. admin : + users/config/ponts.</i></p>
    <div className="row"><input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="login" /><input value={nom} onChange={(e) => setNom(e.target.value)} placeholder="Nom complet" />
      <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Mot de passe" style={{ maxWidth: 150 }} />
      <select value={role} onChange={(e) => setRole(e.target.value)}><option value="operateur">Operateur</option><option value="caissier">Caissier</option><option value="superviseur">Superviseur</option><option value="admin">Admin</option></select>
      <button onClick={add}><Plus size={14} /> Creer</button></div>
    <table><thead><tr><th>Login</th><th>Nom</th><th>Rôle</th><th>Actif</th><th></th></tr></thead><tbody>
      {rows.map((u) => <tr key={u.id}><td>{u.login}</td><td>{u.nom}</td><td>{u.role}</td><td>{u.actif ? "oui" : "non"}</td><td><button onClick={() => resetPw(u)}>MDP</button> <button onClick={() => toggle(u)}>{u.actif ? "Desactiver" : "Activer"}</button></td></tr>)}
    </tbody></table></section>;
}

function Maintenance({ onMsg, onRefresh }: { onMsg: (m: string) => void; onRefresh?: () => void }) {
  const [stats, setStats] = useState<any>(null);
  const [busy, setBusy] = useState("");
  async function load() {
    const { dbStats } = await import("./lib/peage");
    setStats(await dbStats());
  }
  useEffect(() => { load(); }, []);
  return (
    <div className="card"><h3>Maintenance / montee en charge</h3>
      <div className="row"><button onClick={load}><RefreshCw size={14} /> Diagnostiquer</button>
        <button disabled={!!busy} onClick={async () => { setBusy("vacuum"); try { const { dbVacuum } = await import("./lib/peage"); await dbVacuum(); onMsg("VACUUM + ANALYZE OK."); } catch (e: any) { onMsg(String(e)); } setBusy(""); load(); }}>VACUUM</button>
        <button disabled={!!busy} onClick={async () => { setBusy("arch"); try { const { dbArchive } = await import("./lib/peage"); if (confirm("Archiver annules + audit + alertes de +6 mois ?")) { await dbArchive(6); onMsg("Archivage OK."); } } catch (e: any) { onMsg(String(e)); } setBusy(""); load(); }}>Archiver +6 mois</button></div>
      {stats && <p>Tables : {Object.entries(stats.tables).map(([k, v]) => `${k}=${v}`).join(" | ")} — Taille : <b>{stats.sizeMB} MB</b></p>}
      <div className="row"><button disabled={!!busy} onClick={async () => {
        setBusy("seed");
        try {
          const { seedTestData } = await import("./lib/peage");
          const n = await seedTestData((m) => onMsg(m));
          await audit("admin", "SEED_TEST", `${n} pesees`);
          onMsg(`Donnees de test chargees : ${n} pesees sur 14 jours. Retournez sur Pesee / Tickets.`);
          onRefresh?.();
        } catch (e: any) { onMsg("Seed: " + (e?.message ?? e)); }
        setBusy(""); load();
      }}><Plus size={14} /> Donnees de test reelles</button></div>
      <div className="row"><button disabled={!!busy} onClick={async () => {
        if (!confirm("Supprimer les lignes de test STRESS (tickets STRESS-* et XX-*) ?")) return;
        setBusy("purge");
        try {
          const d = await getDb();
          const ids = await d.select<any[]>("SELECT id FROM pesees WHERE ticket LIKE 'STRESS-%' OR immat LIKE 'XX-%'");
          for (const r of ids) {
            await d.execute("DELETE FROM paiements WHERE pesee_id=?", [r.id]);
            await d.execute("DELETE FROM pesees WHERE id=?", [r.id]);
          }
          onMsg(`${ids.length} lignes STRESS supprimees.`);
          onRefresh?.();
        } catch (e: any) { onMsg("Purge: " + (e?.message ?? e)); }
        setBusy(""); load();
      }}>Nettoyer tests STRESS</button></div>
      <p><i>Seuils : SQLite OK jusqu'a ~500k tickets/poste. Au-dela : 1 DB/an, purge outbox envoyee, puis central Go + PostgreSQL (table outbox prete).</i></p>
    </div>
  );
}

function Tarifs({ tarifs, onRefresh, onMsg }: { tarifs: Tarif[]; onRefresh: () => void; onMsg?: (m: string) => void }) {
  const [f, setF] = useState({ nom: "", categorie: "PL2", prix_forfait: "2500", prix_tonne_net: "0", seuil: "19000", penalite: "5000" });
  const [editId, setEditId] = useState<string | null>(null);
  const [ev, setEv] = useState<Record<string, string>>({});
  async function add() {
    if (!f.nom.trim()) { onMsg?.("Nom requis."); return; }
    const d = await getDb();
    await d.execute("INSERT INTO tarifs(id,nom,categorie,prix_forfait,prix_tonne_net,seuil_surcharge_kg,penalite_surcharge) VALUES(?,?,?,?,?,?,?)",
      [uid("t"), f.nom, f.categorie, Number(f.prix_forfait) || 0, Number(f.prix_tonne_net) || 0, Number(f.seuil) || 0, Number(f.penalite) || 0]);
    onRefresh(); onMsg?.("Tarif ajoute.");
  }
  async function save(id: string) {
    const d = await getDb();
    await d.execute("UPDATE tarifs SET nom=?,categorie=?,prix_forfait=?,prix_tonne_net=?,seuil_surcharge_kg=?,penalite_surcharge=? WHERE id=?",
      [ev.nom, ev.categorie, Number(ev.prix_forfait) || 0, Number(ev.prix_tonne_net) || 0, Number(ev.seuil_surcharge_kg) || 0, Number(ev.penalite_surcharge) || 0, id]);
    setEditId(null); onRefresh();
  }
  async function toggle(t: Tarif) {
    const d = await getDb();
    const cur = await d.select<any[]>("SELECT actif FROM tarifs WHERE id=?", [t.id]);
    await d.execute("UPDATE tarifs SET actif=? WHERE id=?", [cur[0]?.actif ? 0 : 1, t.id]);
    onRefresh();
  }
  async function del(t: Tarif) {
    if (!confirm(`Supprimer tarif ${t.nom} ?`)) return;
    const d = await getDb();
    await d.execute("DELETE FROM tarifs WHERE id=?", [t.id]);
    onRefresh();
  }
  return <div className="card"><h3>Grille peage - CRUD</h3>
    <table><thead><tr><th>Cat</th><th>Nom</th><th>Forfait</th><th>F/T</th><th>Seuil</th><th>Penalite</th><th>Actions</th></tr></thead><tbody>
      {tarifs.map((t) => editId === t.id ? (
        <tr key={t.id}>
          <td><input value={ev.categorie} onChange={(e) => setEv({ ...ev, categorie: e.target.value })} style={{ width: 70 }} /></td>
          <td><input value={ev.nom} onChange={(e) => setEv({ ...ev, nom: e.target.value })} /></td>
          <td><input value={ev.prix_forfait} onChange={(e) => setEv({ ...ev, prix_forfait: e.target.value })} style={{ width: 80 }} /></td>
          <td><input value={ev.prix_tonne_net} onChange={(e) => setEv({ ...ev, prix_tonne_net: e.target.value })} style={{ width: 70 }} /></td>
          <td><input value={ev.seuil_surcharge_kg} onChange={(e) => setEv({ ...ev, seuil_surcharge_kg: e.target.value })} style={{ width: 90 }} /></td>
          <td><input value={ev.penalite_surcharge} onChange={(e) => setEv({ ...ev, penalite_surcharge: e.target.value })} style={{ width: 90 }} /></td>
          <td><button onClick={() => save(t.id)}><Check size={14} /> OK</button></td>
        </tr>
      ) : (
        <tr key={t.id}><td>{t.categorie}</td><td>{t.nom}</td><td>{t.prix_forfait}</td><td>{t.prix_tonne_net}</td><td>{t.seuil_surcharge_kg}</td><td>{t.penalite_surcharge}</td>
          <td><button onClick={() => { setEditId(t.id); setEv({ nom: t.nom, categorie: t.categorie, prix_forfait: String(t.prix_forfait), prix_tonne_net: String(t.prix_tonne_net), seuil_surcharge_kg: String(t.seuil_surcharge_kg), penalite_surcharge: String(t.penalite_surcharge) }); }}>Modifier</button> <button onClick={() => toggle(t)}>Off</button> <button onClick={() => del(t)}><X size={14} /></button></td></tr>
      ))}
    </tbody></table>
    <div className="row"><input value={f.nom} onChange={(e) => setF({ ...f, nom: e.target.value })} placeholder="Nom..." style={{ flex: 2 }} />
      <select value={f.categorie} onChange={(e) => setF({ ...f, categorie: e.target.value })}><option>VL</option><option>PL2</option><option>PL3</option><option>PL4+</option></select>
      <input value={f.prix_forfait} onChange={(e) => setF({ ...f, prix_forfait: e.target.value })} placeholder="Forfait" style={{ maxWidth: 90 }} />
      <button onClick={add}><Plus size={14} /> Ajouter</button>
      <button onClick={onRefresh}><RefreshCw size={14} /></button></div></div>;
}

function StepBar({ immat, ouverts, liveKg, seuil }: any) {
  const hasImmat = immat.trim().length > 0;
  const hasOpen = hasImmat && ouverts.some((o: any) => o.immat === immat.toUpperCase());
  const hasWeight = liveKg >= seuil;
  const steps = [
    { label: "1. Immat", done: hasImmat },
    { label: hasOpen ? "2. 2e passage detecte" : "2. Poids", done: hasWeight },
    { label: "3. Valider", done: false },
  ];
  return (
    <div className="steps">
      {steps.map((s, i) => (
        <div key={i} className={`step ${s.done ? "done" : ""}`}><span className="dot">{s.done ? <Check size={12} /> : i + 1}</span> {s.label}</div>
      ))}
    </div>
  );
}

function ResultCard({ r, onPrint, onClose }: any) {
  const F = (n: number) => Number(n || 0).toLocaleString();
  return (
    <div className="card pop" style={{ borderColor: r.surcharge ? "#f59e0b" : "#22c55e", marginTop: 10 }}>
      <h3>{r.kind === "sortie" ? "2e pesee calculee" : "Pesee enregistree"} - {r.ticket} <button style={{ float: "right" }} onClick={onClose}><X size={14} /></button></h3>
      <p><b>{r.immat}</b>{r.remorque ? ` + ${r.remorque}` : ""} {r.produit ? `- ${r.produit}` : ""} {r.transporteur ? `(${r.transporteur})` : ""}{r.chantier ? ` - ${r.chantier}` : ""}</p>
      <table><tbody>
        <tr><td>1er poids (P1)</td><td><b>{F(r.p1)} kg</b></td><td>2e poids (P2)</td><td><b>{r.p2 == null ? "-" : F(r.p2) + " kg"}</b></td></tr>
        <tr><td>Brut (max)</td><td><b>{F(r.brut)} kg</b></td><td>Tare veh. (min)</td><td><b>{F(r.tare)} kg</b></td></tr>
        <tr><td>Tare rem.</td><td><b>{F(r.tareRem)} kg</b></td><td>Transaction</td><td><b>{r.ticket}</b></td></tr>
        <tr><td>NET</td><td style={{ fontSize: 18 }}><b>{F(r.net)} kg</b></td><td>Montant</td><td style={{ fontSize: 18 }}><b>{F(r.montant)} F</b></td></tr>
      </tbody></table>
      <p><i>Detail : forfait {F(r.forfait)} + poids {F(r.partPoids)}{r.penalite ? ` + surcharge ${F(r.penalite)}` : ""} = {F(r.montant)} F ({r.paiement}){r.surcharge ? " - ! SURCHARGE" : ""}</i></p>
      <div className="row"><button onClick={onPrint}><Printer size={14} /> Imprimer le ticket</button></div>
    </div>
  );
}

function RightPanelTickets({ ouverts, tickets, onPrint }: any) {
  const [sub, setSub] = useState<"attente" | "derniers">("attente");
  const derniers = tickets.filter((t: any) => t.statut !== "ouvert").slice(0, 10);
  return (
    <div>
      <div className="tabs" style={{ marginTop: 0 }}>
        <button className={sub === "attente" ? "on" : ""} onClick={() => setSub("attente")}>En attente ({ouverts.length})</button>
        <button className={sub === "derniers" ? "on" : ""} onClick={() => setSub("derniers")}>Derniers</button>
      </div>
      {sub === "attente" ? (
        ouverts.length === 0 ? <p><i>Pont libre - aucun camion en attente.</i></p> :
        <table><thead><tr><th>Immat</th><th>P1</th><th>Depuis</th><th>Impr.</th></tr></thead><tbody>
          {ouverts.map((t: any) => <tr key={t.id}><td><b>{t.immat}</b></td><td>{t.poids1.toLocaleString()}</td><td>{String(t.entree_le).slice(11, 16)}</td>
            <td><button title="Imprimer" onClick={() => onPrint(t)}><Printer size={14} /></button></td></tr>)}
        </tbody></table>
      ) : (
        <table><thead><tr><th>Ticket</th><th>Immat</th><th>Net</th><th>Statut</th><th>Impr.</th></tr></thead><tbody>
          {derniers.map((t: any) => <tr key={t.id}><td>{t.ticket.slice(-8)}</td><td><b>{t.immat}</b></td><td>{t.net == null ? "-" : t.net.toLocaleString()}</td><td><span className={`pill ${t.statut}`}>{t.statut}</span></td>
            <td><button title="Imprimer" onClick={() => onPrint(t)}><Printer size={14} /></button></td></tr>)}
        </tbody></table>
      )}
    </div>
  );
}

function Manual({ onValider }: { onValider: (v: number) => void }) {
  const [v, setV] = useState("");
  return <div className="row"><input value={v} onChange={(e) => setV(e.target.value)} placeholder="kg ex 24500" /><button onClick={() => onValider(Number(v) || 0)}>Valider manuel</button></div>;
}



