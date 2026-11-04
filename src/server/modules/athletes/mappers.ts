/**
 * Abbildung Datenbankzeilen (snake_case) → API-Objekte (camelCase) des Athletenkerns.
 */
import type { Athlete, Consent } from '../../../shared/contract/athletes.ts';
import type { DataCategory, SquadStatus } from '../../../shared/contract/common.ts';
import { iso, isoReq } from '../../core/db.ts';
import type { Row } from '../../core/db-types.ts';

export function toAthlete(r: Row<'athlete'>): Athlete {
  return {
    id: r.id,
    lastName: r.last_name,
    firstName: r.first_name,
    dateOfBirth: r.date_of_birth,
    sport: r.sport,
    squadStatus: r.squad_status as SquadStatus,
    sex: (r.sex as Athlete['sex']) ?? null,
    club: r.club,
    discipline: r.discipline,
    createdAt: isoReq(r.created_at),
    updatedAt: isoReq(r.updated_at),
  };
}

export function toConsent(r: Row<'consent_record'>): Consent {
  return {
    id: r.id,
    athleteId: r.athlete_id,
    purpose: r.purpose,
    dataCategory: r.data_category as DataCategory | '*',
    status: r.status,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    evidenceNote: r.evidence_note,
    recordedAt: isoReq(r.recorded_at),
    withdrawnAt: iso(r.withdrawn_at),
  };
}

/** Escaping für LIKE/ILIKE-Muster (Standard-Escape-Zeichen "\") */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}
