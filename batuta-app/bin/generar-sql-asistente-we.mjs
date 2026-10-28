/* Genera migrations/002-webexpress-asistente-preparar.sql desde WE_KB (una sola fuente de verdad).
   Uso: node bin/generar-sql-asistente-we.mjs          (escribe el archivo)
        node bin/generar-sql-asistente-we.mjs --check  (sale con 1 si el archivo no coincide con el modulo)
   No toca D1: solo escribe un .sql que Andres ejecuta a mano. */
import { readFileSync, writeFileSync } from "node:fs";
import { WE_KB } from "../worker/webexpress-asistente.mjs";
import { WE_PHONE, WE_PHONE_RETIRADO, WE_INBOX_TABLE } from "../worker/webexpress-crm-inbox.mjs";

export function sqlPreparar() {
  const kb = JSON.stringify(WE_KB).replace(/'/g, "''");
  return `-- 002: PREPARAR Web Express en la linea COMPARTIDA de Batuta (+51 904 079 121, phone_number_id ${WE_PHONE}). Generado por bin/generar-sql-asistente-we.mjs.
-- Idempotente: se puede ejecutar varias veces. NO enciende el asistente (no toca wa_negocio.enabled en una fila que ya existe).
-- Ejecutar: CLOUDFLARE_ACCOUNT_ID=d6762650e83c09d554b1e3413c03b43d npx wrangler d1 execute batuta-app --remote --file=migrations/002-webexpress-asistente-preparar.sql
-- Es seguro con el worker ACTUAL: solo crea una tabla nueva, copia lo que hay y reapunta el ID.
-- OJO linea compartida: wa_negocio guarda el phone_id de Batuta. El worker NUNCA manda a alumnos o academias a la rama de Web Express
-- (decide webexpress-ruta.mjs por remitente). Aun asi, el interruptor de Web Express es WE_ASSISTANT_ENABLED en wrangler.toml.
-- REVERSION (volver a dejar la linea solo para Batuta): ver migrations/004-webexpress-quitar-linea-compartida.sql.

-- 1) Bandeja v3 (la v2 de la version anterior nunca se aplico en produccion: no se usa): la v1 tenia CHECK(phone_id=${WE_PHONE_RETIRADO}) y SQLite no deja cambiarlo. La v1 queda intacta (reversion).
CREATE TABLE IF NOT EXISTS ${WE_INBOX_TABLE} (
 event_id TEXT NOT NULL CHECK(length(event_id) BETWEEN 1 AND 250),
 phone_id TEXT NOT NULL CHECK(phone_id IN ('${WE_PHONE}','${WE_PHONE_RETIRADO}')),
 waba_id TEXT NOT NULL CHECK(waba_id='2090741322318574'),
 from_phone TEXT NOT NULL,contact_name TEXT NOT NULL DEFAULT '',timestamp_ms INTEGER NOT NULL,
 message_type TEXT NOT NULL,body TEXT,media_id TEXT,
 review_state TEXT NOT NULL,reply_state TEXT NOT NULL DEFAULT 'none' CHECK(reply_state='none'),
 created_at INTEGER NOT NULL,acked_at INTEGER,
 PRIMARY KEY(phone_id,event_id)
);
CREATE INDEX IF NOT EXISTS webexpress_crm_pending_v3 ON ${WE_INBOX_TABLE}(phone_id,waba_id,acked_at,created_at,event_id);
INSERT OR IGNORE INTO ${WE_INBOX_TABLE}(event_id,phone_id,waba_id,from_phone,contact_name,timestamp_ms,message_type,body,media_id,review_state,reply_state,created_at,acked_at)
 SELECT event_id,phone_id,waba_id,from_phone,contact_name,timestamp_ms,message_type,body,media_id,review_state,reply_state,created_at,acked_at FROM webexpress_crm_inbox;

-- 2) Negocio 'webexpress': ID nuevo + base de conocimiento. Si la fila existe se conserva enabled y cap_mes.
CREATE TABLE IF NOT EXISTS wa_negocio (id TEXT PRIMARY KEY, nombre TEXT NOT NULL, phone_id TEXT NOT NULL, enabled TEXT DEFAULT 'off', kb TEXT DEFAULT '', cap_mes INTEGER DEFAULT 1000, creado TEXT DEFAULT '', actualizado TEXT DEFAULT '');
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_negocio_phone ON wa_negocio (phone_id);
INSERT INTO wa_negocio (id, nombre, phone_id, enabled, kb, cap_mes, creado, actualizado)
 VALUES ('webexpress', 'Web Express', '${WE_PHONE}', 'off', '${kb}', 300, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 ON CONFLICT(id) DO UPDATE SET nombre = 'Web Express', phone_id = '${WE_PHONE}', kb = excluded.kb, actualizado = strftime('%Y-%m-%dT%H:%M:%fZ','now');
`;
}
const archivo = new URL("../migrations/002-webexpress-asistente-preparar.sql", import.meta.url);
if (process.argv[1] && process.argv[1].endsWith("generar-sql-asistente-we.mjs")) {
  const nuevo = sqlPreparar();
  if (process.argv.includes("--check")) {
    let actual = ""; try { actual = readFileSync(archivo, "utf8"); } catch (e) {}
    if (actual !== nuevo) { console.error("002 no coincide con WE_KB: corre node bin/generar-sql-asistente-we.mjs"); process.exit(1); }
    console.log("002 coincide con WE_KB");
  } else { writeFileSync(archivo, nuevo); console.log("escrito", archivo.pathname); }
}
