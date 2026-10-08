/**
 * Inline SVG icons, no library (docs/design-v2.md, «Иконки»): 24x24 grid, 1.75 stroke, round
 * caps and joins, currentColor. Brand colour on light surfaces, white on the dark panel.
 * Decorative by default (aria-hidden); pass `title` to give an icon an accessible name.
 * Big icons (32 px and up: category tiles, the dark panel, feature rows, empty states) keep one
 * on-screen line of LARGE_LINE_PX whatever their size, so a 88 px tile glyph and a 40 px panel
 * glyph look drawn with the same pen; the stroke is scaled down from the 24 grid automatically.
 * Draw an icon at one size per element (two elements for a responsive size), not resized by CSS.
 */
import type { ReactNode, SVGProps } from 'react';
import type { PartCategory } from './category';

export { CATEGORY_LABEL, categoryOf, type PartCategory } from './category';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  size?: number;
  title?: string;
};

export type IconComponent = ((props: IconProps) => ReactNode) & { displayName?: string };

/** The on-screen line of every icon drawn at 32 px or more. */
export const LARGE_LINE_PX = 2.5;

/** Stroke width in 24-grid units that renders LARGE_LINE_PX at the given size. */
export function largeStroke(size: number): number {
  return Math.round(((LARGE_LINE_PX * 24) / size) * 100) / 100;
}

