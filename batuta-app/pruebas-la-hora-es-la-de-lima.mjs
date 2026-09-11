/* ─────────────────────────────────────────────────────────────────────────────
   LA CLASE SE DICE A LA HORA DE LIMA, MIRE QUIEN LA MIRE     (22-ago-2026)

   Dos bugs de la misma familia, en las dos puntas:

   1) 🔴 EL CORREO DECÍA EL MES ANTERIOR. `limaParts` devuelve el mes en base 0 y
      `fmtLima` lo imprimía tal cual: una clase del 24 de AGOSTO salía "24/07", y
      enero saldría "00". Los otros cinco sitios que usan `p.m` hacen el +1; este
      era el único que no. Va en los recordatorios de 24h y 1h: **307 correos ya
      salieron así** a alumnas de Elevate.

   2) Desde el 10-set, EL PORTAL DEBE PINTAR LA HORA DEL ALUMNO. La clase sigue
      guardada como un instante UTC y la agenda del profesor sigue definida en Lima,
      pero alguien en Australia tiene que ver el martes 11:00 que realmente vivirá.
      Las fechas civiles del plan (vencimiento/pausa) sí se mantienen en Lima.

   Corre las dos implementaciones y, para el portal, la MISMA fecha bajo varias
   zonas horarias del dispositivo.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cargarMotor } from "./motor-real.mjs";
const RUTA_PORTAL = process.env.BATUTA_PORTAL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/alumnos/index.html");
const H = readFileSync(RUTA_PORTAL, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const W = await cargarMotor(["limaParts", "hhmm", "fmtLima", "fechaLimaDe"]);

/* ── 1 · el mes del correo ──────────────────────────────────────────────────── */
console.log("── 1. La fecha que va en los correos ──");
{
  /* el día que dice `fmtLima` tiene que ser el mismo que guarda `fechaLimaDe` */
  const casos = [
    ["2026-08-25T01:00:00.000Z", "lunes 24 de agosto, 20:00 de Lima", "24/08"],
    ["2026-01-05T15:00:00.000Z", "5 de enero (el mes 0, el que salía «00»)", "05/01"],
    ["2026-12-31T20:00:00.000Z", "31 de diciembre", "31/12"],
    ["2026-03-01T04:30:00.000Z", "28 de febrero 23:30 de Lima, no el 1 de marzo", "28/02"],
  ];
  for (const [iso, que, esperado] of casos){
    const dicho = (W.fmtLima(iso).match(/(\d{2}\/\d{2})/) || [, "?"])[1];
    comprobar(que, dicho === esperado, "el correo dice " + dicho + (dicho === esperado ? "" : " y debería decir " + esperado));
    /* control cruzado: el mismo día que guarda la base */
    const guardado = W.fechaLimaDe(iso);
    const [y, m, d] = guardado.split("-");
    comprobar("   y coincide con la fecha que se GUARDA (" + guardado + ")", dicho === d + "/" + m);
  }
}

/* ── 2 · la hora que ve el alumno, desde cualquier zona ─────────────────────── */
console.log("\n── 2. El portal traduce la misma clase a la zona del alumno ──");
{
  const iso = "2026-08-25T01:00:00.000Z";   // lunes 24, 20:00 de Lima
  const leer = tz => {
    const codigo = `
      const fs=require('fs');
      const H=fs.readFileSync(${JSON.stringify(RUTA_PORTAL)},'utf8');
      /* si la función no existe devuelve "", no el archivo entero desde el byte 0 */
      const cortar=n=>{const i=H.indexOf('\\nfunction '+n+'(');if(i<0) return '';let k=H.indexOf('{',i+1),d=0;
        for(;k<H.length;k++){ if(H[k]==='{')d++; else if(H[k]==='}'&&--d===0) return H.slice(i+1,k+1);} return '';};
      const ini=H.indexOf('var AG_TZ_LOCAL =');
      const fin=H.indexOf('function pintarAgendadas',ini);
      const zona=H.slice(ini,fin);
      const f=new Function('DIAS_LARGO', cortar('partesLima')+zona+cortar('fmtFechaLocal')+cortar('fmtHoraLocal')+
        '\\nreturn {fmtFechaLocal,fmtHoraLocal,fmtFechaLima,etiquetaZonaAgenda};')(["domingo","lunes","martes","miércoles","jueves","viernes","sábado"]);
      console.log(f.fmtFechaLocal(${JSON.stringify(iso)})+" | "+f.fmtHoraLocal(${JSON.stringify(iso)})+" | "+f.etiquetaZonaAgenda()+" | "+f.fmtFechaLima(${JSON.stringify(iso)}));`;
    return execFileSync(process.execPath, ["-e", codigo], { env: { ...process.env, TZ: tz } }).toString().trim();
  };
  const casos = [
    ["America/Lima",      /lunes,? 24 de agosto \| 08:00 p\. m\./, "Lima"],
    ["UTC",               /martes,? 25 de agosto \| 01:00 a\. m\./, "UTC"],
    ["Europe/Madrid",     /martes,? 25 de agosto \| 03:00 a\. m\./, "Madrid"],
    ["America/New_York",  /lunes,? 24 de agosto \| 09:00 p\. m\./, "New York"],
    ["Asia/Tokyo",        /martes,? 25 de agosto \| 10:00 a\. m\./, "Tokyo"],
    ["Australia/Sydney",  /martes,? 25 de agosto \| 11:00 a\. m\./, "Sydney"],
  ];
  for (const [tz, esperado, ciudad] of casos){
    const dicho = leer(tz);
    comprobar(tz + " ve su día y su hora reales", esperado.test(dicho), dicho);
    comprobar("   y la pantalla nombra " + ciudad, dicho.includes(ciudad), dicho);
    comprobar("   pero el vencimiento civil no cambia de fecha", /\| lunes,? 24 de agosto$/.test(dicho), dicho);
  }
}

/* ── 3 · y coincide con lo que dice el correo ───────────────────────────────── */
console.log("\n── 3. En Lima, el correo y el portal cuentan la misma clase ──");
{
  const iso = "2026-08-25T01:00:00.000Z";
  const delCorreo = W.fmtLima(iso);                       // "Lunes 24/08 a las 20:00 (hora de Lima)"
  const dia = (delCorreo.match(/(\d{2})\/(\d{2})/) || [])[1];
  const hora = (delCorreo.match(/a las (\d{2}):(\d{2})/) || [])[1];
  comprobar("el correo dice día 24", dia === "24", "dice " + dia);
  comprobar("y las 20 horas", hora === "20", "dice " + hora);
}

/* ── 4 · ninguna fecha del portal se pinta sin zona ─────────────────────────── */
console.log("\n── 4. Barrido: cada formato declara qué zona usa ──");
{
  const cuerpoOpciones = H.slice(H.indexOf("function opcionesZona"), H.indexOf("function etiquetaZonaAgenda"));
  comprobar("el formateador de la agenda fuerza la zona detectada",
    /o\.timeZone=AG_TZ_LOCAL/.test(cuerpoOpciones), cuerpoOpciones.replace(/\s+/g," ").slice(0,120));
  comprobar("la fecha civil conserva explícitamente America/Lima",
    /function fmtFechaLima[\s\S]*?timeZone:"America\/Lima"/.test(H), "vencimientos y pausas no se desplazan");
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ una clase, el mismo instante y la hora correcta para cada país");
process.exit(fallos ? 1 : 0);
