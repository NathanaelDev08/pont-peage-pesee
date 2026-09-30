// Backend poste péage : parsing indicateur + utilitaires métier.
// Le stockage principal passe par tauri-plugin-sql (SQLite) côté front.
// Ces commandes Rust gèrent le matériel (RS232) et les calculs critiques.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WeightReading {
    pub kg: i32,
    pub stable: bool,
    pub raw: String,
    pub proto: String,
}

/// Parse trame Mettler-Toledo continue : ex "S  12340 kg", "D   980 kg", "ST,GS, 12340kg"
#[tauri::command]
fn parse_weight_frame(frame: &str, proto: Option<String>) -> WeightReading {
    let p = proto.unwrap_or_else(|| "METTLER_CONT".into());
    let raw = frame.to_string();
    // extraction du premier nombre
    let re = Regex::new(r"-?\d+").unwrap();
    let kg: i32 = re
        .find(frame)
        .and_then(|m| m.as_str().replace(' ', "").parse::<i32>().ok())
        .unwrap_or(0);
    // stabilité : 'S' ou 'ST' en tête => stable ; 'D'/'US'/'-' => instable
    let t = frame.trim_start().to_uppercase();
    let stable = t.starts_with('S') || t.starts_with("ST");
    WeightReading { kg, stable, raw, proto: p }
}

/// Lecture unique sur port série (timeout 1.5s). Retourne la dernière trame stable ou non.
#[tauri::command]
fn read_serial_once(port_name: String, baud: u32, proto: Option<String>) -> Result<WeightReading, String> {
    let p = proto.unwrap_or_else(|| "METTLER_CONT".into());
    if p == "SIMU" {
        // mode démo sans matériel
        use std::time::{SystemTime, UNIX_EPOCH};
        let s = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        let kg = 8000 + ((s % 40) as i32) * 250; // rampe démo
        return Ok(WeightReading { kg, stable: true, raw: format!("S  {kg} kg (SIMU)"), proto: p });
    }
    let mut port = serialport::new(&port_name, baud)
        .timeout(Duration::from_millis(1500))
        .open()
        .map_err(|e| format!("port {port_name}: {e}"))?;
    let mut buf = vec![0u8; 1024];
    let mut acc = String::new();
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_millis(1500) {
        match port.read(&mut buf) {
            Ok(n) if n > 0 => acc.push_str(&String::from_utf8_lossy(&buf[..n])),
            _ => break,
        }
        if acc.contains('\n') || acc.contains('\r') {
            break;
        }
    }
    if acc.trim().is_empty() {
        return Err(format!("aucune trame sur {port_name} (vérifiez baud={baud}, câble RS232)"));
    }
    // prend la dernière ligne non vide
    let line = acc.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or(&acc).to_string();
    Ok(parse_weight_frame_inner(&line, &p))
}

fn parse_weight_frame_inner(frame: &str, proto: &str) -> WeightReading {
    let re = Regex::new(r"-?\d+").unwrap();
    let kg: i32 = re
        .find(frame)
        .and_then(|m| m.as_str().parse::<i32>().ok())
        .unwrap_or(0);
    let t = frame.trim_start().to_uppercase();
    let stable = t.starts_with('S') || t.starts_with("ST");
    WeightReading { kg, stable, raw: frame.to_string(), proto: proto.to_string() }
}

#[tauri::command]
fn list_serial_ports() -> Vec<String> {
    serialport::available_ports()
        .map(|v| v.into_iter().map(|p| p.port_name).collect())
        .unwrap_or_default()
}

/// Calcul péage : forfait catégorie + tonne*net + pénalité surcharge.
#[derive(Debug, Serialize, Deserialize)]
pub struct TariffInput {
    pub forfait: i32,
    pub prix_tonne: i32,
    pub net_kg: i32,
    pub seuil_kg: i32,
    pub penalite: i32,
}

#[tauri::command]
fn compute_tariff(t: TariffInput) -> serde_json::Value {
    let tonnes = (t.net_kg.max(0) as f64) / 1000.0;
    let part_poids = (tonnes * (t.prix_tonne as f64)).round() as i32;
    let surcharge = t.net_kg > t.seuil_kg && t.seuil_kg > 0;
    let montant = t.forfait + part_poids + if surcharge { t.penalite } else { 0 };
    serde_json::json!({ "montant": montant, "part_poids": part_poids, "surcharge": surcharge })
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Bonjour, {name} — poste péage prêt.")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            greet,
            parse_weight_frame,
            read_serial_once,
            list_serial_ports,
            compute_tariff
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
