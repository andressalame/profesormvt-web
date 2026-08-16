/* Demuestra el bug del `.map`: pasarle a resolverPk el objeto {map,list} en vez del map
   hace que NINGÚN paquete propio de la academia se encuentre → 0 clases para todos.
   Usa la config REAL de paquetes de Elevate y las funciones REALES del worker. */
import { readFileSync, existsSync } from "node:fs";
const SRC = readFileSync(process.env.HOME + "/Code/mvt/web/batuta-app/worker/index.js", "utf8");
function cortar(nombre, tipo){
  const re = tipo === "const" ? new RegExp("^const " + nombre + "\\s*=", "m")
                              : new RegExp("(?:^|\\n)(?:async )?function " + nombre + "\\s*\\(", "m");
  const m = re.exec(SRC); if (!m) throw new Error("falta " + nombre);
  const ini = m.index + (SRC[m.index] === "\n" ? 1 : 0);
  if (tipo === "const"){
    let i = SRC.indexOf("=", m.index) + 1, prof = 0;
    for (; i < SRC.length; i++){ const c = SRC[i];
      if ("{[".includes(c)) prof++; else if ("}]".includes(c)) prof--;
      else if (c === ";" && prof === 0) return SRC.slice(ini, i + 1); }
  }
  let i = SRC.indexOf("{", m.index), prof = 0;
  for (; i < SRC.length; i++){ if (SRC[i] === "{") prof++;
    else if (SRC[i] === "}"){ prof--; if (prof === 0){ i++; break; } } }
  return SRC.slice(ini, i);
}
const fuente =
  ["PAQUETES","CLASES_MAX","PAQUETES_MAX"].map(n => cortar(n, "const")).join("\n") + "\n" +
  ["parsePaquetes","resolverPk"].map(n => cortar(n)).join("\n\n") +
  "\nexport { parsePaquetes, resolverPk };";
const { parsePaquetes, resolverPk } = await import("data:text/javascript," + encodeURIComponent(fuente));

/* Esta suite corre contra el dump real de paquetes de Elevate, que vive en /tmp y se borra al
   reiniciar. Sin el archivo NO se puede probar nada, así que se salta con aviso en vez de morir:
   una suite que siempre revienta hace que se deje de mirar el resultado de todas.
   Para regenerarlo: exportar los paquetes de Elevate a /tmp/elevate_paquetes.json. */
if (!existsSync("/tmp/elevate_paquetes.json")){
  console.log("⏭  SALTADA: falta /tmp/elevate_paquetes.json (dump de Elevate, se borra al reiniciar la Mac)");
  process.exit(0);
}
const crudo = readFileSync("/tmp/elevate_paquetes.json", "utf8");
const paq = parsePaquetes(crudo);                       // {map, list}
const NOMBRES = ["12 clases de Pilates con Máquinas", "12 clases de Mat", "48 clases de Pilates con Máquinas"];

console.log("Paquetes reales de Elevate:", paq.list.length, "\n");
let malo = 0, bueno = 0;
for (const n of NOMBRES){
  const conBug = resolverPk(paq, n);        // ❌ le pasa {map,list}
  const conFix = resolverPk(paq.map, n);    // ✅ le pasa el map
  console.log(`  «${n}»`);
  console.log(`     sin .map (como estaba): ${conBug.clases} clases, tipos [${conBug.tipos}]`);
  console.log(`     con .map (arreglado):   ${conFix.clases} clases, tipos [${conFix.tipos}]`);
  if (conBug.clases === 0) malo++;
  if (conFix.clases > 0) bueno++;
}
const ok = malo === NOMBRES.length && bueno === NOMBRES.length;
console.log(ok
  ? `\n✅ Confirmado: sin el .map los ${malo} paquetes daban 0 clases (todos en rojo "Completado — renovar"); con el .map salen bien.`
  : `\n❌ La prueba no reprodujo lo esperado (malo=${malo} bueno=${bueno})`);
process.exit(ok ? 0 : 1);
