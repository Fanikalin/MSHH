import React, { ReactNode } from 'react';
import { Box, Text } from 'folds';

type EmptyStateProps = {
  title: string;
  subtitle?: string;
  children?: ReactNode;
};

/** Neutral centered placeholder for an empty content pane. */
export function EmptyState({ title, subtitle, children }: EmptyStateProps) {
  return (
    <Box grow="Yes" direction="Column" alignItems="Center" justifyContent="Center" gap="300">
      <Text size="H2" align="Center">
        {title}
      </Text>
      {subtitle && (
        <Text size="T300" priority="300" align="Center">
          {subtitle}
        </Text>
      )}
      {children}
    </Box>
  );
}

/** Right-pane placeholder of the /mshh home: no chat selected yet. */
export function MshhEmpty() {
  return <EmptyState title="MSHH" subtitle="Выберите чат слева" />;
}
