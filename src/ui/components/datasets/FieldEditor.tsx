/**
 * Editor für die Felder eines Datensatzes (Name, Bezeichnung, Typ, Einheit, Pflicht, Grenzen, Werte).
 * Arbeitet mit Entwürfen (Rohtext); draftToField() erzeugt die Felddefinition für den Vertrag.
 */
import { FIELD_TYPES, type FieldDef, type FieldType } from '../../../shared/contract/index.ts';
import { useI18n } from '../../i18n/index.tsx';
import { uid } from '../../lib/util.ts';
import { Checkbox, Fieldset, FormField } from '../FormField.tsx';
import { EmptyState } from '../QueryState.tsx';

export interface FieldDraft {
  uid: string;
  name: string;
  label: string;
  type: FieldType;
  unit: string;
  required: boolean;
  min: string;
  max: string;
  enumText: string;
  description: string;
}

export function newFieldDraft(): FieldDraft {
  return {
    uid: uid('f'),
    name: '',
    label: '',
    type: 'string',
    unit: '',
    required: false,
    min: '',
    max: '',
    enumText: '',
    description: '',
  };
}

export function fieldToDraft(f: FieldDef): FieldDraft {
  return {
    uid: uid('f'),
    name: f.name,
    label: f.label,
    type: f.type,
    unit: f.unit ?? '',
    required: f.required,
    min: f.min === undefined ? '' : String(f.min),
    max: f.max === undefined ? '' : String(f.max),
    enumText: (f.enumValues ?? []).join('\n'),
    description: f.description ?? '',
  };
}

export function isNumericType(type: FieldType): boolean {
  return type === 'integer' || type === 'number';
}

/** Leer → undefined; sonst Zahl (Komma als Dezimaltrenner erlaubt; ungültig → NaN, wird bei der Prüfung gemeldet). */
function parseNumber(raw: string): number | undefined {
  const s = raw.trim();
  if (s === '') return undefined;
  return Number(s.replace(',', '.'));
}

/** Entwurf → Felddefinition (Eingabeform des Vertrags). */
export function draftToField(d: FieldDraft): FieldDef {
  const numeric = isNumericType(d.type);
  const enumValues =
    d.type === 'enum'
      ? d.enumText
          .split('\n')
          .map((v) => v.trim())
          .filter((v) => v !== '')
      : undefined;
  return {
    name: d.name.trim(),
    label: d.label.trim(),
    type: d.type,
    unit: d.unit.trim() || undefined,
    required: d.required,
    min: numeric ? parseNumber(d.min) : undefined,
    max: numeric ? parseNumber(d.max) : undefined,
    enumValues,
    description: d.description.trim() || undefined,
  };
}

interface Props {
  value: readonly FieldDraft[];
  onChange: (next: FieldDraft[]) => void;
  /** Feldfehler zu einem Pfad relativ zum Body, z. B. "fields.0.name" */
  fieldError: (path: string) => string | undefined;
  disabled?: boolean;
}

