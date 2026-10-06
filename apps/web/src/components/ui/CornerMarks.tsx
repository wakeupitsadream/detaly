import type { HTMLAttributes } from 'react';

/**
 * @deprecated «Техкарта» drawing corner marks. Now a plain wrapper without marks; the call
 * sites go away with their page packages (docs/design-v2.md, section 7), then this file is
 * deleted.
 */
export function CornerMarks({
  tone: _tone,
  ...rest
}: { tone?: 'ink' | 'light' | 'accent' } & HTMLAttributes<HTMLDivElement>) {
  return <div {...rest} />;
}
