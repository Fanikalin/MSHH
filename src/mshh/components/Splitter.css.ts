import { style } from '@vanilla-extract/css';
import { color, toRem } from 'folds';

export const Splitter = style({
  width: toRem(6),
  flexShrink: 0,
  cursor: 'col-resize',
  touchAction: 'none',
  selectors: {
    '&:hover': {
      backgroundColor: color.Background.ContainerHover,
    },
    '&:focus-visible': {
      backgroundColor: color.Background.ContainerActive,
      outline: 'none',
    },
  },
});
