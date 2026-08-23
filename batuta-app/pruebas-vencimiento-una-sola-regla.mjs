/* ─────────────────────────────────────────────────────────────────────────────
   «¿ESTE PLAN YA VENCIÓ?» SE RESPONDE IGUAL EN TODOS LADOS     (23-ago-2026)

   Dos sitios se hacían la cuenta a mano en vez de usar `venceVencido`:

   1) Al reservar, la **mensualidad ilimitada** comparaba
      `Date.parse(vence+"T23:59:59Z") < Date.now()` **sin el corte de Lima**, mientras
      TRES LÍNEAS más abajo el plan por clases sí usaba `venceVencido`. Dos reglas
      para la misma pregunta, una al lado de la otra: a la alumna con mensualidad
      se le decía «venció» desde las **19:00 del último día**, cinco horas antes que
      a su compañera con paquete. Elevate tiene 2 alumnas así.

   2) `venceVencidoPanel` parseaba **sin la «Z»**, o sea en la zona del NAVEGADOR:
      en Lima daba bien por casualidad y en cualquier otra zona mataba el pase a
      una hora distinta que el servidor.

   Se corren las dos implementaciones contra la del worker, hora por hora.
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cargarMotor } from "./motor-real.mjs";
const RUTA_PANEL = process.env.BATUTA_PANEL || (process.env.HOME + "/Code/mvt/web/batuta-app/public/panel/index.html");
const SRC = readFileSync(process.env.BATUTA_WORKER || (process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js"), "utf8");
const H = readFileSync(RUTA_PANEL, "utf8");
let fallos = 0;
const comprobar = (t, ok, extra) => { console.log(`  ${ok ? "✅" : "🔴"} ${t}${extra ? " · " + extra : ""}`); if (!ok) fallos++; };
const sinCom = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " "));
const W = await cargarMotor(["venceVencido"]);

console.log("── 1. Al reservar, mensualidad y paquete preguntan lo mismo ──");
{
  const limpio = sinCom(SRC);
  comprobar("la mensualidad usa `venceVencido`", /if \(pkR\.ilim && venceVencido\(alumno\.vence\)\)/.test(limpio));
  comprobar("y el plan por clases también", /if \(!pkR\.ilim && venceVencido\(alumno\.vence\)\)/.test(limpio));
  comprobar("ya nadie se hace la cuenta a mano en ese bloque",
    !/const vms = Date\.parse\(alumno\.vence \+ "T23:59:59Z"\)/.test(limpio));
}

console.log("\n── 2. El panel corta a la misma hora que el servidor ──");
{
  const real = Date.now;
  const cortar = n => { const i = H.indexOf("\nfunction " + n + "("); if (i < 0) return "";
    let k = H.indexOf("{", i), d = 0;
    for (; k < H.length; k++){ if (H[k] === "{") d++; else if (H[k] === "}" && --d === 0) return H.slice(i + 1, k + 1); } return ""; };
  const vvPanel = new Function(cortar("venceVencidoPanel") + "\nreturn venceVencidoPanel;")();
  const choques = [];
  for (let h = 0; h < 24; h++){
    for (const off of [-1, 0, 1]){
      const t = Date.parse("2026-08-22T" + String(h).padStart(2, "0") + ":30:00Z") + 5 * 3600000;
      Date.now = () => t;
      const f = new Date(t - 5 * 3600000 + off * 86400000).toISOString().slice(0, 10);
      if (vvPanel(f) !== W.venceVencido(f)) choques.push(String(h).padStart(2, "0") + ":30 · " + f);
    }
  }
  Date.now = real;
  comprobar("las 72 combinaciones coinciden", choques.length === 0,
    choques.length ? choques.length + " se contradicen, la primera: " + choques[0] : "24 horas × 3 fechas");
}

console.log("\n── 3. Y desde cualquier zona horaria del dueño ──");
{
  const leer = tz => execFileSync(process.execPath, ["-e", `
    const fs=require('fs');
    const H=fs.readFileSync(${JSON.stringify(RUTA_PANEL)},'utf8');
    const i=H.indexOf('\\nfunction venceVencidoPanel(');
    let k=H.indexOf('{',i),d=0,src='';
    for(;k<H.length;k++){ if(H[k]==='{')d++; else if(H[k]==='}'&&--d===0){ src=H.slice(i+1,k+1); break; } }
    const f=new Function(src+'\\nreturn venceVencidoPanel;')();
    const t=Date.parse('2026-08-23T01:00:00Z');   // 22-ago 20:00 de Lima
    Date.now=()=>t;
    console.log(f('2026-08-22')?'VENCIDO':'vivo');`,
  ], { env: { ...process.env, TZ: tz } }).toString().trim();
  const enLima = leer("America/Lima");
  comprobar("en Lima, a las 20:00 del día que vence, sigue vivo", enLima === "vivo", enLima);
  for (const tz of ["UTC", "Europe/Madrid", "Asia/Tokyo"])
    comprobar("y con el reloj en " + tz + " dice lo mismo", leer(tz) === enLima, leer(tz));
}

console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n✅ una sola respuesta a «¿ya venció?»");
process.exit(fallos ? 1 : 0);
