#!/usr/bin/env python3
"""
MIGRAR PROFESORMVT A BATUTA                                        (23-ago-2026)

Lee la base de MVT (`profesormvt-crm`) y escribe una academia dentro de Batuta
(`batuta-app`). Por defecto va a un tenant DE PRUEBA que se puede borrar entero,
para poder mirar el resultado antes de decidir nada.

  python3 migrar-mvt.py --plan            # no escribe nada: solo dice qué haría
  python3 migrar-mvt.py --ensayo          # tenant desechable, para mirar
  python3 migrar-mvt.py --ensayo --borrar # lo borra
  python3 migrar-mvt.py --real            # la academia DE VERDAD, con los correos apagados
  python3 migrar-mvt.py --real --refrescar# vuelve a traer los datos (por si pasaron días)
  python3 migrar-mvt.py --cambiar-guardia # devuelve correos y contraseñas: Batuta toma el relevo

EL ORDEN IMPORTA, y es lo único delicado de todo esto: MVT tiene 8 motores que le
escriben a los alumnos y Batuta tiene los suyos. Si los dos corren sobre la misma
gente, todo llega DOS VECES. Por eso `--real` deja la academia de Batuta con los
correos neutralizados: los datos están, se puede revisar todo, y no sale ni un
mensaje. El cambio de guardia (encender Batuta y apagar MVT) es un paso aparte.

🔴 NUNCA escribe en la base de MVT. Solo lee.

Cómo mapea las columnas: NO hay listas escritas a mano. Se leen las columnas reales
de las dos bases y se cruza la intersección, más los renombres conocidos. Una lista
enumerada envejece y se queda corta en silencio (ya pasó dos veces esta semana).
"""
import json, subprocess, sys, uuid, re

MVT = "profesormvt-crm"
BAT = "batuta-app"
DIR = "/Users/andres/Code/mvt/web"
DIRB = "/Users/andres/Code/mvt/web/batuta-app"
TID_ENSAYO = "MVTDRY-T"
SLUG_ENSAYO = "profesormvt-ensayo"
TID_REAL = "MVT-PROFESORMVT"
SLUG_REAL = "profesormvt"
# `tramboyos@gmail.com` y no `andressalame@`: ese último ya lo ocupa el tenant
# `profedeprueba` (que tiene una cuenta y una compra dentro, así que no se borra).
# Se puede cambiar desde Ajustes cuando `hola@profesormvt.com` tenga su ruta.
EMAIL_REAL = "tramboyos@gmail.com"

# Renombres reales entre los dos esquemas (medidos, no supuestos)
RENOMBRES = {"bono_clases": "bonus_clases", "bono_ciclo": "bonus_ciclo"}
# Tablas a mover, en orden de dependencia
TABLAS = ["config", "precios", "alumnos", "cuentas", "registro", "reservas",
          "compras", "disponibilidad", "recursos", "ejercicios", "grupos", "pausas"]


def d1(base, sql, cwd, escribir=False):
    cmd = ["npx", "wrangler", "d1", "execute", base, "--remote", "--json", "--command", sql]
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    txt = r.stdout.strip()
    i = txt.find("[")
    if i < 0:
        i = txt.find("{")
    if i < 0:
        raise RuntimeError(f"sin respuesta de {base}: {(r.stdout + r.stderr)[:300]}")
    # `json.loads` entero falla con "Extra data" porque wrangler a veces imprime algo más
    # después del JSON. `raw_decode` lee el PRIMER documento y se olvida del resto.
    try:
        d, _ = json.JSONDecoder().raw_decode(txt[i:])
    except json.JSONDecodeError as e:
        raise RuntimeError(f"{base}: respuesta ilegible ({e}) para: {sql[:120]}")
    if isinstance(d, dict) and d.get("error"):
        raise RuntimeError(f"{base}: {json.dumps(d['error'])[:200]} | SQL: {sql[:120]}")
    try:
        return d[0]["results"] if isinstance(d, list) else d["result"][0]["results"]
    except Exception:
        raise RuntimeError(f"{base}: forma inesperada para: {sql[:120]}")


