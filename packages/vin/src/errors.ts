/** Errors of the VIN request workflow. Messages never contain the client's data. */

/** Which input of createVinRequest was rejected (the form maps it to a field message). */
export type VinRequestInputField =
  | 'id'
  | 'vin'
  | 'car_text'
  | 'need_text'
  | 'phone'
  | 'channel'
  | 'photos'
  | 'consent'
  | 'request_key';

/** Invalid input of createVinRequest; `field` says which one (the value is never echoed). */
export class VinRequestInputError extends Error {
  readonly field: VinRequestInputField;

  constructor(field: VinRequestInputField) {
    super(`invalid VIN request input: ${field}`);
    this.name = 'VinRequestInputError';
    this.field = field;
  }
}
