// «Машина готова …» follows the chosen install slot on the order page (audit ux-7): one line per
// chip — the slot's start plus a typical job (INSTALL_JOB_MIN of @detaly/domain/install-params) —
// shown by CSS for the checked chip only, so it needs no script; a booking shows its own slot.
import { readFileSync } from 'node:fs';
import type { InstallSlot } from '@detaly/domain';
import { INSTALL_JOB_MIN, INSTALL_SLOTS_SHOWN } from '@detaly/domain/install-params';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InstallBookingBlock } from '@/components/install/InstallBookingBlock';
import { slotInstallPlan } from '@/components/install/InstallLine';
import type { InstallBlockView } from '@/server/orders/order-services';

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const slot = (startAt: string, dayText: string, timeText: string): InstallSlot => ({
  startAt,
  // The planner's own end (start + its job); the line does not depend on it.
  endAt: startAt,
  dayText,
  timeText,
});

const SLOTS = [
  slot('2026-10-09T13:00:00+05:00', 'пт 9 окт', '13:00'),
  slot('2026-10-09T15:00:00+05:00', 'пт 9 окт', '15:00'),
  slot('2026-10-10T09:00:00+05:00', 'сб 10 окт', '09:00'),
];

const install = (overrides: Partial<InstallBlockView> = {}): InstallBlockView => ({
  partner: { name: 'Тестовый сервис', requisites: null },
  booking: null,
  slots: SLOTS,
  emptyReason: null,
  requestKey: 'key-1',
  demo: false,
  ...overrides,
});

function render(view: InstallBlockView, lead?: string): string {
  return renderToStaticMarkup(
    createElement(InstallBookingBlock, {
      token: 'tok',
      install: view,
      lead: lead ? createElement('p', { 'data-testid': 'lead' }, lead) : undefined,
    }),
  );
}

describe('the ready time of a slot', () => {
  it('is the start plus a typical job, in the slot zone, dated like the slot', () => {
    expect(INSTALL_JOB_MIN).toBe(120);
    expect(slotInstallPlan(SLOTS[0]!)).toEqual({
      slotStartIso: '2026-10-09T13:00:00+05:00',
      carReadyText: 'к 15:00',
      slotText: 'пт 9 окт с 13:00',
    });
    expect(slotInstallPlan(SLOTS[2]!).carReadyText).toBe('к 11:00');
    // Half-hour starts and another zone offset are read off the instant, not the text.
    expect(slotInstallPlan(slot('2026-10-09T08:30:00Z', 'пт 9 окт', '13:30')).carReadyText).toBe(
      'к 15:30',
    );
  });
});

describe('booking card: «Машина готова …» per chip (ux-7)', () => {
  it('one line per slot, each radio described by its own line', () => {
    const html = render(install(), 'ближайший слот');
    // The nearest-slot lead is replaced by the lines of the chips.
    expect(html).not.toContain('data-testid="lead"');
    expect(html.match(/data-testid="order-car-ready"/g)).toHaveLength(1);
    expect(html).toContain('class="install-pick');
    SLOTS.forEach((item, index) => {
      const line = new RegExp(
        `<div id="install-ready-${index}" data-ready-slot="${index}">(.*?)</div>`,
      ).exec(html)?.[1];
      expect(line, item.startAt).toBeTruthy();
      expect(text(line ?? '')).toBe(
        `С установкой — Машина готова ${index < 2 ? 'пт 9 октября' : 'сб 10 октября'} ${slotInstallPlan(item).carReadyText}`,
      );
      const radio = new RegExp(
        `<input[^>]*value="${item.startAt.replace(/\+/g, '\\+')}"[^>]*>`,
      ).exec(html)?.[0];
      expect(radio, item.startAt).toContain(`data-slot-index="${index}"`);
      expect(radio, item.startAt).toContain(`aria-describedby="install-ready-${index}"`);
      expect(radio, item.startAt).toContain('data-testid="install-slot"');
    });
    expect(text(html)).toContain('Машина готова пт 9 октября к 15:00');
    expect(text(html)).toContain('Машина готова пт 9 октября к 17:00');
    expect(text(html)).toContain('Машина готова сб 10 октября к 11:00');
  });

  it('a booking shows the booked slot, not the nearest free one', () => {
    const html = render(
      install({
        slots: [],
        booking: {
          id: 'b1',
          status: 'requested',
          slot: SLOTS[1]!,
          canCancel: true,
          cancelUntilText: '9 октября, 13:00',
        },
      }),
      'ближайший слот',
    );
    expect(html).not.toContain('data-testid="lead"');
    expect(text(html)).toContain('Машина готова пт 9 октября к 17:00');
    expect(text(html)).toContain('Вы записаны на пт 9 окт · 15:00');
  });

  it('without a slot or a booking the lead stays (the nearest slot or the fallback)', () => {
    const html = render(install({ slots: [], emptyReason: 'full' }), 'ближайший слот');
    expect(html).toContain('data-testid="lead"');
    expect(html).not.toContain('data-ready-slot');
  });

  it('globals.css shows the checked chip line for every chip the page can offer', () => {
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');
    expect(css).toContain(".install-pick [data-ready-slot]:not([data-ready-slot='0'])");
    for (let index = 0; index < INSTALL_SLOTS_SHOWN; index += 1) {
      expect(css, `chip ${index}`).toContain(
        `.install-pick:has([data-slot-index='${index}']:checked) [data-ready-slot='${index}']`,
      );
    }
  });
});