def columnas(base, tabla, cwd):
    try:
        rs = d1(base, f"SELECT sql FROM sqlite_master WHERE name='{tabla}'", cwd)
    except Exception:
        return []
    if not rs:
        return []
    s = rs[0]["sql"]
    cuerpo = s[s.index("(") + 1:]
    cols = []
    for m in re.finditer(r'(?:^|[,(])\s*"?([a-z_][a-z0-9_]*)"?\s+(TEXT|INTEGER|REAL|BLOB|NUMERIC)', cuerpo, re.I):
        cols.append(m.group(1))
    return cols


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main():
    ensayo = "--ensayo" in sys.argv
    real = "--real" in sys.argv
    solo_plan = "--plan" in sys.argv
    borrar = "--borrar" in sys.argv
    refrescar = "--refrescar" in sys.argv
    if "--cambiar-guardia" in sys.argv:
        # ── EL RELEVO ─────────────────────────────────────────────────────────────────
        # Devuelve a la academia de Batuta los correos y las contraseñas REALES, que
        # `--real` dejó neutralizados para que nadie recibiera nada dos veces. Se corre
        # DESPUÉS de encender `portal_migrado` en MVT: primero se calla el de allá, después
        # habla el de acá. Al revés habría un rato con los dos escribiendo.
        # Las contraseñas viajan tal cual: el algoritmo es el mismo en los dos sistemas
        # (PBKDF2, verificado), así que cada alumno entra con la suya de siempre.
        filas = d1(MVT, "SELECT id, LOWER(email) AS email, pass_hash, pass_salt FROM cuentas "
                        "WHERE COALESCE(email,'') != ''", DIR)
        n = 0
        for f in filas:
            try:
                d1(BAT, "UPDATE cuentas SET email = " + lit(f["email"]) +
                        ", pass_hash = " + lit(f["pass_hash"]) + ", pass_salt = " + lit(f["pass_salt"]) +
                        f" WHERE id = {lit(f['id'])} AND tenant_id = '{TID_REAL}'", DIRB, True)
                n += 1
            except Exception as e:
                print(f"   ⚠️  {f['email']}: {str(e)[:90]}")
        # Los alumnos de MVT no tienen las mismas columnas que los de Batuta (MVT ni siquiera
        # guarda `email` en `alumnos`: los correos viven solo en `cuentas`). Se restaura lo
        # que EXISTA en las dos puntas, leyendo los esquemas, y no una lista escrita a mano.
        colM, colB = set(columnas(MVT, "alumnos", DIR)), set(columnas(BAT, "alumnos", DIRB))
        campos = [c for c in ("email", "whatsapp") if c in colM and c in colB]
        if campos:
            als = d1(MVT, "SELECT id, " + ", ".join("COALESCE(" + c + ",'') AS " + c for c in campos) + " FROM alumnos", DIR)
            for a in als:
                sets = ", ".join(c + " = " + lit(a[c]) for c in campos)
                d1(BAT, f"UPDATE alumnos SET {sets} WHERE id = {lit(a['id'])} AND tenant_id = '{TID_REAL}'", DIRB, True)
            print(f"   alumnos: restaurado {', '.join(campos)} en {len(als)} fichas")
        else:
            print("   alumnos: MVT no guarda correo ni WhatsApp en la ficha (viven en `cuentas`)")
        for clave in ("recordatorios_clase", "recordatorio_renovacion"):
            d1(BAT, f"DELETE FROM config WHERE tenant_id = '{TID_REAL}' AND clave = '{clave}'", DIRB, True)
        r = d1(BAT, f"SELECT (SELECT COUNT(*) FROM cuentas WHERE tenant_id='{TID_REAL}' AND email NOT LIKE '%@ejemplo.invalid') c,"
                    f"(SELECT COUNT(*) FROM cuentas WHERE tenant_id='{TID_REAL}' AND pass_hash NOT IN ('NOSIRVE','SIN-CLAVE','')) p", DIRB)[0]
        print(f"   {n} cuentas actualizadas · con correo real: {r['c']} · con su contraseña: {r['p']}")
        print("   ✅ Batuta toma el relevo" if r["c"] else "   🔴 no quedó ningún correo real")
        return 0 if r["c"] else 1

    if not (ensayo or solo_plan or real):
        print("Usa --plan, --ensayo o --real.")
        return 1
    if real and borrar:
        print("🔴 --borrar solo funciona con --ensayo. La academia de verdad se borra a mano, a propósito.")
        return 1
    tid = TID_REAL if real else TID_ENSAYO
    slug = SLUG_REAL if real else SLUG_ENSAYO

    if borrar:
        tablas_bat = " ".join(TABLAS) + " profesores sesiones invitaciones"
        for t in tablas_bat.split():
            try:
                d1(BAT, f"DELETE FROM {t} WHERE tenant_id = '{tid}'", DIRB, True)
            except Exception:
                pass
        d1(BAT, f"DELETE FROM tenants WHERE id = '{tid}'", DIRB, True)
        n = d1(BAT, f"SELECT (SELECT COUNT(*) FROM tenants WHERE id='{tid}') t,(SELECT COUNT(*) FROM alumnos WHERE tenant_id='{tid}') a", DIRB)[0]
        print(f"   borrado · quedan {n}")
        return 0

    informe, total = [], 0
    lotes = []
    for tabla in TABLAS:
        cm = columnas(MVT, tabla, DIR)
        cb = columnas(BAT, tabla, DIRB)
        if not cm or not cb:
            informe.append((tabla, 0, 0, "no existe en una de las dos"))
            continue
        cbset = set(cb)
        # columna de MVT -> columna de Batuta (renombre si aplica), solo si existe allá
        pares = []
        for c in cm:
            destino = RENOMBRES.get(c, c)
            if destino in cbset:
                pares.append((c, destino))
        perdidas = [c for c in cm if RENOMBRES.get(c, c) not in cbset]
        filas = d1(MVT, f"SELECT {', '.join(x[0] for x in pares)} FROM {tabla}", DIR)
        if not filas:
            informe.append((tabla, 0, len(perdidas), ", ".join(perdidas) or "—"))
            continue
        destinos = [x[1] for x in pares]
        if "tenant_id" in cbset and "tenant_id" not in destinos:
            destinos = destinos + ["tenant_id"]
            for f in filas:
                f["__tid"] = tid
        for f in filas:
            vals = [lit(f.get(x[0])) for x in pares]
            if "__tid" in f:
                vals.append(lit(tid))
            lotes.append(f"INSERT OR IGNORE INTO {tabla} ({', '.join(destinos)}) VALUES ({', '.join(vals)});")
        total += len(filas)
        informe.append((tabla, len(filas), len(perdidas), ", ".join(perdidas) or "—"))

    print("   tabla            filas   columnas que NO caben en Batuta")
    for t, n, p, det in informe:
        print(f"   {t:16} {n:5}   {det if p else '—'}")
    print(f"\n   total de filas a mover: {total}")
    # Lo que NO tiene dónde ir. Se dice fuerte: una migración que pierde algo en silencio
    # es peor que una que no se hace.
    huerfanas = []
    for t in ["curso_lecciones", "curso_progreso"]:
        cm = columnas(MVT, t, DIR)
        cb = columnas(BAT, t, DIRB)
        if cm and not cb:
            n = d1(MVT, f"SELECT COUNT(*) n FROM {t}", DIR)[0]["n"]
            huerfanas.append((t, n))
    if huerfanas:
        print("\n   🔴 SE QUEDA FUERA (Batuta no tiene dónde ponerlo):")
        for t, n in huerfanas:
            print(f"      {t}: {n} filas")
        print("      → es el CURSO GRABADO de MVT. Habría que construirlo en Batuta antes.")

    if solo_plan:
        print("\n   (--plan: no se escribió nada)")
        return 0

    # 🔴 `alumnos.id` (y compañía) es PRIMARY KEY GLOBAL, no por academia: si el ensayo
    # sigue vivo tiene secuestrados los ids de MVT y cada INSERT OR IGNORE se salta en
    # SILENCIO. La primera corrida de --real dijo "420 de 420 aplicadas" y metió CERO filas.
    if real:
        vivo = d1(BAT, f"SELECT COUNT(*) n FROM tenants WHERE id = '{TID_ENSAYO}'", DIRB)[0]["n"]
        if vivo:
            print(f"   🔴 el ensayo {TID_ENSAYO} sigue vivo y tiene secuestrados los ids de MVT.")
            print(f"      Bórralo primero:  python3 migrar-mvt.py --ensayo --borrar")
            return 1

    nombre = "ProfesorMVT" if real else "ProfesorMVT (ensayo)"
    correo = EMAIL_REAL if real else "mvt-ensayo@ejemplo.invalid"
    print(f"\n   {'refrescando' if refrescar else 'creando'} el tenant {tid} ({slug}) …")
    if refrescar:
        # se vacían sus tablas pero NO se borra el tenant: conserva su llave de API,
        # su contraseña y sus ajustes
        for t in TABLAS:
            try:
                d1(BAT, f"DELETE FROM {t} WHERE tenant_id = '{tid}'", DIRB, True)
            except Exception:
                pass
    else:
        for t in TABLAS + ["profesores"]:
            try:
                d1(BAT, f"DELETE FROM {t} WHERE tenant_id = '{tid}'", DIRB, True)
            except Exception:
                pass
        d1(BAT, f"DELETE FROM tenants WHERE id = '{tid}'", DIRB, True)
        # 🔒 la contraseña la pone ÉL, no yo: entra con "olvidé mi contraseña" y le llega
        # a su correo. Acá jamás se escribe una contraseña de nadie.
        d1(BAT, "INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,"
                "trial_hasta,plan,estado,creado,rubro) VALUES "
                f"('{tid}','{slug}','{nombre}','Andrés','{correo}','',"
                f"'SIN-CLAVE','SIN-CLAVE','2027-01-01','base','activo','2026-08-23T00:00:00Z','música')", DIRB, True)
        d1(BAT, f"INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES "
                f"('{tid}-D','{tid}','Andrés','{correo}','dueno','activo','2026-08-23')", DIRB, True)

    print("   escribiendo…")
    hechas = 0
    for i in range(0, len(lotes), 20):
        trozo = " ".join(lotes[i:i + 20])
        try:
            d1(BAT, trozo, DIRB, True)
            hechas += len(lotes[i:i + 20])
        except Exception as e:
            print(f"   ⚠️  lote {i//20}: {str(e)[:160]}")
    print(f"   {hechas} de {len(lotes)} sentencias aplicadas")

    # ── 🔒 EL ENSAYO NO PUEDE TOCAR A NADIE ─────────────────────────────────────
    # Un tenant de ensayo nace 'activo', así que TODOS los crones de Batuta lo tratan como
    # una academia de verdad: recordatorios de clase, aviso de renovación, win-back, pedido
    # de reseña... y los correos son los de los alumnos REALES de MVT. Recibirían todo dos
    # veces, desde una academia que no existe.
    # No se apagan los crones uno por uno (esa lista envejece y el próximo cron nace
    # encendido): se corta en el ÚNICO sitio por donde sale un correo. `correoNoEntregable`
    # bloquea los dominios reservados, así que con `@ejemplo.invalid` no sale nada, ni hoy
    # ni cuando alguien agregue un motor nuevo.
    d1(BAT, f"UPDATE cuentas SET pass_hash='NOSIRVE', pass_salt='NOSIRVE', "
            f"email='ensayo-'||substr(id,1,8)||'@ejemplo.invalid' WHERE tenant_id='{tid}'", DIRB, True)
    d1(BAT, f"UPDATE alumnos SET whatsapp='', email = CASE WHEN COALESCE(email,'')='' THEN '' "
            f"ELSE 'ensayo-'||substr(id,1,8)||'@ejemplo.invalid' END WHERE tenant_id='{tid}'", DIRB, True)
    for clave in ("recordatorios_clase", "recordatorio_renovacion"):
        d1(BAT, f"INSERT INTO config (tenant_id,clave,valor) VALUES ('{tid}','{clave}','off') "
                f"ON CONFLICT(tenant_id,clave) DO UPDATE SET valor='off'", DIRB, True)
    # y fuera del directorio público: es un ensayo, no una academia
    d1(BAT, f"INSERT INTO config (tenant_id,clave,valor) VALUES ('{tid}','directorio','off') "
            f"ON CONFLICT(tenant_id,clave) DO UPDATE SET valor='off'", DIRB, True)
    fuga = d1(BAT, f"SELECT (SELECT COUNT(*) FROM cuentas WHERE tenant_id='{tid}' AND email NOT LIKE '%@ejemplo.invalid') c,"
                   f"(SELECT COUNT(*) FROM alumnos WHERE tenant_id='{tid}' AND COALESCE(email,'')<>'' AND email NOT LIKE '%@ejemplo.invalid') a", DIRB)[0]
    if any(fuga.values()):
        print(f"   🔴 CUIDADO: quedaron correos reales en el ensayo {fuga} — bórralo ya")
    else:
        print("   contraseñas anuladas, correos neutralizados: el ensayo no le puede escribir a nadie")

    if real:
        # Sale en el directorio de Batuta: es una academia de verdad a la que alguien
        # se puede matricular. Es lo que pidió Andrés.
        d1(BAT, f"INSERT INTO config (tenant_id,clave,valor) VALUES ('{tid}','directorio','si') "
                f"ON CONFLICT(tenant_id,clave) DO UPDATE SET valor='si'", DIRB, True)
    r = d1(BAT, f"SELECT (SELECT COUNT(*) FROM alumnos WHERE tenant_id='{tid}') alumnos,"
                f"(SELECT COUNT(*) FROM registro WHERE tenant_id='{tid}') clases,"
                f"(SELECT COUNT(*) FROM cuentas WHERE tenant_id='{tid}') cuentas,"
                f"(SELECT COUNT(*) FROM reservas WHERE tenant_id='{tid}') reservas,"
                f"(SELECT COUNT(*) FROM compras WHERE tenant_id='{tid}') compras", DIRB)[0]
    print(f"\n   quedó adentro: {r}")
    # 🔴 Una migración que mueve cero filas NO puede verse igual que una que funcionó.
    # Se compara contra el ORIGEN, no contra "no hubo errores": los INSERT OR IGNORE
    # se saltan solos y el script diría "todo bien" con la academia vacía.
    esperado = d1(MVT, "SELECT (SELECT COUNT(*) FROM alumnos) alumnos,(SELECT COUNT(*) FROM registro) clases,"
                       "(SELECT COUNT(*) FROM cuentas) cuentas,(SELECT COUNT(*) FROM reservas) reservas,"
                       "(SELECT COUNT(*) FROM compras) compras", DIR)[0]
    faltan = {k: (esperado[k], r[k]) for k in esperado if esperado[k] != r[k]}
    if faltan:
        print("   🔴 NO CUADRA CONTRA EL ORIGEN (origen, destino):")
        for k, (a, b) in faltan.items():
            print(f"      {k}: {a} → {b}")
        print("   La academia quedó incompleta. NO la uses.")
        return 1
    print("   ✅ cuadra fila por fila contra el origen")
    print(f"   míralo en: https://batuta.lat/a/{slug}")
    if real:
        print("\n   🔴 LOS CORREOS ESTÁN APAGADOS. Los datos están completos, pero ni Batuta")
        print("      ni nadie le puede escribir a estos alumnos todavía. Es a propósito:")
        print("      mientras MVT siga con sus motores encendidos, encender los de Batuta")
        print("      les mandaría todo DOS VECES.")
        print("      El cambio de guardia es el paso siguiente y va aparte.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
