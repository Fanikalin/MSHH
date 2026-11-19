import React, { useCallback, useRef } from 'react';
import * as css from './Splitter.css';

type SplitterProps = {
  /** Current width of the column being resized, in px. */
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  /** Called with the final width after a drag or keyboard step. */
  onCommit?: (width: number) => void;
  label?: string;
};

/** Vertical drag handle between the nav column and the content pane. */
export function Splitter({ width, min, max, onResize, onCommit, label }: SplitterProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  const apply = useCallback(
    (next: number, commit: boolean) => {
      const clamped = Math.min(max, Math.max(min, Math.round(next)));
      onResize(clamped);
      if (commit) onCommit?.(clamped);
    },
    [min, max, onResize, onCommit]
  );

  return (
    // ARIA separator is a focusable, resizable widget here (slider-like pattern),
    // so pointer/keyboard handlers and tab order are intentional.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/role-supports-aria-props
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className={css.Splitter}
      onPointerDown={(evt) => {
        evt.currentTarget.setPointerCapture(evt.pointerId);
        dragRef.current = { startX: evt.clientX, startWidth: widthRef.current };
      }}
      onPointerMove={(evt) => {
        const drag = dragRef.current;
        if (!drag) return;
        apply(drag.startWidth + (evt.clientX - drag.startX), false);
      }}
      onPointerUp={(evt) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag) evt.currentTarget.releasePointerCapture(evt.pointerId);
        if (drag) apply(widthRef.current, true);
      }}
      onKeyDown={(evt) => {
        if (evt.key === 'ArrowLeft') {
          evt.preventDefault();
          apply(widthRef.current - 24, true);
        }
        if (evt.key === 'ArrowRight') {
          evt.preventDefault();
          apply(widthRef.current + 24, true);
        }
      }}
    />
  );
}
