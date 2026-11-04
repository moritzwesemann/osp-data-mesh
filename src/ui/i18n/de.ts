/**
 * Deutsches Wörterbuch – maßgebliche Quelle aller Texte und Schlüssel.
 * Die englische Fassung (en.ts) muss exakt dieselben Schlüssel haben (Typ Messages).
 * Die Abschnitte liegen thematisch getrennt in ./de/*.ts.
 */
import { athletes } from './de/athletes.ts';
import { audit } from './de/audit.ts';
import { account, auth, overview } from './de/auth.ts';
import { catalog } from './de/catalog.ts';
import { connectors } from './de/connectors.ts';
import {
  clientErrors,
  common,
  conditions,
  denyReasons,
  errors,
  federationErrors,
  fieldErrors,
  importErrors,
  importParams,
  nav,
  reasons,
  releaseIssues,
  shell,
} from './de/core.ts';
import { datasets } from './de/datasets.ts';
import { enums } from './de/enums.ts';
import { myData } from './de/myData.ts';
import { partners } from './de/partners.ts';
import { products } from './de/products.ts';
import { received } from './de/received.ts';
import { releases } from './de/releases.ts';
import { system } from './de/system.ts';
import { users } from './de/users.ts';

export const de = {
  common,
  nav,
  shell,
  errors,
  clientErrors,
  reasons,
  denyReasons,
  releaseIssues,
  importErrors,
  importParams,
  federationErrors,
  fieldErrors,
  conditions,
  ...enums,
  auth,
  overview,
  account,
  athletes,
  datasets,
  connectors,
  products,
  releases,
  myData,
  partners,
  catalog,
  received,
  audit,
  users,
  system,
};

export type Messages = typeof de;
