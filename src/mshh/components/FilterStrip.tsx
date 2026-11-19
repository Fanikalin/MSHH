import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Chip, Icon, IconButton, Icons, Text } from 'folds';
import * as css from './FilterStrip.css';

export type FilterStripItem = {
  id: string;
  name: string;
  active: boolean;
  onToggle: () => void;
  /** Optional leading marker, e.g. a profile status dot. */
  before?: React.ReactNode;
};

/** Length of the common prefix of two names. */
const commonPrefixLength = (a: string, b: string): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

/**
 * Monogram for a filter chip: the shortest prefix unique among all names;
 * identical names fall back to `letter + occurrence number` ("T1", "T2").
 */
export function computeMonograms(items: { id: string; name: string }[]): Map<string, string> {
  const names = items.map((item) => item.name.trim());
  const lower = names.map((name) => name.toLowerCase());
  const total = new Map<string, number>();
  lower.forEach((name) => total.set(name, (total.get(name) ?? 0) + 1));

  const result = new Map<string, string>();
  const occurrence = new Map<string, number>();
  items.forEach((item, i) => {
    const name = names[i];
    const l = lower[i];
    if (!name) {
      result.set(item.id, '?');
      return;
    }
    if ((total.get(l) ?? 0) > 1) {
      const n = (occurrence.get(l) ?? 0) + 1;
      occurrence.set(l, n);
      result.set(item.id, `${name.charAt(0).toUpperCase()}${n}`);
      return;
    }
    // unique prefix: one letter past the longest shared prefix with any other name
    let len = 1;
    lower.forEach((other, j) => {
      if (j === i) return;
      len = Math.min(name.length, Math.max(len, commonPrefixLength(l, other) + 1));
    });
    result.set(item.id, name.slice(0, len).toUpperCase());
  });
  return result;
}

type FilterStripProps = {
  items: FilterStripItem[];
};

/** Horizontal strip of monogram filter chips; overflows scroll with the mouse wheel. */
export function FilterStrip({ items }: FilterStripProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setEdges({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useLayoutEffect(updateEdges, [updateEdges, items]);

  // The strip is the only horizontal scroller: vertical wheel scrolls it sideways.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onWheel = (evt: WheelEvent) => {
      const delta = Math.abs(evt.deltaY) >= Math.abs(evt.deltaX) ? evt.deltaY : evt.deltaX;
      if (delta === 0) return;
      evt.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const scrollByAmount = useCallback((amount: number) => {
    scrollRef.current?.scrollBy({ left: amount, behavior: 'smooth' });
  }, []);

  const monograms = useMemo(() => computeMonograms(items), [items]);

  if (items.length === 0) return null;

  return (
    <Box className={css.Strip} shrink="No">
      <div ref={scrollRef} className={css.Scroll} onScroll={updateEdges}>
        <Box alignItems="Center" gap="100" style={{ width: 'max-content', padding: '0 2px' }}>
          {items.map((item) => (
            <Chip
              key={item.id}
              size="400"
              variant={item.active ? 'Primary' : 'Background'}
              fill="Soft"
              radii="Pill"
              outlined={!item.active}
              before={item.before}
              onClick={item.onToggle}
              aria-pressed={item.active}
              title={item.name}
            >
              <Text as="span" size="L400">
                {monograms.get(item.id) ?? item.name.charAt(0).toUpperCase()}
              </Text>
            </Chip>
          ))}
        </Box>
      </div>
      {edges.left && (
        <IconButton
          className={css.Arrow}
          variant="Background"
          fill="Soft"
          radii="Pill"
          size="300"
          outlined
          onClick={() => scrollByAmount(-160)}
          aria-label="Прокрутить фильтры влево"
          style={{ position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)' }}
        >
          <Icon size="50" src={Icons.ChevronLeft} />
        </IconButton>
      )}
      {edges.right && (
        <IconButton
          className={css.Arrow}
          variant="Background"
          fill="Soft"
          radii="Pill"
          size="300"
          outlined
          onClick={() => scrollByAmount(160)}
          aria-label="Прокрутить фильтры вправо"
          style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)' }}
        >
          <Icon size="50" src={Icons.ChevronRight} />
        </IconButton>
      )}
    </Box>
  );
}