function Svg({ size = 24, title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={size >= 32 ? largeStroke(size) : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

function icon(paths: ReactNode, displayName: string): IconComponent {
  const Icon = (props: IconProps) => <Svg {...props}>{paths}</Svg>;
  Icon.displayName = displayName;
  return Icon;
}

/* ---- Part categories ------------------------------------------------------------------- */

/** Oil filter: a domed spin-on can with a ribbed grip band (not a bin: the cart has one). */
export const IconFilter = icon(
  <>
    <path d="M7.5 7.5c0-2.3 2-3.8 4.5-3.8s4.5 1.5 4.5 3.8" />
    <rect x="6.5" y="7.5" width="11" height="13.5" rx="2" />
    <path d="M6.5 11h11M6.5 17.5h11M9 17.5l1.4-6.5M11.8 17.5l1.4-6.5M14.6 17.5l1.4-6.5" />
  </>,
  'IconFilter',
);

/**
 * Brake pad at the edge of the disc: a solid crescent (outlined arcs alone read as a Wi-Fi
 * sign or a speaker) hugging the rotor with its hub.
 */
export const IconPads = icon(
  <>
    <circle cx="9" cy="12" r="6.5" />
    <circle cx="9" cy="12" r="2" />
    <path d="M15.2 5.7a8.5 8.5 0 0 1 0 12.6l2.2 2.2a11.6 11.6 0 0 0 0-17z" fill="currentColor" />
  </>,
  'IconPads',
);

/** Brake disc: rotor, hat and four bolt holes. */
export const IconDisc = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.5" />
    <circle cx="12" cy="6" r="0.8" />
    <circle cx="18" cy="12" r="0.8" />
    <circle cx="12" cy="18" r="0.8" />
    <circle cx="6" cy="12" r="0.8" />
  </>,
  'IconDisc',
);

/** Spark plug: terminal, insulator, a wide hex, thread and electrode. */
export const IconPlug = icon(
  <>
    <path d="M12 2v2.5" />
    <rect x="9.25" y="4.5" width="5.5" height="6" rx="1.25" />
    <path d="M6 10.5h12v3.5H6z" />
    <path d="M9 14v4.5h6V14M9 16.25h6" />
    <path d="M12 18.5V21h3" />
  </>,
  'IconPlug',
);

/** Suspension strut: the rod, the coil spring between two seats, the damper body. */
export const IconShock = icon(
  <>
    <path d="M12 2v3" />
    <path d="M5.5 5h13" />
    <path d="M18.5 5L5.5 8.5l13 3.5-13 3.5" />
    <path d="M5.5 15.5h13" />
    <rect x="9" y="15.5" width="6" height="4" rx="1" />
    <circle cx="12" cy="21" r="1.25" />
  </>,
  'IconShock',
);

/** Drive belt over two pulleys. */
export const IconBelt = icon(
  <>
    <circle cx="7" cy="15" r="4" />
    <circle cx="17" cy="8" r="3" />
    <circle cx="7" cy="15" r="1" />
    <circle cx="17" cy="8" r="0.8" />
    <path d="M4.7 11.7l10.6-6.2M9.3 18.3l9.4-7.9" />
  </>,
  'IconBelt',
);

/** Ball bearing: races and six balls. */
export const IconBearing = icon(
  <>
    <circle cx="12" cy="12" r="9.5" />
    <circle cx="12" cy="12" r="3.5" />
    <circle cx="18.5" cy="12" r="1.3" />
    <circle cx="15.25" cy="17.63" r="1.3" />
    <circle cx="8.75" cy="17.63" r="1.3" />
    <circle cx="5.5" cy="12" r="1.3" />
    <circle cx="8.75" cy="6.37" r="1.3" />
    <circle cx="15.25" cy="6.37" r="1.3" />
  </>,
  'IconBearing',
);

/** Wiper: the blade on its arm, the pivot on the lower edge of the curved glass. */
export const IconWiper = icon(
  <>
    <path d="M2 21.5q10-3.5 20 0" />
    <circle cx="15" cy="18.75" r="1.5" />
    <path d="M14.2 17.4L9 8" />
    <path d="M4.5 3.5l5.5 10" />
    <path d="M9.6 9.1l-1.5.85" />
  </>,
  'IconWiper',
);

/** Bulb. */
export const IconBulb = icon(
  <>
    <path d="M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2v.5h5V16c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z" />
    <path d="M9.5 19h5M10.5 21.5h3" />
  </>,
  'IconBulb',
);

/** Clutch disc: friction ring, damper springs and the splined hub. */
export const IconClutch = icon(
  <>
    <circle cx="12" cy="12" r="9.5" />
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="2.5" />
    <path d="M14.5 9.5l1.6-1.6M14.5 14.5l1.6 1.6M9.5 14.5l-1.6 1.6M9.5 9.5L7.9 7.9" />
  </>,
  'IconClutch',
);

/** Radiator: core with fins and the filler cap. */
export const IconCooling = icon(
  <>
    <rect x="3" y="6" width="18" height="13.5" rx="2" />
    <path d="M16 6V3.5h3V6" />
    <path d="M7.5 9.5v6.5M10.5 9.5v6.5M13.5 9.5v6.5M16.5 9.5v6.5" />
  </>,
  'IconCooling',
);

/** Engine block with the valve cover, intake and fan side. */
export const IconEngine = icon(
  <>
    <path d="M8 4.5h6M11 4.5V7" />
    <path d="M6 7h9.5l2 2.5H19V8h2v8h-2v-1.5h-1.5L15 18H8.5L6 15.5z" />
    <path d="M6 10H3.5v4H6" />
  </>,
  'IconEngine',
);

/** Car body from the side. */
export const IconBody = icon(
  <>
    <path d="M5.7 16.5H4a1 1 0 0 1-1-1V13l2.2-4.6a1 1 0 0 1 .9-.6h7.6a1 1 0 0 1 .75.34L18 12l2.3.6a1 1 0 0 1 .7.95v1.95a1 1 0 0 1-1 1h-1.7" />
    <path d="M9.3 16.5h5.4" />
    <circle cx="7.5" cy="16.5" r="1.8" />
    <circle cx="16.5" cy="16.5" r="1.8" />
    <path d="M4.4 12H18M11 7.8V12" />
  </>,
  'IconBody',
);

/** Oil canister with a handle and a spout. */
export const IconOil = icon(
  <>
    <path d="M4 9h12l3 3v9H4z" />
    <path d="M7 9V5h5v4" />
    <path d="M16 9l2.5-3H21" />
    <path d="M8 15h7" />
  </>,
  'IconOil',
);

/** Hex nut: the default part. */
export const IconNut = icon(
  <>
    <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z" />
    <circle cx="12" cy="12" r="3.5" />
  </>,
  'IconNut',
);

const CATEGORY_ICONS: Record<PartCategory, IconComponent> = {
  filter: IconFilter,
  pads: IconPads,
  disc: IconDisc,
  plug: IconPlug,
  shock: IconShock,
  belt: IconBelt,
  bearing: IconBearing,
  wiper: IconWiper,
  bulb: IconBulb,
  clutch: IconClutch,
  cooling: IconCooling,
  oil: IconOil,
  engine: IconEngine,
  body: IconBody,
  part: IconNut,
};

export function CategoryIcon({ category, ...props }: IconProps & { category: PartCategory }) {
  const Icon = CATEGORY_ICONS[category];
  return <Icon {...props} />;
}

/* ---- Interface ------------------------------------------------------------------------- */

export const IconSearch = icon(
  <>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L20.5 20.5" />
  </>,
  'IconSearch',
);

export const IconCart = icon(
  <>
    <path d="M2.5 4h2.3a1 1 0 0 1 1 .8L7.6 15h10.6a1 1 0 0 0 1-.76L20.8 7.5H6.2" />
    <circle cx="9" cy="19.5" r="1.5" />
    <circle cx="17" cy="19.5" r="1.5" />
  </>,
  'IconCart',
);

export const IconArrowRight = icon(<path d="M4 12h15M13.5 6.5L19 12l-5.5 5.5" />, 'IconArrowRight');

/** Points right; rotate for other directions or use IconChevronDown. */
export const IconChevron = icon(<path d="M9.5 6l6 6-6 6" />, 'IconChevron');

export const IconChevronDown = icon(<path d="M6 9.5l6 6 6-6" />, 'IconChevronDown');

export const IconCheck = icon(<path d="M4.5 12.5l4.8 4.8L19.5 7" />, 'IconCheck');

export const IconPlus = icon(<path d="M12 5v14M5 12h14" />, 'IconPlus');

export const IconMinus = icon(<path d="M5 12h14" />, 'IconMinus');

export const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </>,
  'IconClock',
);

/** Arrival date. */
export const IconCalendar = icon(
  <>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
    <path d="M8 14h.01M12 14h.01M16 14h.01M8 17.5h.01M12 17.5h.01" strokeWidth={2.4} />
  </>,
  'IconCalendar',
);

/** Spanner: installation, «машина готова». */
export const IconWrench = icon(
  <path d="M20 7.6a4.6 4.6 0 0 1-6.2 4.3l-7.1 7.2a1.9 1.9 0 0 1-2.7-2.7l7.2-7.1A4.6 4.6 0 0 1 16.4 3l-2.7 2.7.5 2.6 2.6.5z" />,
  'IconWrench',
);

/** Payment on pickup. */
export const IconWallet = icon(
  <>
    <path d="M4 7.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <path d="M4 7.5v-1a2 2 0 0 1 2-2h10.5" />
    <path d="M20 11.5h-3.5a1.5 1.5 0 0 0 0 3H20" />
  </>,
  'IconWallet',
);

/** Cash receipt with a torn edge. */
export const IconReceipt = icon(
  <>
    <path d="M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21z" />
    <path d="M9 8h6M9 11.5h6M9 15h3.5" />
  </>,
  'IconReceipt',
);

/** Counter-clockwise arrow: returns. */
export const IconReturn = icon(
  <>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" />
    <path d="M6 2v4h4" />
  </>,
  'IconReturn',
);

/** Parcel: «принесите деталь». */
export const IconBox = icon(
  <>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5l8 4.5 8-4.5M12 12v9M8 5.25l8 4.5" />
  </>,
  'IconBox',
);

export const IconPin = icon(
  <>
    <path d="M12 21.5s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </>,
  'IconPin',
);

export const IconPhone = icon(
  <path d="M5 3.5h3.6a1 1 0 0 1 .93.63l1.4 3.6a1 1 0 0 1-.38 1.2l-1.85 1.24a11.5 11.5 0 0 0 5.15 5.15l1.24-1.85a1 1 0 0 1 1.2-.38l3.6 1.4a1 1 0 0 1 .63.93V19a1.5 1.5 0 0 1-1.5 1.5A16.5 16.5 0 0 1 3.5 5 1.5 1.5 0 0 1 5 3.5z" />,
  'IconPhone',
);

export const IconHome = icon(
  <>
    <path d="M3.5 11L12 4l8.5 7" />
    <path d="M6 9.5V20h12V9.5" />
    <path d="M10 20v-5h4v5" />
  </>,
  'IconHome',
);

export const IconLock = icon(
  <>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8 10.5v-3a4 4 0 0 1 8 0v3M12 14.5v2.5" />
  </>,
  'IconLock',
);

export const IconUser = icon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
  </>,
  'IconUser',
);