export function FieldEditor({ value, onChange, fieldError, disabled }: Props) {
  const { t } = useI18n();

  const update = (id: string, patch: Partial<FieldDraft>) =>
    onChange(value.map((d) => (d.uid === id ? { ...d, ...patch } : d)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  };

  return (
    <div className="stack">
      {value.length === 0 ? (
        <EmptyState message={t('datasets.fields.empty')} />
      ) : (
        <ol className="list-plain stack">
          {value.map((d, n) => {
            const fe = (key: string) => fieldError(`fields.${n}.${key}`);
            const numeric = isNumericType(d.type);
            return (
              <li key={d.uid}>
                <Fieldset
                  legend={t('datasets.fields.fieldN', { n: n + 1 })}
                  error={fieldError(`fields.${n}`)}
                >
                  <div className="form-grid">
                    <FormField
                      label={t('datasets.fields.name')}
                      required
                      hint={t('datasets.fields.nameHint')}
                      error={fe('name')}
                    >
                      {(a) => (
                        <input
                          {...a}
                          className="input mono"
                          autoComplete="off"
                          spellCheck={false}
                          disabled={disabled}
                          value={d.name}
                          onChange={(e) => update(d.uid, { name: e.target.value })}
                        />
                      )}
                    </FormField>
                    <FormField label={t('datasets.fields.label')} required error={fe('label')}>
                      {(a) => (
                        <input
                          {...a}
                          className="input"
                          disabled={disabled}
                          value={d.label}
                          onChange={(e) => update(d.uid, { label: e.target.value })}
                        />
                      )}
                    </FormField>
                    <FormField label={t('datasets.fields.type')} required error={fe('type')}>
                      {(a) => (
                        <select
                          {...a}
                          className="input"
                          disabled={disabled}
                          value={d.type}
                          onChange={(e) => update(d.uid, { type: e.target.value as FieldType })}
                        >
                          {FIELD_TYPES.map((ft) => (
                            <option key={ft} value={ft}>
                              {t(`fieldTypes.${ft}`)}
                            </option>
                          ))}
                        </select>
                      )}
                    </FormField>
                    <FormField
                      label={t('datasets.fields.unit')}
                      hint={t('datasets.fields.unitHint')}
                      error={fe('unit')}
                    >
                      {(a) => (
                        <input
                          {...a}
                          className="input"
                          maxLength={32}
                          disabled={disabled}
                          value={d.unit}
                          onChange={(e) => update(d.uid, { unit: e.target.value })}
                        />
                      )}
                    </FormField>
                    {numeric && (
                      <>
                        <FormField
                          label={t('datasets.fields.min')}
                          hint={t('datasets.fields.rangeHint')}
                          error={fe('min')}
                        >
                          {(a) => (
                            <input
                              {...a}
                              className="input"
                              inputMode="decimal"
                              disabled={disabled}
                              value={d.min}
                              onChange={(e) => update(d.uid, { min: e.target.value })}
                            />
                          )}
                        </FormField>
                        <FormField label={t('datasets.fields.max')} error={fe('max')}>
                          {(a) => (
                            <input
                              {...a}
                              className="input"
                              inputMode="decimal"
                              disabled={disabled}
                              value={d.max}
                              onChange={(e) => update(d.uid, { max: e.target.value })}
                            />
                          )}
                        </FormField>
                      </>
                    )}
                    {d.type === 'enum' && (
                      <FormField
                        label={t('datasets.fields.enumValues')}
                        required
                        hint={t('datasets.fields.enumHint')}
                        error={fe('enumValues')}
                        className="span-2"
                      >
                        {(a) => (
                          <textarea
                            {...a}
                            className="input"
                            disabled={disabled}
                            value={d.enumText}
                            onChange={(e) => update(d.uid, { enumText: e.target.value })}
                          />
                        )}
                      </FormField>
                    )}
                    <FormField
                      label={t('datasets.fields.description')}
                      error={fe('description')}
                      className="span-2"
                    >
                      {(a) => (
                        <input
                          {...a}
                          className="input"
                          maxLength={1000}
                          disabled={disabled}
                          value={d.description}
                          onChange={(e) => update(d.uid, { description: e.target.value })}
                        />
                      )}
                    </FormField>
                    <Checkbox
                      className="span-2"
                      label={t('datasets.fields.required')}
                      hint={t('datasets.fields.requiredHint')}
                      checked={d.required}
                      disabled={disabled}
                      onChange={(checked) => update(d.uid, { required: checked })}
                    />
                  </div>
                  <div className="row">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={disabled || n === 0}
                      onClick={() => move(n, -1)}
                    >
                      {t('datasets.fields.moveUp')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={disabled || n === value.length - 1}
                      onClick={() => move(n, 1)}
                    >
                      {t('datasets.fields.moveDown')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger-outline"
                      disabled={disabled}
                      onClick={() => onChange(value.filter((x) => x.uid !== d.uid))}
                    >
                      {t('datasets.fields.remove')}
                    </button>
                  </div>
                </Fieldset>
              </li>
            );
          })}
        </ol>
      )}
      <div>
        <button
          type="button"
          className="btn"
          disabled={disabled}
          onClick={() => onChange([...value, newFieldDraft()])}
        >
          {t('datasets.fields.add')}
        </button>
      </div>
    </div>
  );
}
