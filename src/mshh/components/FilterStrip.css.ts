import { style } from '@vanilla-extract/css';

export const Strip = style({
  position: 'relative',
  minWidth: 0,
});

export const Scroll = style({
  overflowX: 'auto',
  overflowY: 'hidden',
  scrollbarWidth: 'none',
  selectors: {
    '&::-webkit-scrollbar': {
      display: 'none',
    },
  },
});

export const Arrow = style({
  opacity: 0,
  transition: 'opacity 150ms ease',
  selectors: {
    [`${Strip}:hover &`]: {
      opacity: 1,
    },
  },
});
