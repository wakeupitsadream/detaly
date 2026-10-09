/**
 * VIN validation (ISO 3779: 17 characters, no I, O and Q). The rule itself lives in
 * @detaly/domain since step 6 (the client's car is normalised by the pure vehicle helpers, docs/
 * garage.md); this module keeps the `@detaly/vin/vin` import path of the client components.
 */
export { isValidVin, maskVin, normalizeVin, vinTail } from '@detaly/domain/vin';