export const IconTrash = icon(
  <>
    <path d="M4.5 7h15M9.5 7V4.5h5V7" />
    <path d="M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
  </>,
  'IconTrash',
);

/** A page with a folded corner: legal documents. */
export const IconDocument = icon(
  <>
    <path d="M6 2.5h8.5l4 4v15H6z" />
    <path d="M14 2.5v4.5h4.5" />
    <path d="M9 12h6M9 15.5h6" />
  </>,
  'IconDocument',
);

/** Vehicle registration card (СТС): where the VIN is printed. */
export const IconSts = icon(
  <>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M6 9h6M6 12.5h12M6 16h8" />
    <rect x="15" y="8" width="3" height="2" rx="0.5" />
  </>,
  'IconSts',
);

/** Shield with a tick: returns and guarantees. */
export const IconShield = icon(
  <>
    <path d="M12 2.5l8 3v6.2c0 4.6-3.3 8.3-8 9.8-4.7-1.5-8-5.2-8-9.8V5.5z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </>,
  'IconShield',
);

export const IconClose = icon(<path d="M6 6l12 12M18 6L6 18" />, 'IconClose');

export const IconExternal = icon(
  <>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </>,
  'IconExternal',
);

/** Exclamation in a circle: field errors and warnings. */
export const IconAlert = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v6.5M12 16.5v.5" />
  </>,
  'IconAlert',
);

