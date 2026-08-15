-- Referidos configurables por academia (15-ago-2026, pedido de José / Elevate)
--
-- Qué agrega:
--   alumnos.bonus_clases / bonus_ciclo -> clases de REGALO por traer un amigo. Suman saldo
--     en el ciclo indicado (el espejo de migrado_usadas, que resta). Lo que quede sin usar
--     se arrastra al ciclo nuevo cuando el alumno renueva.
--   compras.desc_ref -> descuento de bienvenida del que llega referido. Va aparte de
--     `descuento` a propósito: `descuento` es CRÉDITO del alumno y al confirmar se le resta
--     de su saldo. Si compartieran columna, la rebaja de la academia le vaciaría el crédito.
--
-- El worker las crea solo (ensureAlumnoExtraSchema) la primera vez que alguien confirma una
-- compra, pero eso deja una ventana en la que el saldo se lee sin la columna. Correr esto a
-- mano ANTES de desplegar cierra la ventana.
--
--   npx wrangler d1 execute batuta --remote --file=db/2026-08-15-referidos-por-academia.sql
--
-- Si alguna columna ya existe, ese ALTER falla con "duplicate column name" y NO pasa nada:
-- las demás se aplican igual. Correrlo dos veces es seguro.

ALTER TABLE alumnos ADD COLUMN bonus_clases INTEGER DEFAULT 0;
ALTER TABLE alumnos ADD COLUMN bonus_ciclo  INTEGER DEFAULT 0;
ALTER TABLE compras ADD COLUMN desc_ref     REAL DEFAULT 0;
