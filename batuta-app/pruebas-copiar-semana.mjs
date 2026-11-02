/* ─────────────────────────────────────────────────────────────────────────────
   COPIAR UNA SEMANA A OTRA (2-nov-2026, etapa 6 del pedido de Laura)
   Funciones REALES del panel (cortadas, no copiadas): copiarSemanaFranjas + recortarVigencia.
     · cada clase de la semana de origen aparece en la de destino, con su aforo, profesora y sala;
     · una clase que el origen NO tenía esa semana (vigencia de otra fecha) no se copia;
     · la semana de destino queda igual que la de origen (lo que tenía antes se reemplaza) y el resto no se toca;
     · copiar es seguro: no crea ni borra reservas (el guardado del horario nunca las toca).
   ───────────────────────────────────────────────────────────────────────────── */
import { readFileSync } from "node:fs";
const P = readFileSync(new URL("./public/panel/index.html", import.meta.url), "utf8");
let fallos = 0;
const ok = (t, c, x) => { console.log(`  ${c ? "✅" : "🔴"} ${t}${x ? " · " + x : ""}`); if (!c) fallos++; };
const corta = (src, nombre) => { const i = src.indexOf("function " + nombre + "("); if (i < 0) throw new Error("falta " + nombre);
  let k = src.indexOf("{", i), prof = 0; for (; k < src.length; k++){ if (src[k] === "{") prof++; else if (src[k] === "}" && --prof === 0){ k++; break; } } return src.slice(i, k); };
const { copiarSemanaFranjas, recortarVigencia } = eval("(()=>{" + ["vigDiaMas", "recortarVigencia", "copiarSemanaFranjas"].map(n => corta(P, n)).join("\n") + "; return {copiarSemanaFranjas, recortarVigencia}; })()");
const cubre = (r, f) => !((r.vdesde && f < r.vdesde) || (r.vhasta && f > r.vhasta));
const F = (dow, hora, extra) => ({ dia_semana: dow, hora, activo: 1, cupo: 8, curso: "Ballet", sala: "A", profe: "P1", vdesde: "", vhasta: "", ...extra });

/* origen: lunes 2-nov. Semana base: lun 18:00, mié 19:00, sáb 10:00. Una clase solo vale del 9-nov en adelante. */
const base = [F(1, "18:00"), F(3, "19:00"), F(6, "10:00"), F(5, "17:00", { vdesde: "2026-11-09" })];
const c = copiarSemanaFranjas(base, "2026-11-02", "2026-11-16");
ok("se copian las 3 clases que existían esa semana (la que vale desde el 9-nov no)", c.length === 3, c.map(x => x.dia_semana + "@" + x.hora).join(", "));
ok("cada copia vale solo la semana de destino (16 al 22 de nov)", c.every(x => x.vdesde === "2026-11-16" && x.vhasta === "2026-11-22"));
ok("conserva hora, aforo, tipo de clase, sala y profesora", c.every(x => x.cupo === 8 && x.curso === "Ballet" && x.sala === "A" && x.profe === "P1"));
ok("el domingo (dow 0) cae al final de la semana de origen, no al principio", copiarSemanaFranjas([F(0, "09:00")], "2026-11-02", "2026-11-16").length === 1 && copiarSemanaFranjas([F(0, "09:00", { vdesde: "2026-11-08", vhasta: "2026-11-08" })], "2026-11-02", "2026-11-16").length === 1 && copiarSemanaFranjas([F(0, "09:00", { vdesde: "2026-11-02", vhasta: "2026-11-02" })], "2026-11-02", "2026-11-16").length === 0);
ok("las clases apagadas no se copian", copiarSemanaFranjas([F(1, "18:00", { activo: 0 })], "2026-11-02", "2026-11-16").length === 0);

/* aplicar: recortar el destino y sumar las copias */
const destino = [F(1, "07:00", { vdesde: "", vhasta: "" }), F(2, "20:00", { vdesde: "2026-11-16", vhasta: "2026-11-22" })];
const final = recortarVigencia(base.concat(destino), "2026-11-16", "2026-11-22").concat(c);
const el = (f) => final.filter(r => cubre(r, f)).map(r => r.dia_semana + "@" + r.hora).sort().join(" ");
ok("lunes 16: tiene la de las 18:00 (copiada) y la de las 07:00 que valía siempre", final.some(r => r.dia_semana === 1 && r.hora === "18:00" && cubre(r, "2026-11-16")) && final.some(r => r.dia_semana === 1 && r.hora === "07:00" && cubre(r, "2026-11-23")));
ok("la clase de martes 20:00 que solo valía esa semana desaparece de ella", !final.some(r => r.dia_semana === 2 && r.hora === "20:00" && cubre(r, "2026-11-17")));
ok("la semana siguiente (23-nov) NO tiene la copia", !final.some(r => r.hora === "10:00" && r.dia_semana === 6 && r.vdesde === "2026-11-16" && cubre(r, "2026-11-28")));
ok("las otras semanas siguen como estaban (2-nov conserva su lunes 18:00)", final.some(r => r.dia_semana === 1 && r.hora === "18:00" && cubre(r, "2026-11-02")));

/* cableado */
ok("el botón existe y el overlay también", /id="btnDispCopiarSemana"/.test(P) && /id="ovCopiarSemana"/.test(P));
ok("al aceptar se guarda por el mismo camino que el resto del horario (que no toca reservas)", /guardarHorario\("Listo: copiaste la semana/.test(P));
ok("un profesor sin permiso de editar agenda tiene el botón apagado", /#btnDispCopiarSemana,#btnDispDuplicar/.test(P));
console.log(fallos ? `\n🔴 ${fallos} fallo(s)` : "\n🟢 copiar semana: todo en verde");
process.exit(fallos ? 1 : 0);