/** "i" in a circle: information notes. */
export const IconInfo = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 10.5V17M12 7v.5" />
  </>,
  'IconInfo',
);

/** Bank card: how the order is paid. */
export const IconCard = icon(
  <>
    <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
    <path d="M2.5 9.5h19M6 15h4" />
  </>,
  'IconCard',
);

/** Speech bubble: messenger notifications. */
export const IconMessage = icon(
  <path d="M5 4.5h14A1.5 1.5 0 0 1 20.5 6v8.5A1.5 1.5 0 0 1 19 16h-9l-4.5 3.5V16H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5z" />,
  'IconMessage',
);

/** Speech bubble with dots: «спросить мастера», chat with the point. */
export const IconChat = icon(
  <>
    <path d="M5 4.5h14A1.5 1.5 0 0 1 20.5 6v8.5A1.5 1.5 0 0 1 19 16h-9l-4.5 3.5V16H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5z" />
    <path d="M8.5 10.25h.01M12 10.25h.01M15.5 10.25h.01" strokeWidth={2.6} />
  </>,
  'IconChat',
);

/** Paper plane: Telegram. */
export const IconTelegram = icon(
  <path d="M21 4L3 11.2l6.3 2.3L19 7l-7.6 8v5l3.4-3.5 4 3z" />,
  'IconTelegram',
);

/** Round bubble with an M: the MAX messenger. */
export const IconMax = icon(
  <>
    <path d="M12 3.5a8.5 8.5 0 1 1-4.2 15.9L3.5 20.5l1.1-4.2A8.5 8.5 0 0 1 12 3.5z" />
    <path d="M8.5 15V9.5l3.5 4 3.5-4V15" />
  </>,
  'IconMax',
);

/**
 * A five-point star: the shop's rating and the review buttons (step 3). Outlined; pass
 * fill="currentColor" for the solid star of the rating line. Never a map service's logo.
 */
export const IconStar = icon(
  <path d="M12 3.6l2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.62l-5.1 2.68.97-5.68-4.12-4.02 5.7-.83z" />,
  'IconStar',
);

/** Route arrow on a map: directions to the pickup point. */
export const IconRoute = icon(
  <>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <path d="M8.5 18H16a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h7.5" />
  </>,
  'IconRoute',
);
