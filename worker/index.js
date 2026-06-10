/* API CRM ProfesorMVT — Cloudflare Worker + D1
   Destino en el repo: worker/index.js
   Rutas:
     POST /api/login           {codigo}  -> datos SOLO de ese alumno (calculados)
     GET  /api/admin/data      (Authorization: Bearer ADMIN_TOKEN) -> {alumnos, registro, precios}
     PUT  /api/admin/data      (Bearer ADMIN_TOKEN) -> reemplaza todo, transaccional
   Cualquier otra ruta -> assets estáticos del sitio (binding ASSETS)
*/
"use strict";

const PAQUETES = {
  "Paquete 4":    { clases: 4,  reprog: 2 },
  "Paquete 8":    { clases: 8,  reprog: 3 },
  "Paquete 12":   { clases: 12, reprog: 4 },
  "Clase suelta": { clases: 1,  reprog: 0 }
};
const PRECIOS_DEFAULT = { "Paquete 4": 250, "Paquete 8": 450, "Paquete 12": 600, "Clase suelta": 70 };

const json = (data, status) => new Response(JSON.stringify(data), {
  status: status || 200,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

/* Reglas idénticas al Excel/CRM:
   - Asistió y Falta consumen clase.
   - Reprogramar dentro del límite NO consume.
   - Cada reprogramación que excede el límite cuenta como falta (consume clase). */
function compute(alumno, regs, precios) {
  const pk = PAQUETES[alumno.paquete] || { clases: 0, reprog: 0 };
  let asistio = 0, reprogramo = 0, falta = 0;
  for (const r of regs) {
    if (r.estado === "Asistió") asistio++;
    else if (r.estado === "Reprogramó") reprogramo++;
    else if (r.estado === "Falta") falta++;
  }
  const exceso = Math.max(0, reprogramo - pk.reprog);
  const usadas = asistio + falta + exceso;
  const saldo = pk.clases - usadas;
  let estado = "Activo";
  if (saldo <= 0) estado = "Completado — renovar";
  else if (saldo === 1) estado = "⚠ Última clase";
  return {
    compradas: pk.clases,
    usadas,
    restantes: Math.max(0, saldo),
    reprogPermitidas: pk.reprog,
    reprogUsadas: reprogramo,
    reprogRestantes: Math.max(0, pk.reprog - reprogramo),
    estado,
    monto: precios[alumno.paquete] != null ? precios[alumno.paquete] : 0
  };
}

async function loadPrecios(env) {
  const { results } = await env.DB.prepare("SELECT paquete, precio FROM precios").all();
  const p = Object.assign({}, PRECIOS_DEFAULT);
  for (const row of (results || [])) p[row.paquete] = Number(row.precio) || 0;
  return p;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Todo lo que no es /api/* se sirve como sitio estático normal.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS ? env.ASSETS.fetch(request) : json({ error: "No encontrado" }, 404);
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    try {
      /* ---------- Alumno: entrar con código ---------- */
      if (url.pathname === "/api/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const code = String(body.codigo || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json({ error: "Código no válido" }, 404);

        const alumno = await env.DB.prepare("SELECT * FROM alumnos WHERE codigo = ?1").bind(code).first();
        if (!alumno) {
          await new Promise(r => setTimeout(r, 350)); // frena fuerza bruta
          return json({ error: "Código no válido" }, 404);
        }
        const { results } = await env.DB
          .prepare("SELECT fecha, estado, trabajo, tarea FROM registro WHERE alumno_id = ?1 ORDER BY fecha ASC, id ASC")
          .bind(alumno.id).all();
        const regs = results || [];
        const precios = await loadPrecios(env);
        const c = compute(alumno, regs, precios);

        // El alumno recibe SOLO sus datos, nunca el CRM completo.
        return json({
          nombre: alumno.nombre,
          curso: alumno.curso || "",
          paquete: alumno.paquete || "",
          horario: alumno.horario || "",
          pago: alumno.pago || "",
          compradas: c.compradas, usadas: c.usadas, restantes: c.restantes,
          reprogPermitidas: c.reprogPermitidas, reprogUsadas: c.reprogUsadas, reprogRestantes: c.reprogRestantes,
          estado: c.estado, monto: c.monto,
          historial: regs.slice().reverse()
        });
      }

      /* ---------- Admin (solo con tu clave) ---------- */
      if (url.pathname.startsWith("/api/admin/")) {
        const auth = request.headers.get("authorization") || "";
        if (!env.ADMIN_TOKEN || auth !== "Bearer " + env.ADMIN_TOKEN) {
          return json({ error: "No autorizado" }, 401);
        }

        if (url.pathname === "/api/admin/data" && request.method === "GET") {
          const alumnos  = (await env.DB.prepare("SELECT * FROM alumnos ORDER BY nombre").all()).results || [];
          const registro = (await env.DB.prepare("SELECT * FROM registro ORDER BY fecha DESC, id DESC").all()).results || [];
          const precios  = await loadPrecios(env);
          return json({ alumnos, registro, precios });
        }

        if (url.pathname === "/api/admin/data" && request.method === "PUT") {
          const body = await request.json().catch(() => null);
          if (!body || !Array.isArray(body.alumnos) || !Array.isArray(body.registro)) {
            return json({ error: "Cuerpo inválido" }, 400);
          }
          const stmts = [
            env.DB.prepare("DELETE FROM registro"),
            env.DB.prepare("DELETE FROM alumnos"),
            env.DB.prepare("DELETE FROM precios")
          ];
          for (const a of body.alumnos) {
            stmts.push(env.DB.prepare(
              "INSERT INTO alumnos (id,codigo,nombre,whatsapp,curso,paquete,fecha,pago,horario,notas) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
            ).bind(
              a.id, String(a.codigo || "").toUpperCase(), a.nombre,
              a.whatsapp || "", a.curso || "", a.paquete || "",
              a.fecha || "", a.pago || "", a.horario || "", a.notas || ""
            ));
          }
          for (const r of body.registro) {
            stmts.push(env.DB.prepare(
              "INSERT INTO registro (id,fecha,alumno_id,curso,estado,trabajo,tarea) VALUES (?1,?2,?3,?4,?5,?6,?7)"
            ).bind(
              r.id, r.fecha || "", r.alumnoId || r.alumno_id,
              r.curso || "", r.estado || "", r.trabajo || "", r.tarea || ""
            ));
          }
          const precios = body.precios || {};
          for (const k of Object.keys(precios)) {
            stmts.push(env.DB.prepare("INSERT INTO precios (paquete, precio) VALUES (?1, ?2)").bind(k, Number(precios[k]) || 0));
          }
          await env.DB.batch(stmts); // transaccional: o entra todo o no entra nada
          return json({ ok: true, alumnos: body.alumnos.length, registro: body.registro.length });
        }
      }

      return json({ error: "No encontrado" }, 404);
    } catch (e) {
      return json({ error: "Error del servidor" }, 500);
    }
  }
};
