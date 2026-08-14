-- Enganche de las cuentas del portal que quedaron sueltas (14-ago-2026).
--
-- Contexto: fichaLibrePorCorreo() solo corria en el INSTANTE del registro, asi que las
-- cuentas creadas mientras `alumnos.email` venia vacio del importador quedaron sin ficha
-- PARA SIEMPRE. El alumno entraba a un portal vacio ("no tienes plan") mientras el dueno
-- veia su plan perfecto en el panel. Lo reporto Jose (Elevate) el 14-ago.
--
-- El worker ya reintenta el enganche en cada visita al portal, asi que esto NO es el
-- arreglo: es la reparacion de los que ya quedaron rotos, para que no tengan que esperar
-- a volver a entrar.
--
-- Ensayo en seco del 14-ago: toca exactamente 7 filas, todas de Elevate Studio.
--
-- Las dos reglas duras son las MISMAS del codigo, y por eso no puede enlazar mal:
--   1) el correo tiene que apuntar a UNA sola ficha (dos hermanos con el correo de la
--      mama = ambiguo, no se toca ninguno);
--   2) esa ficha no puede tener ya una cuenta (enlazar una segunda cuenta a la misma
--      ficha seria darle a un desconocido el saldo y el historial de otro alumno).
-- La comparacion va normalizada (LOWER + TRIM) porque el importador guarda el correo tal
-- cual venia del Excel y el registro lo baja a minusculas.

UPDATE cuentas SET alumno_id = (
  SELECT a.id FROM alumnos a
  WHERE a.tenant_id = cuentas.tenant_id
    AND LOWER(TRIM(COALESCE(a.email, ''))) = LOWER(TRIM(cuentas.email))
)
WHERE (alumno_id IS NULL OR alumno_id = '')
  AND TRIM(COALESCE(email, '')) <> ''
  AND (SELECT COUNT(*) FROM alumnos a2
       WHERE a2.tenant_id = cuentas.tenant_id
         AND LOWER(TRIM(COALESCE(a2.email, ''))) = LOWER(TRIM(cuentas.email))) = 1
  AND (SELECT COUNT(*) FROM cuentas c2
       WHERE c2.tenant_id = cuentas.tenant_id
         AND c2.alumno_id = (SELECT a3.id FROM alumnos a3
                             WHERE a3.tenant_id = cuentas.tenant_id
                               AND LOWER(TRIM(COALESCE(a3.email, ''))) = LOWER(TRIM(cuentas.email)))) = 0;
