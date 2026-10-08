import { describe, expect, it } from 'vitest';
import { PRICE_GROUP_LABELS, PRICE_GROUPS, priceGroupOf, type PriceGroup } from '../src';

describe('priceGroupOf by the name', () => {
  it.each<[string, PriceGroup]>([
    // filters: before the engine words («масляный»)
    ['Фильтр масляный', 'filters'],
    ['Фильтр воздушный', 'filters'],
    ['Фильтр салонный угольный', 'filters'],
    ['ФИЛЬТР ТОПЛИВНЫЙ', 'filters'],
    ['Фильтр масляный (дубль в кроссах)', 'filters'],
    // brakes
    ['Колодки тормозные дисковые передние', 'brakes'],
    ['Колодки тормозные дисковые', 'brakes'],
    ['Диск тормозной вентилируемый', 'brakes'],
    ['Диск передний', 'brakes'],
    ['Барабан тормозной', 'brakes'],
    ['Суппорт передний левый', 'brakes'],
    ['Датчик ABS передний', 'brakes'],
    ['Трос ручного тормоза', 'brakes'],
    ['Шланг тормозной', 'brakes'],
    // suspension
    ['Амортизатор задний газовый', 'suspension'],
    ['Стойка стабилизатора передняя', 'suspension'],
    ['Рычаг подвески передний', 'suspension'],
    ['Опора шаровая', 'suspension'],
    ['Сайлентблок рычага', 'suspension'],
    ['Втулка стабилизатора', 'suspension'],
    ['Пружина подвески', 'suspension'],
    ['Наконечник рулевой тяги', 'suspension'],
    ['Подшипник опоры амортизатора', 'suspension'],
    // ignition
    ['Свеча зажигания', 'ignition'],
    ['Свеча накаливания', 'ignition'],
    ['Катушка зажигания', 'ignition'],
    ['Провода высоковольтные', 'ignition'],
    // timing and belts
    ['Ремень ГРМ', 'timing'],
    ['Комплект ремня ГРМ с помпой', 'timing'],
    ['Цепь ГРМ', 'timing'],
    ['Ролик натяжной', 'timing'],
    ['Ремень поликлиновый', 'timing'],
    ['Натяжитель ремня генератора', 'timing'],
    // bearings and hubs
    ['Подшипник ступицы', 'bearings'],
    ['Ступица передняя в сборе', 'bearings'],
    ['Подшипник ступичный', 'bearings'],
    // clutch: before the brakes («диск») and bearings («подшипник»)
    ['Комплект сцепления', 'clutch'],
    ['Диск сцепления', 'clutch'],
    ['Подшипник выжимной', 'clutch'],
    ['Цилиндр сцепления главный', 'clutch'],
    ['Маховик двухмассовый', 'clutch'],
    // cooling
    ['Радиатор охлаждения', 'cooling'],
    ['Помпа водяная', 'cooling'],
    ['Насос водяной', 'cooling'],
    ['Термостат', 'cooling'],
    ['Датчик температуры охлаждающей жидкости', 'cooling'],
    ['Бачок расширительный', 'cooling'],
    // wipers
    ['Щётка стеклоочистителя 600 мм', 'wipers'],
    ['Щетка стеклоочистителя задняя', 'wipers'],
    ['Мотор стеклоочистителя', 'wipers'],
    // lighting
    ['Лампа H7 12V 55W', 'lighting'],
    ['Фара передняя левая', 'lighting'],
    ['Фара противотуманная', 'lighting'],
    ['Фонарь задний', 'lighting'],
    ['Корректор фар', 'lighting'],
    // engine
    ['Прокладка ГБЦ', 'engine'],
    ['Прокладка клапанной крышки', 'engine'],
    ['Кольца поршневые', 'engine'],
    ['Колпачок маслосъёмный', 'engine'],
    ['Сальник коленвала', 'engine'],
    ['Опора двигателя', 'engine'],
    ['Насос топливный', 'engine'],
    ['Пружина клапана', 'engine'],
    // body
    ['Бампер передний', 'body'],
    ['Зеркало наружное левое', 'body'],
    ['Крыло переднее левое', 'body'],
    ['Подкрылок передний', 'body'],
    ['Решётка радиатора', 'body'],
    ['Стекло лобовое', 'body'],
    ['Амортизатор капота', 'body'],
    ['Амортизатор крышки багажника', 'body'],
    // other
    ['Масло моторное Castrol EDGE 5W-40 синтетическое 4 л', 'other'],
    ['Аккумулятор 60 Ач', 'other'],
    ['Щётка генератора', 'other'],
    ['Диск колёсный штампованный', 'other'],
    ['Датчик кислородный', 'other'],
    ['', 'other'],
    // look-alike words
    ['Фаркоп', 'body'],
    ['Крыльчатка вентилятора', 'cooling'],
  ])('%s -> %s', (name, group) => {
    expect(priceGroupOf({ name })).toBe(group);
  });

  it('treats ё as е and ignores case and punctuation', () => {
    expect(priceGroupOf({ name: 'ЩЁТКА-СТЕКЛООЧИСТИТЕЛЯ' })).toBe('wipers');
    expect(priceGroupOf({ name: 'решетка/радиатора' })).toBe('body');
  });

  it('matches whole words and stems, not any substring', () => {
    // «фара» is a headlight, «фаркоп» and «фартук» are not
    expect(priceGroupOf({ name: 'Фартук' })).toBe('other');
    // «масло» is no engine part, «масляный» is (a pump), «фильтр» wins over both
    expect(priceGroupOf({ name: 'Насос масляный' })).toBe('engine');
    expect(priceGroupOf({ name: 'Масло трансмиссионное' })).toBe('other');
    // «ремкомплект» is not a belt
    expect(priceGroupOf({ name: 'Ремкомплект суппорта' })).toBe('brakes');
  });
});

describe('priceGroupOf with the supplier product group', () => {
  it('takes the product group first', () => {
    expect(priceGroupOf({ productGroup: 'Тормозная система', name: 'Датчик износа' })).toBe(
      'brakes',
    );
    expect(priceGroupOf({ productGroup: 'Подвеска', name: 'Опора' })).toBe('suspension');
    expect(priceGroupOf({ productGroup: 'Освещение', name: 'H7 12V' })).toBe('lighting');
    expect(priceGroupOf({ productGroup: 'Кузовные детали', name: 'Кронштейн' })).toBe('body');
  });

  it('falls back to the name when the product group says nothing', () => {
    expect(priceGroupOf({ productGroup: 'Моторные масла', name: 'Фильтр масляный' })).toBe(
      'filters',
    );
    expect(priceGroupOf({ productGroup: null, name: 'Свеча зажигания' })).toBe('ignition');
    expect(priceGroupOf({ productGroup: '', name: 'Термостат' })).toBe('cooling');
    expect(priceGroupOf({})).toBe('other');
  });
});

describe('PRICE_GROUP_LABELS', () => {
  it('names every group', () => {
    expect(Object.keys(PRICE_GROUP_LABELS).sort()).toEqual([...PRICE_GROUPS].sort());
    for (const group of PRICE_GROUPS) expect(PRICE_GROUP_LABELS[group]).not.toBe('');
  });
});
