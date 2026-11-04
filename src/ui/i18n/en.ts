/**
 * Englische Fassung. Der Typ Messages erzwingt exakt dieselben Schlüssel wie de.ts.
 */
import type { Messages } from './de.ts';
import { athletes } from './en/athletes.ts';
import { audit } from './en/audit.ts';
import { account, auth, overview } from './en/auth.ts';
import { catalog } from './en/catalog.ts';
import { connectors } from './en/connectors.ts';
import {
  clientErrors,
  common,
  conditions,
  denyReasons,
  errors,
  federationErrors,
  fieldErrors,
  importErrors,
  nav,
  reasons,
  releaseIssues,
  shell,
} from './en/core.ts';
import { datasets } from './en/datasets.ts';
import { enums } from './en/enums.ts';
import { myData } from './en/myData.ts';
import { partners } from './en/partners.ts';
import { products } from './en/products.ts';
import { received } from './en/received.ts';
import { releases } from './en/releases.ts';
import { system } from './en/system.ts';
import { users } from './en/users.ts';

export const en: Messages = {
  common,
  nav,
  shell,
  errors,
  clientErrors,
  reasons,
  denyReasons,
  releaseIssues,
  importErrors,
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
