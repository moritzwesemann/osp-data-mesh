-- BI-Views: Der View-Name ist das Produktkürzel. Nach Widerruf/Ablauf und neuer BI-Freigabe desselben
-- Produkts wird derselbe Name wiederverwendet; die Zeile der entfernten View bleibt als Historie erhalten.
-- Eindeutig ist der Name daher nur unter nicht entfernten Views.
alter table bi_view drop constraint bi_view_view_name_key;
create unique index bi_view_view_name_live on bi_view (view_name) where status <> 'dropped';
