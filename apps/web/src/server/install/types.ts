/**
 * The "when will the car be ready" plan as pages show it (docs/design.md, section 4). Computed
 * on the server by planInstallForOffers / planInstallForDate (./index.ts); texts are final, the
 * components only lay them out.
 */
export interface InstallPlanView {
  /** When the part is at the pickup point: 'к чт 8 октября'. */
  partText: string;
  /** The nearest free lift slot: 'чт 8 окт с 14:00' | 'сегодня с 16:00' | 'завтра с 10:00'. */
  slotText: string;
  /** End of a typical job in that slot: 'к 16:00'. */
  carReadyText: string;
  /** The lift load is simulated (demo source): the UI says so next to the plan. */
  demo: boolean;
  /** Slot start, ISO 8601 with offset, for <time dateTime>. */
  slotStartIso: string;
}
