-- Migración: Suscripciones de Mercado Pago (preapproval) sobre la DB ya desplegada.
-- Ejecutar UNA vez contra la D1 de producción: wrangler d1 execute <DB> --file=db/mig-mp.sql
-- (la ejecución la hace Fable; este archivo solo se deja listo)

ALTER TABLE tenants ADD COLUMN mp_preapproval_id TEXT DEFAULT '';
ALTER TABLE tenants ADD COLUMN mp_sub_status TEXT DEFAULT '';
