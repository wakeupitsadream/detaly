import { cn } from '@/components/ui/cn';

/** A two-post lift as drawn on a floor plan. */
function LiftGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g
      transform={`translate(${x} ${y})`}
      stroke="var(--color-steel-200)"
      strokeWidth="1.5"
      fill="none"
    >
      <rect x="0" y="0" width="34" height="56" strokeDasharray="3 3" strokeOpacity=".55" />
      <rect x="-4" y="12" width="6" height="6" fill="var(--color-steel-200)" stroke="none" />
      <rect x="32" y="12" width="6" height="6" fill="var(--color-steel-200)" stroke="none" />
      <rect x="-4" y="38" width="6" height="6" fill="var(--color-steel-200)" stroke="none" />
      <rect x="32" y="38" width="6" height="6" fill="var(--color-steel-200)" stroke="none" />
    </g>
  );
}

/**
 * Instead of a map (external maps are closed by the CSP): a drawing of the pickup point as a
 * floor plan on the blueprint grid — two streets, the service with its lifts and the gate,
 * the pin. Not to scale and says so; the address is in text next to it.
 */
export function PickupSchematic({ className }: { className?: string }) {
  return (
    <figure className={cn('min-w-0', className)}>
      <div className="relative overflow-hidden rounded border border-graphite-700 bg-graphite-950/50">
        <svg
          viewBox="0 0 480 340"
          className="block h-auto w-full"
          role="img"
          aria-label="Схема: пункт выдачи в здании автосервиса, въезд с улицы"
        >
          <defs>
            <pattern
              id="pickup-hatch"
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <path d="M0 0V8" stroke="#fff" strokeOpacity=".07" strokeWidth="2" />
            </pattern>
          </defs>

          {/* City blocks around. */}
          <g fill="url(#pickup-hatch)" stroke="var(--color-graphite-700)" strokeWidth="1">
            <rect x="24" y="24" width="104" height="176" />
            <rect x="24" y="262" width="104" height="54" />
            <rect x="204" y="262" width="252" height="54" />
            <rect x="420" y="24" width="36" height="176" />
          </g>

          {/* Streets: kerbs and a dashed axis. */}
          <g stroke="var(--color-steel-400)" strokeOpacity=".7" strokeWidth="1.25" fill="none">
            <path d="M0 214H140M192 214H480M0 248H140M192 248H480" />
            <path d="M140 0V214M192 0V214M140 248V340M192 248V340" />
          </g>
          <g
            stroke="var(--color-steel-400)"
            strokeOpacity=".45"
            strokeWidth="1"
            strokeDasharray="10 8"
          >
            <path d="M0 231H480M166 0V340" />
          </g>

          {/* The service building with two lifts and the gate to the street. */}
          <g>
            <rect x="214" y="44" width="186" height="146" fill="var(--color-graphite-800)" />
            <path
              d="M282 190H214V44H400V190H332"
              fill="none"
              stroke="var(--color-paper)"
              strokeWidth="2"
            />
            <path
              d="M282 190L292 178M332 190L322 178"
              stroke="var(--color-paper)"
              strokeWidth="1.25"
            />
            <LiftGlyph x={244} y={84} />
            <LiftGlyph x={300} y={84} />
            <text
              x="358"
              y="70"
              className="font-mono"
              fontSize="10"
              letterSpacing="1.2"
              fill="var(--color-steel-400)"
              textAnchor="middle"
            >
              СЕРВИС
            </text>
            <text
              x="276"
              y="160"
              className="font-mono"
              fontSize="9"
              letterSpacing="1.2"
              fill="var(--color-steel-400)"
              textAnchor="middle"
            >
              ПОДЪЁМНИКИ
            </text>
            <text
              x="318"
              y="236"
              className="font-mono"
              fontSize="10"
              letterSpacing="1.2"
              fill="var(--color-steel-400)"
            >
              ВЪЕЗД
            </text>
            <path
              d="M307 240V198M302 203L307 197L312 203"
              stroke="var(--color-accent)"
              strokeWidth="1.75"
              fill="none"
            />
          </g>

          {/* Dimension line under the building, like on a drawing. */}
          <g stroke="var(--color-steel-400)" strokeOpacity=".6" strokeWidth="1">
            <path d="M214 30H400M214 26V34M400 26V34" />
          </g>

          {/* The pin and its plate. */}
          <g>
            <path
              d="M366 150c0-11 8-19 18-19s18 8 18 19c0 13-18 30-18 30s-18-17-18-30z"
              fill="var(--color-accent)"
              transform="translate(-6 -40)"
            />
            <circle cx="378" cy="109" r="6" fill="var(--color-graphite-950)" />
          </g>
        </svg>
      </div>
      <figcaption className="mt-2 flex justify-between gap-4 font-mono text-[0.6875rem] tracking-wider text-steel-400 uppercase">
        <span>Схема без масштаба</span>
        <span>Лист 1 / 1</span>
      </figcaption>
    </figure>
  );
}
