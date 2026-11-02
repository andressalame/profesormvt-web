#!/usr/bin/env python3
"""Auditoría EN VIVO de lo que pidió Laura (2-nov-2026), por etapas. Monta una academia de mentira
(LZ-T) en producción, le habla al worker por HTTP como lo harían el panel y el portal, y la borra al final.
Uso:  python3 auditoria-laura-vivo.py creditos   (otras etapas se suman acá)
"""
import json, subprocess, sys, secrets, datetime, urllib.request, urllib.error, os
BASE = "https://batuta-app.andressalame.workers.dev"
T, P = "LZ-T", "LZ-P"
os.chdir(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("CLOUDFLARE_ACCOUNT_ID", "d6762650e83c09d554b1e3413c03b43d")
fallos = 0
def ver(ok, bien, mal):
    global fallos
    print(("✅ " if ok else "❌ ") + (bien if ok else mal))
    if not ok: fallos += 1
def d1(sql):
    r = subprocess.run(["npx", "wrangler", "d1", "execute", "batuta-app", "--remote", "--json", "--command", sql], capture_output=True, text=True)
    try: return json.loads(r.stdout)[0]["results"]
    except Exception: return []
def http(metodo, ruta, token=None, cuerpo=None):
    req = urllib.request.Request(BASE + ruta, method=metodo, data=json.dumps(cuerpo).encode() if cuerpo is not None else None)
    req.add_header("content-type", "application/json"); req.add_header("user-agent", "auditoria-laura")
    if token: req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except Exception: return e.code, {}
def limpiar():
    tablas = ["creditos_recup","espera","reservas","disponibilidad","cuentas","alumnos","profesores","precios","config","registro","bonos_log","api_cambios"]
    hay = {r["name"] for r in d1("SELECT name FROM sqlite_master WHERE type='table'")}
    d1("; ".join(f"DELETE FROM {t} WHERE tenant_id = '{T}'" for t in tablas if t in hay) + f"; DELETE FROM sesiones WHERE cuenta_id LIKE 'LZ-%' OR cuenta_id = 'P:LZ-P'; DELETE FROM tenants WHERE id = '{T}'")
    q = d1(f"SELECT (SELECT COUNT(*) FROM tenants WHERE id='{T}') t,(SELECT COUNT(*) FROM alumnos WHERE tenant_id='{T}') a,(SELECT COUNT(*) FROM reservas WHERE tenant_id='{T}') r")
    print("   quedan:", q[0] if q else "?")
def sembrar(paquete='[{"n":"2 clases","c":2,"r":0,"u":false,"t":[],"d":0,"i":"compra"}]', nombres=("ANA",)):
    limpiar()
    lote = []
    ins = lote.append
    ins(f"INSERT INTO tenants (id,slug,academia,profe_nombre,email,whatsapp,pass_hash,pass_salt,trial_hasta,plan,estado,creado) VALUES ('{T}','lz-t','Auditoria Laura','D','lz@ejemplo.invalid','','NOSIRVE','NOSIRVE','2027-01-01','base','activo','2026-11-02T00:00:00Z')")
    ins(f"INSERT INTO profesores (id,tenant_id,nombre,email,rol,estado,creado) VALUES ('{P}','{T}','Profe','p@ejemplo.invalid','dueno','activo','2026-11-02')")
    ins(f"INSERT INTO config (tenant_id,clave,valor) VALUES ('{T}','paquetes','{paquete}')")
    ins(f"INSERT INTO config (tenant_id,clave,valor) VALUES ('{T}','anticipacion_h','1')")
    admin = secrets.token_hex(32)
    exp = (datetime.datetime.utcnow() + datetime.timedelta(days=1)).isoformat() + "Z"
    ins(f"INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('{admin}','P:{P}','{exp}')")
    portal = {}
    for n in nombres:
        ins(f"INSERT INTO alumnos (id,tenant_id,codigo,nombre,apellido,curso,paquete,pago,ciclo,profesor_id,fecha) VALUES ('LZ-{n}','{T}','C{n}','{n}','Prueba','Ballet','2 clases','Pagado',1,'{P}','2026-11-01')")
        ins(f"INSERT INTO cuentas (id,tenant_id,email,nombre,whatsapp,pass_hash,pass_salt,marketing,alumno_id,creada,ref_code,ref_por,credito) VALUES ('LZ-C{n}','{T}','{n}@ejemplo.invalid','{n} Prueba','','x','x',0,'LZ-{n}','2026-11-01','','',0)")
        tk = secrets.token_hex(32); portal[n] = tk
        ins(f"INSERT INTO sesiones (token,cuenta_id,expira) VALUES ('{tk}','LZ-C{n}','{exp}')")
    d1("; ".join(lote))
    return admin, portal
def slot(dias=3):
    d = datetime.datetime.utcnow().replace(minute=0, second=0, microsecond=0, hour=15) + datetime.timedelta(days=dias)   # 10:00 Lima
    return d.strftime("%Y-%m-%dT%H:00:00.000Z"), int(((d - datetime.timedelta(hours=5)).strftime("%w"))), "10:00"
def horario(iso_dow_hora, cupo=5, curso="Ballet"):
    iso, dow, hora = iso_dow_hora
    d1(f"INSERT INTO disponibilidad (tenant_id,profesor_id,dia_semana,hora,activo,cupo,curso,sala,profe) VALUES ('{T}','{P}',{dow},'{hora}',1,{cupo},'{curso}','','{P}')")
def reserva_pasada(rid, alumno, horas_atras=30, estado="reservada"):
    ini = (datetime.datetime.utcnow() - datetime.timedelta(hours=horas_atras)).replace(minute=0, second=0, microsecond=0)
    fin = ini + datetime.timedelta(hours=1)
    d1(f"INSERT INTO reservas (id,tenant_id,alumno_id,inicio_utc,fin_utc,tipo,estado,curso,ciclo,profesor_id,sala) VALUES ('{rid}','{T}','LZ-{alumno}','{ini.strftime('%Y-%m-%dT%H:%M:%S.000Z')}','{fin.strftime('%Y-%m-%dT%H:%M:%S.000Z')}','suelta','{estado}','Ballet',1,'{P}','')")

def etapa_creditos():
    admin, portal = sembrar()
    st, r = http("POST", "/app/api/admin/config", admin, {"cred_on": "1", "cred_max_mes": "1", "cred_vence_dias": "30"})
    ver(st == 200, "el panel guarda los ajustes de créditos", f"config devolvió {st} {r}")
    # el sello «rige desde hoy» es a propósito (no hay créditos retroactivos): para la prueba lo retrocedemos
    d1(f"UPDATE config SET valor = '{(datetime.date.today() - datetime.timedelta(days=10)).isoformat()}' WHERE tenant_id = '{T}' AND clave = 'cred_desde'")
    reserva_pasada("LZ-R1", "ANA", 30); reserva_pasada("LZ-R2", "ANA", 30)
    st, r = http("POST", "/app/api/admin/agenda/marcar", admin, {"id": "LZ-R1", "estado": "falta"})
    ver(st == 200, "la administración marca la falta", f"marcar devolvió {st} {r}")
    st, r = http("GET", "/app/api/agenda/creditos", portal["ANA"])
    ver(st == 200 and r.get("activos") == 1, "la alumna ve su crédito (1 disponible)", f"portal creditos: {st} {r}")
    http("POST", "/app/api/admin/agenda/marcar", admin, {"id": "LZ-R2", "estado": "falta"})
    st, r = http("GET", "/app/api/admin/creditos?alumno_id=LZ-ANA", admin)
    ver(st == 200 and len(r.get("creditos", [])) <= 2 and sum(1 for c in r["creditos"] if c["estado"] == "activo") == 1,
        "dos faltas, mismo mes (o vecino): respeta el tope de 1 por mes", f"tope mal: {st} {[ (c['mes'],c['estado']) for c in r.get('creditos',[])]}")
    # sin saldo (la falta consumió su única clase): reservar normal falla, con crédito pasa
    horario(slot())
    iso = slot()[0]
    st, r = http("POST", "/app/api/agenda/reservar", portal["ANA"], {"inicio_utc": iso, "tipo": "suelta"})
    ver(st == 409, "sin crédito ni saldo no puede reservar", f"debió dar 409 y dio {st} {r}")
    st, r = http("POST", "/app/api/agenda/reservar", portal["ANA"], {"inicio_utc": iso, "tipo": "suelta", "usar_credito": True})
    ver(st == 200 and r.get("con_credito"), "reservar CON el crédito funciona", f"reservar con crédito: {st} {r}")
    c = d1(f"SELECT estado, usado_reserva_id FROM creditos_recup WHERE tenant_id='{T}' AND alumno_id='LZ-ANA' AND estado='usado'")
    ver(len(c) == 1 and c[0]["usado_reserva_id"], "el crédito quedó usado y anotado con la clase", f"libro: {c}")
    st, r = http("GET", "/app/api/agenda/creditos", portal["ANA"])
    ver(r.get("activos") == 0, "ya no le quedan créditos", f"{r}")
    rid = d1(f"SELECT id FROM reservas WHERE tenant_id='{T}' AND estado='reservada' AND alumno_id='LZ-ANA'")[0]["id"]
    st, r = http("POST", "/app/api/agenda/cancelar", portal["ANA"], {"id": rid})
    ver(st == 200, "cancela a tiempo", f"cancelar: {st} {r}")
    st, r = http("GET", "/app/api/agenda/creditos", portal["ANA"])
    ver(r.get("activos") == 1, "al cancelar, el crédito vuelve", f"{r}")
    cid = r["creditos"][0]["id"]
    st, r = http("POST", "/app/api/admin/credito", admin, {"accion": "editar", "id": cid, "vence": (datetime.date.today() + datetime.timedelta(days=90)).isoformat()})
    ver(st == 200, "la administración edita la fecha a mano", f"editar: {st} {r}")
    st, r = http("POST", "/app/api/admin/credito", admin, {"accion": "anular", "id": cid})
    ver(st == 200, "la administración lo anula", f"anular: {st} {r}")
    st, r = http("GET", "/app/api/agenda/creditos", portal["ANA"])
    ver(r.get("activos") == 0, "anulado: la alumna ya no lo ve", f"{r}")
    st, r = http("POST", "/app/api/admin/credito", admin, {"accion": "crear", "alumno_id": "LZ-ANA", "nota": "cortesía"})
    ver(st == 200, "la administración da un crédito a mano", f"crear: {st} {r}")

def etapa_asistencia():
    admin, portal = sembrar(nombres=("ANA", "BEA", "CAL", "DAN"))
    st, r = http("POST", "/app/api/admin/config", admin, {"cred_on": "1"})
    d1(f"UPDATE config SET valor = '{(datetime.date.today() - datetime.timedelta(days=10)).isoformat()}' WHERE tenant_id = '{T}' AND clave = 'cred_desde'")
    for n in ("ANA", "BEA", "CAL", "DAN"): reserva_pasada("LZ-R" + n, n, 30)
    for n, est in (("ANA", "completada"), ("BEA", "falta"), ("CAL", "cancelo_tarde"), ("DAN", "cancelada")):
        st, r = http("POST", "/app/api/admin/agenda/marcar", admin, {"id": "LZ-R" + n, "estado": est})
        ver(st == 200, f"marcar {n} como {est}", f"marcar {est}: {st} {r}")
    st, r = http("GET", "/app/api/admin/asistencia", admin)
    por = {x["alumno_id"]: x for x in r.get("resumen", [])}
    ver(st == 200 and por.get("LZ-ANA", {}).get("asistio") == 1 and por.get("LZ-BEA", {}).get("ausente") == 1
        and por.get("LZ-CAL", {}).get("cancelo_tarde") == 1 and por.get("LZ-DAN", {}).get("cancelo_a_tiempo") == 1,
        "el resumen cuenta asistió / ausente / canceló tarde / canceló a tiempo", f"resumen: {st} {r}")
    cred = lambda n: http("GET", "/app/api/agenda/creditos", portal[n])[1].get("activos")
    ver(cred("BEA") == 1, "ausente → recibe crédito", f"BEA {cred('BEA')}")
    ver(cred("DAN") == 0 and cred("ANA") == 0, "canceló a tiempo y asistió → sin crédito", "crédito de más")
    ver(cred("CAL") == 0, "canceló tarde → sin crédito si la academia no lo decidió", "CAL recibió crédito")
    http("POST", "/app/api/admin/config", admin, {"cred_on": "1", "cred_en_tardia": "1"})
    ver(cred("CAL") == 1, "al prender «la cancelación tardía también da crédito», lo recibe", f"CAL {cred('CAL')}")
    saldo = d1(f"SELECT estado, COALESCE(cancel_tipo,'') ct FROM reservas WHERE tenant_id='{T}' ORDER BY id")
    ver([x["ct"] for x in saldo] == ["", "tarde", "", "a_tiempo"] or sorted(x["ct"] for x in saldo) == ["", "", "a_tiempo", "tarde"], "las etiquetas quedaron guardadas", f"{saldo}")

def etapa_prueba():
    admin, portal = sembrar(nombres=("ANA", "BEA", "PRU", "CAL"))
    http("POST", "/app/api/admin/config", admin, {"prueba_plazas": "1", "agenda_cupo": "1"})
    http("GET", "/app/api/agenda/slots", portal["ANA"])     # esto crea las columnas nuevas en producción
    for n in ("PRU", "CAL"):
        st, r = http("POST", "/app/api/admin/alumno/prueba", admin, {"alumno_id": "LZ-" + n, "es_prueba": True})
        ver(st == 200 and r.get("es_prueba") == 1, f"{n} queda marcada como alumna de prueba", f"marcar {n}: {st} {r}")
    horario(slot(), cupo=1)
    iso = slot()[0]
    st, r = http("POST", "/app/api/agenda/reservar", portal["ANA"], {"inicio_utc": iso, "tipo": "suelta"})
    ver(st == 200, "una alumna regular toma la única plaza regular", f"ANA: {st} {r}")
    st, r = http("POST", "/app/api/agenda/reservar", portal["BEA"], {"inicio_utc": iso, "tipo": "suelta"})
    ver(st == 409, "otra regular ya no entra: la clase está llena", f"BEA debió dar 409 y dio {st} {r}")
    st, r = http("GET", "/app/api/agenda/slots", portal["PRU"])
    fr = (r.get("franjas") or {}).get(iso, [{}])[0]
    ver(st == 200 and fr.get("cupo") == 1 and fr.get("ocupados") == 0 and fr.get("estado") == "libre", "la alumna de prueba ve su plaza LIBRE aunque la regular esté llena", f"franja vista por PRU: {fr}")
    st, r = http("POST", "/app/api/agenda/reservar", portal["PRU"], {"inicio_utc": iso, "tipo": "suelta"})
    ver(st == 200, "la alumna de prueba entra en la plaza de prueba", f"PRU: {st} {r}")
    st, r = http("POST", "/app/api/agenda/reservar", portal["CAL"], {"inicio_utc": iso, "tipo": "suelta"})
    ver(st == 409 and "prueba" in json.dumps(r), "una segunda de prueba no entra: ya no quedan plazas de prueba", f"CAL: {st} {r}")
    pl = {x["alumno_id"]: x["plaza"] for x in d1(f"SELECT alumno_id, COALESCE(plaza,'') plaza FROM reservas WHERE tenant_id='{T}' AND estado='reservada'")}
    ver(pl.get("LZ-ANA") == "" and pl.get("LZ-PRU") == "prueba", "cada reserva guardó su tipo de plaza", f"{pl}")
    # el guardado del panel no debe borrar la marca
    st, datos = http("GET", "/app/api/admin/data", admin)
    st2, r = http("PUT", "/app/api/admin/data", admin, {"alumnos": datos["alumnos"], "registro": datos.get("registro", []), "precios": datos.get("precios", {})})
    marcas = {x["id"]: x["es_prueba"] for x in d1(f"SELECT id, COALESCE(es_prueba,0) es_prueba FROM alumnos WHERE tenant_id='{T}'")}
    ver(st2 == 200 and marcas.get("LZ-PRU") == 1 and marcas.get("LZ-CAL") == 1 and marcas.get("LZ-ANA") == 0, "guardar desde el panel conserva quién es de prueba", f"PUT {st2}: {marcas}")
    st, r = http("POST", "/app/api/admin/alumno/convertir", admin, {"alumno_id": "LZ-PRU", "paquete": "2 clases"})
    ver(st == 200 and r.get("ciclo") == 2, "pasar a regular en la misma ficha (ciclo nuevo)", f"convertir: {st} {r}")
    f = d1(f"SELECT id, paquete, ciclo, COALESCE(es_prueba,0) es_prueba FROM alumnos WHERE tenant_id='{T}' AND id='LZ-PRU'")
    n = d1(f"SELECT COUNT(*) n FROM alumnos WHERE tenant_id='{T}'")[0]["n"]
    ver(len(f) == 1 and f[0]["es_prueba"] == 0 and n == 4, "misma ficha, ya regular, y no apareció ningún perfil nuevo", f"{f} total {n}")
    st, r = http("GET", "/app/api/me", portal["PRU"])
    ver(st == 200, "su cuenta del portal sigue funcionando", f"/me {st}")

ETAPAS = {"prueba": etapa_prueba, "creditos": etapa_creditos, "asistencia": etapa_asistencia}
if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] == "limpiar":
        limpiar(); sys.exit(0)
    try:
        for a in sys.argv[1:]: ETAPAS[a]()
    finally:
        print("— limpiando —"); limpiar()
    print("\n🟢 todo en verde" if not fallos else f"\n🔴 {fallos} fallo(s)")
    sys.exit(1 if fallos else 0)
