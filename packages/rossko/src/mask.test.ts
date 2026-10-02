import { describe, expect, it } from 'vitest';
import { MASK, maskSecrets } from './mask';

const KEY1 = 'k1-0123456789abcdef';
const KEY2 = 'k2-fedcba9876543210';

describe('maskSecrets', () => {
  it('masks KEY1/KEY2 elements in SOAP XML with and without namespace prefixes', () => {
    const xml =
      '<soap:Body><ns1:GetSearch><ns1:KEY1>abc</ns1:KEY1><KEY2 xsi:type="x">def</KEY2>' +
      '<ns1:text>OC90</ns1:text></ns1:GetSearch></soap:Body>';
    expect(maskSecrets(xml)).toBe(
      `<soap:Body><ns1:GetSearch><ns1:KEY1>${MASK}</ns1:KEY1><KEY2 xsi:type="x">${MASK}</KEY2>` +
        '<ns1:text>OC90</ns1:text></ns1:GetSearch></soap:Body>',
    );
  });

  it('masks JSON fields and query parameters', () => {
    expect(maskSecrets('{"KEY1":"abc","KEY2": "d\\"ef","text":"OC90"}')).toBe(
      `{"KEY1":"${MASK}","KEY2": "${MASK}","text":"OC90"}`,
    );
    expect(maskSecrets('GET /x?KEY1=abc&KEY2=def&text=1')).toBe(
      `GET /x?KEY1=${MASK}&KEY2=${MASK}&text=1`,
    );
  });

  it('masks raw secret values anywhere, including XML-escaped forms', () => {
    const text = `error: key ${KEY1} rejected; echo ${KEY2}${KEY2}`;
    expect(maskSecrets(text, [KEY1, KEY2])).toBe(
      `error: key ${MASK} rejected; echo ${MASK}${MASK}`,
    );
    expect(maskSecrets('<a>x&amp;y-secret</a>', ['x&y-secret'])).toBe(`<a>${MASK}</a>`);
  });

  it('ignores empty and very short secrets so text is not mangled', () => {
    expect(maskSecrets('a b c', ['', 'a', null, undefined])).toBe('a b c');
  });

  it('leaves text without secrets untouched', () => {
    const text = '<SearchResult><success>true</success></SearchResult>';
    expect(maskSecrets(text, [KEY1])).toBe(text);
  });
});
