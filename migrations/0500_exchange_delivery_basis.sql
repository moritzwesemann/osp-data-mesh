-- Austauschprotokoll: Einstufung, unter der eine Lieferung an einen Partner erfolgte.
--   data_category   Datenkategorie des Produkts bei der Lieferung (Kategorie des Datensatzes bzw. 'master')
--   consent_applied true, wenn nur Personen mit gültiger Einwilligung für Zweck und diese Kategorie
--                   geliefert wurden (Einwilligungspflicht der Freigabe oder besondere Kategorie)
-- Ein Einwilligungswiderruf wird gegen diese Angaben geprüft (federation/outbox.ts), nicht gegen die
-- heutige Einstufung: nach einer Neueinstufung des Datensatzes beruht die Kopie beim Partner weiterhin
-- auf der Einwilligung, unter der geliefert wurde. Gesetzt nur für gelieferte ausgehende Datenabrufe.

alter table exchange_log
  add column data_category text,
  add column consent_applied boolean;

-- Bisherige Lieferungen: bestmöglich aus dem heutigen Stand (frühere Einstufungen sind nicht bekannt)
update exchange_log el
   set data_category = coalesce(d.category, case when p.source_type = 'athletes' then 'master' end),
       consent_applied = r.requires_consent or coalesce(d.special_category or d.category = 'health', false)
  from data_release r
  join data_product p on p.id = r.product_id
  left join dataset d on d.id = p.dataset_id
 where el.release_id = r.id
   and el.direction = 'outgoing'
   and el.outcome = 'delivered'
   and cardinality(el.subjects) > 0;
