-- Backfill: las clases que el cierre automático dio por asistidas y nunca anotó
-- (15-ago-2026, reporte de José / Elevate: "en su perfil no aparece la clase que tomaron").
--
-- QUÉ PASÓ: `cerrarAsistenciasAuto` marcaba la reserva 'completada' pero no escribía la fila en
-- `registro`. El marcado A MANO sí lo hacía. Como el historial del alumno y el del panel salen
-- de `registro`, la academia que dejó la asistencia en automático se quedó con las clases
-- dictadas invisibles. El código ya quedó arreglado; esto recupera las que ya habían pasado.
--
-- POR QUÉ NO COBRA DOBLE: `reservasUsadasPuro` empareja cada reserva pasada con una fila de
-- registro del mismo día, así que la clase se sigue contando UNA vez. Verificado en
-- pruebas-saldo-al-asistir.mjs (caso Carlos: 3 dictadas, 1 anotada, consume 3 y no 4).
--
-- UNA fila por alumno + día de Lima + ciclo: es la misma guarda idempotente que usa el código
-- (/agenda/marcar y "vino sin reservar"). El GROUP BY es lo que la impone acá.
-- El NOT EXISTS hace que correrlo dos veces no duplique nada.
--
--   npx wrangler d1 execute batuta-app --remote --file=db/2026-08-15-bitacora-clases-cerradas-solas.sql
--
-- Ensayo en seco al 15-ago: 51 filas, todas de Elevate (12-ago 1 · 13-ago 19 · 14-ago 14 · 15-ago 17).

INSERT INTO registro (id, tenant_id, fecha, alumno_id, curso, estado, trabajo, tarea, ciclo, tarea_audio, plan)
SELECT
  lower(hex(randomblob(16))),
  r.tenant_id,
  date(r.inicio_utc, '-5 hours'),          -- fecha de Lima, igual que fechaLimaDe() en el worker
  r.alumno_id,
  MIN(COALESCE(r.curso, '')),              -- 2 clases el mismo día: se anota el curso de la primera
  'Asistió',
  '', '',
  COALESCE(r.ciclo, 1),
  '', ''
FROM reservas r
WHERE r.estado = 'completada'
  AND r.alumno_id IS NOT NULL
  AND r.tipo != 'bloqueo'
  AND NOT EXISTS (
    SELECT 1 FROM registro g
    WHERE g.tenant_id = r.tenant_id
      AND g.alumno_id = r.alumno_id
      AND COALESCE(g.ciclo, 1) = COALESCE(r.ciclo, 1)
      AND g.fecha = date(r.inicio_utc, '-5 hours')
      AND g.estado != 'Reprogramó'
  )
GROUP BY r.tenant_id, r.alumno_id, date(r.inicio_utc, '-5 hours'), COALESCE(r.ciclo, 1);
