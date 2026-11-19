import React from 'react';
import { Chip, Text } from 'folds';

/** Non-interactive module name chip. */
export function ModuleChip({ name }: { name: string }) {
  return (
    <Chip as="span" size="400" variant="Secondary" fill="Soft" radii="Pill" outlined={false}>
      <Text as="span" size="L400" truncate>
        {name}
      </Text>
    </Chip>
  );
}
