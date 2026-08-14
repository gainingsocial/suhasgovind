import type { ListResponse } from './api';
import { sessionFetchOr, type DashboardContext } from './session-api';

/**
 * Brand selection for the creator surface (creator plan §5.1, rule C2).
 *
 * The API calls these profiles, and that name is correct there — a profile is the identity
 * a set of connected accounts hangs off. In the studio it is a **brand**, because that is
 * what the person managing it calls it, and rule C2 forbids naming a screen after a table.
 *
 * Memory, recommendations and analytics are all per profile: a brand's voice and a brand's
 * performance belong to one identity, and pooling them across a customer's clients would
 * produce advice about nobody in particular. So every screen that reads them has to choose
 * one, and they all choose it the same way.
 */

export interface Brand {
  id: string;
  object: 'profile';
  name: string;
  timezone: string;
  disabled_at: string | null;
}

export interface BrandSelection {
  /** Every brand the person can see, for the switcher. Empty when none exist yet. */
  brands: Brand[];
  /** The one this page acts on, or null when there are none. */
  selected: Brand | null;
}

const EMPTY: ListResponse<Brand> = {
  object: 'list',
  data: [],
  has_more: false,
  next_cursor: null,
};

/**
 * Resolve which brand a screen is showing.
 *
 * The requested id is matched against the list the API returned rather than being
 * forwarded, for the same reason the environment cookie is: a value straight from the query
 * string would be a tenant selector under the reader's control. An unrecognized one falls
 * back to the first brand instead of erroring — a stale bookmark should show something
 * useful, not a failure.
 */
export async function resolveBrand(
  context: DashboardContext,
  requested?: string,
): Promise<BrandSelection> {
  const response = await sessionFetchOr<ListResponse<Brand>>(context, '/v1/profiles?limit=100', EMPTY);

  // A disabled brand still owns its history, so it stays selectable when explicitly asked
  // for — but it never becomes the default, because landing on one by accident looks like
  // the product forgot the brand you actually use.
  const active = response.data.filter((brand) => !brand.disabled_at);

  const selected =
    (requested ? response.data.find((brand) => brand.id === requested) : undefined) ??
    active[0] ??
    response.data[0] ??
    null;

  return { brands: response.data, selected };
}
