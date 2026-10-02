/**
 * Inline SVG icons, no library: 24x24 grid, 1.75 stroke, square caps, currentColor.
 * Decorative by default (aria-hidden); pass `title` to give an icon an accessible name.
 */
import type { ReactNode, SVGProps } from 'react';
import type { PartCategory } from './category';

export { CATEGORY_LABEL, categoryOf, type PartCategory } from './category';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  size?: number;
  title?: string;
};

function Svg({ size = 24, title, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="square"
      strokeLinejoin="miter"
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

function icon(paths: ReactNode, displayName: string) {
  const Icon = (props: IconProps) => <Svg {...props}>{paths}</Svg>;
  Icon.displayName = displayName;
  return Icon;
}

/* ---- Part categories ------------------------------------------------------------------- */

/** Oil filter: a can with ribs and a threaded cap. */
export const IconFilter = icon(
  <>
    <path d="M8.5 3h7v3h-7z" />
    <path d="M6 6h12v15H6z" />
    <path d="M9.5 9.5v8M12 9.5v8M14.5 9.5v8" />
  </>,
  'IconFilter',
);

/** Brake pads: friction block on a backing plate. */
export const IconPads = icon(
  <>
    <path d="M3 9.5C7 6 17 6 21 9.5V13C17 9.5 7 9.5 3 13z" />
    <path d="M4 17c4.5-3.5 11.5-3.5 16 0" />
    <path d="M6 20.5c3.5-2.5 8.5-2.5 12 0" />
  </>,
  'IconPads',
);

/** Brake disc: rotor, hat and five studs. */
export const IconDisc = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
    <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
  </>,
  'IconDisc',
);

/** Spark plug: terminal, insulator, hex, thread and electrode. */
export const IconPlug = icon(
  <>
    <path d="M11 2.5h2v2.5h-2z" />
    <path d="M10 5h4v5h-4z" />
    <path d="M7.5 10h9v3h-9z" />
    <path d="M10 13h4v5h-4zM10 15.5h4" />
    <path d="M12 18v3h2.5" />
  </>,
  'IconPlug',
);

/** Shock absorber: eyes, body, rod and a spring coil. */
export const IconShock = icon(
  <>
    <circle cx="12" cy="3.5" r="1.5" />
    <path d="M9 5.5h6v8H9z" />
    <path d="M12 13.5v5" />
    <circle cx="12" cy="20.5" r="1.5" />
    <path d="M6.5 8l11 1.5M6.5 11.5l11 1.5" />
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

/** Wiper: pivot, arm and blade over the glass edge. */
export const IconWiper = icon(
  <>
    <path d="M2.5 21h19" />
    <circle cx="17.5" cy="18" r="1.5" />
    <path d="M16.5 16.8L10 9" />
    <path d="M11.5 15.5L3.5 5" />
    <path d="M10.5 10.6l1.6-1.2" />
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

/** Hex nut: the default part and the brand mark. */
export const IconNut = icon(
  <>
    <path d="M12 2.5l8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5z" />
    <circle cx="12" cy="12" r="3.5" />
  </>,
  'IconNut',
);

const CATEGORY_ICONS: Record<PartCategory, (props: IconProps) => ReactNode> = {
  filter: IconFilter,
  pads: IconPads,
  disc: IconDisc,
  plug: IconPlug,
  shock: IconShock,
  belt: IconBelt,
  bearing: IconBearing,
  wiper: IconWiper,
  bulb: IconBulb,
  oil: IconOil,
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
    <path d="M15.5 15.5L21 21" />
  </>,
  'IconSearch',
);

export const IconCart = icon(
  <>
    <path d="M2.5 4h2.8l2.3 11h11l2-8H6.3" />
    <circle cx="9" cy="19.5" r="1.5" />
    <circle cx="17" cy="19.5" r="1.5" />
  </>,
  'IconCart',
);

export const IconArrowRight = icon(<path d="M4 12h15M13.5 6.5L19 12l-5.5 5.5" />, 'IconArrowRight');

export const IconChevron = icon(<path d="M9.5 6l6 6-6 6" />, 'IconChevron');

export const IconCheck = icon(<path d="M4.5 12.5l4.8 4.8L19.5 7" />, 'IconCheck');

export const IconClock = icon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.5 2" />
  </>,
  'IconClock',
);

/** Two-post car lift: the installation slot. */
export const IconLift = icon(
  <>
    <path d="M3.5 21V4M20.5 21V4" />
    <path d="M3.5 15h17" />
    <path d="M6.5 12l1.6-3.5h7.8l1.6 3.5z" />
    <path d="M2 21h4M18 21h4" />
  </>,
  'IconLift',
);

export const IconPin = icon(
  <>
    <path d="M12 21.5s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12z" />
    <circle cx="12" cy="9.5" r="2.5" />
  </>,
  'IconPin',
);

export const IconPhone = icon(
  <path d="M5 3.5h4l1.8 4.6-2.4 1.6a11.5 11.5 0 0 0 5.9 5.9l1.6-2.4 4.6 1.8v4c0 .6-.4 1-1 1A17 17 0 0 1 4 4.5c0-.6.4-1 1-1z" />,
  'IconPhone',
);

export const IconDocument = icon(
  <>
    <path d="M6 2.5h8.5l4 4v15H6z" />
    <path d="M14 2.5v4.5h4.5" />
    <path d="M9 12h6M9 15.5h6" />
  </>,
  'IconDocument',
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
    <path d="M18 14v6H4V6h6" />
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
