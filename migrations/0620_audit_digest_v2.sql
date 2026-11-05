-- Eindeutige Eingabe des Hashes der Audit-Kette (ADR 0006/0014, Nachtrag 2). Keine personenbezogenen Daten.
--
-- Bisher (Version 1, Migration 0001) verband audit_digest_input() die Felder mit '|' (concat_ws). Enthält ein
-- Feld selbst '|', lässt sich der Text anders auf benachbarte Felder verteilen, ohne dass sich der Hash ändert
-- (actor_id 'u-123', actor_label 'Eve|Admin' → actor_id 'u-123|Eve', actor_label 'Admin'); zudem waren null
-- und '' nicht unterscheidbar.
--
-- Version 2 (alle ab jetzt geschriebenen Einträge): Kennung 'osp-audit-digest@2', danach je Feld '|' und
--   null  → '~'
--   Wert  → <Anzahl der UTF-8-Bytes>:<Wert>
-- Die Längenangabe macht die Zerlegung eindeutig (präfixfrei); die Kennung bindet die Version in die Eingabe
-- (eine Eingabe der Version 1 beginnt mit der Laufnummer, also einer Ziffer, und kann keiner der Version 2
-- gleichen). Bestehende Einträge behalten Version 1 und ihren Hash; die Kette läuft unverändert weiter.
-- Nach dem ersten Eintrag der Version 2 darf keine kleinere Version mehr folgen (audit_verify, chain.ts).
--
-- Die Prüfung im Programm (src/server/modules/audit/chain.ts) berechnet beide Versionen Byte für Byte gleich.

alter table audit_log
  add column digest_version smallint not null default 1 check (digest_version in (1, 2));

-- Feld der Version 2: null → '~', sonst Byte-Länge (UTF-8), ':' und Wert
create or replace function audit_digest_field(v text) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$
  select case when v is null then '~'
              else octet_length(convert_to(v, 'UTF8'))::text || ':' || v end
$$;

create or replace function audit_digest_input(r audit_log) returns text language sql stable as $$
  select case when r.digest_version = 2 then
    'osp-audit-digest@2'
      || '|' || audit_digest_field(r.seq::text)
      || '|' || audit_digest_field(to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      || '|' || audit_digest_field(r.actor_type)
      || '|' || audit_digest_field(r.actor_id)
      || '|' || audit_digest_field(r.actor_label)
      || '|' || audit_digest_field(r.action)
      || '|' || audit_digest_field(r.object_type)
      || '|' || audit_digest_field(r.object_id)
      || '|' || audit_digest_field(r.outcome)
      || '|' || audit_digest_field(r.details::text)
      || '|' || audit_digest_field(r.ip)
      || '|' || audit_digest_field(r.request_id)
      || '|' || audit_digest_field(r.prev_hash)
  else
    -- Version 1 (Migration 0001), unverändert für bestehende Einträge
    concat_ws('|',
      r.seq::text,
      to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      r.actor_type, coalesce(r.actor_id, ''), coalesce(r.actor_label, ''),
      r.action, coalesce(r.object_type, ''), coalesce(r.object_id, ''),
      r.outcome, r.details::text, coalesce(r.ip, ''), coalesce(r.request_id, ''),
      r.prev_hash)
  end
$$;

-- Neue Einträge immer in Version 2 (der Wert des Aufrufers zählt nicht)
create or replace function audit_log_chain() returns trigger language plpgsql as $$
declare
  last_seq  bigint;
  last_hash text;
begin
  -- Serialisiert alle Audit-Einträge, damit die Kette nicht verzweigt.
  perform pg_advisory_xact_lock(7212001);
  select seq, hash into last_seq, last_hash from audit_log order by seq desc limit 1;
  new.seq := coalesce(last_seq, 0) + 1;
  new.prev_hash := coalesce(last_hash, repeat('0', 64));
  new.at := clock_timestamp();
  new.digest_version := 2;
  new.hash := encode(sha256(convert_to(audit_digest_input(new), 'UTF8')), 'hex');
  return new;
end $$;

-- Prüfung in der Datenbank wie bisher, zusätzlich: Version fällt nie zurück
create or replace function audit_verify(out checked bigint, out first_broken_seq bigint) language plpgsql stable as $$
declare
  r audit_log;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
  last_version smallint := 1;
begin
  checked := 0;
  first_broken_seq := null;
  for r in select * from audit_log order by seq loop
    if r.seq <> expected_seq
       or r.prev_hash <> expected_prev
       or r.digest_version < last_version
       or r.hash <> encode(sha256(convert_to(audit_digest_input(r), 'UTF8')), 'hex') then
      first_broken_seq := r.seq;
      return;
    end if;
    expected_prev := r.hash;
    expected_seq := expected_seq + 1;
    last_version := r.digest_version;
    checked := checked + 1;
  end loop;
end $$;
