// Step 3 (docs/reviews.md): which review platforms exist follows REVIEW_URL_* alone.
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env';
import { reviewPlatforms, reviewUrls } from '../src/reviews';
import { minimalEnvSource } from '../src/testing';

const YANDEX = 'https://yandex.ru/maps/org/test/1/reviews/';
const TWO_GIS = 'https://2gis.ru/orenburg/firm/1';

describe('reviewUrls / reviewPlatforms', () => {
  it('neither link: the feature is off', () => {
    const env = parseEnv(minimalEnvSource());
    expect(reviewUrls(env)).toEqual({ yandex: null, '2gis': null });
    expect(reviewPlatforms(env)).toEqual([]);
  });

  it('each link turns on its platform, in a fixed order', () => {
    expect(reviewPlatforms(parseEnv(minimalEnvSource({ REVIEW_URL_2GIS: TWO_GIS })))).toEqual([
      '2gis',
    ]);
    expect(reviewPlatforms(parseEnv(minimalEnvSource({ REVIEW_URL_YANDEX: YANDEX })))).toEqual([
      'yandex',
    ]);
    const both = parseEnv(
      minimalEnvSource({ REVIEW_URL_2GIS: TWO_GIS, REVIEW_URL_YANDEX: YANDEX }),
    );
    expect(reviewPlatforms(both)).toEqual(['yandex', '2gis']);
    expect(reviewUrls(both)).toEqual({ yandex: YANDEX, '2gis': TWO_GIS });
  });
});
