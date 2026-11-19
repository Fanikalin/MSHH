import React, { MouseEventHandler, useState } from 'react';
import {
  Box,
  Button,
  Icon,
  Icons,
  Input,
  Menu,
  MenuItem,
  PopOut,
  RectCords,
  Switch,
  Text,
  config,
  toRem,
} from 'folds';
import FocusTrap from 'focus-trap-react';
import { stopPropagation } from '../../../utils/keyboard';
import type { ModuleProfileField } from '../../../../mshh/types';

export type ProfileFieldValues = Record<string, string | number | boolean>;

export const initialFieldValues = (fields: ModuleProfileField[]): ProfileFieldValues => {
  const values: ProfileFieldValues = {};
  for (const field of fields) {
    if (field.default !== undefined) values[field.key] = field.default;
    else if (field.type === 'select' && field.options && field.options.length > 0)
      values[field.key] = field.options[0].value;
    else if (field.type === 'boolean') values[field.key] = false;
    else values[field.key] = '';
  }
  return values;
};

export const findMissingRequired = (
  fields: ModuleProfileField[],
  values: ProfileFieldValues
): ModuleProfileField | undefined =>
  fields.find((field) => {
    if (!field.required || field.type === 'boolean') return false;
    const v = values[field.key];
    return typeof v !== 'string' && typeof v !== 'number' ? true : String(v).trim().length === 0;
  });

export const fieldValuesToConfig = (
  fields: ModuleProfileField[],
  values: ProfileFieldValues
): Record<string, unknown> => {
  const cfg: Record<string, unknown> = {};
  for (const field of fields) {
    const v = values[field.key];
    if (field.type === 'boolean') {
      cfg[field.key] = Boolean(v);
      continue;
    }
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (typeof v === 'string' && v.trim().length === 0) continue;
    cfg[field.key] = field.type === 'number' ? Number(v) : v;
  }
  return cfg;
};

function SelectField({
  field,
  value,
  onChange,
  inputId,
}: {
  field: ModuleProfileField;
  value: string;
  onChange: (v: string) => void;
  inputId: string;
}) {
  const [menuCords, setMenuCords] = useState<RectCords>();
  const options = field.options ?? [];
  const selected = options.find((o) => o.value === value);

  const handleOpenMenu: MouseEventHandler<HTMLButtonElement> = (evt) => {
    setMenuCords(evt.currentTarget.getBoundingClientRect());
  };

  return (
    <>
      <Button
        id={inputId}
        size="300"
        variant="Primary"
        outlined
        fill="Soft"
        radii="300"
        after={<Icon size="200" src={Icons.ChevronBottom} />}
        onClick={handleOpenMenu}
      >
        <Text size="B300" truncate>
          {selected?.label ?? field.label}
        </Text>
      </Button>
      <PopOut
        anchor={menuCords}
        offset={5}
        position="Bottom"
        align="Start"
        content={
          <FocusTrap
            focusTrapOptions={{
              initialFocus: false,
              onDeactivate: () => setMenuCords(undefined),
              clickOutsideDeactivates: true,
              isKeyForward: (evt: KeyboardEvent) => evt.key === 'ArrowDown',
              isKeyBackward: (evt: KeyboardEvent) => evt.key === 'ArrowUp',
              escapeDeactivates: stopPropagation,
            }}
          >
            <Menu style={{ maxWidth: toRem(250) }}>
              <Box direction="Column" gap="100" style={{ padding: config.space.S100 }}>
                {options.map((option) => (
                  <MenuItem
                    key={option.value}
                    size="300"
                    variant={option.value === value ? 'Primary' : 'Surface'}
                    radii="300"
                    onClick={() => {
                      onChange(option.value);
                      setMenuCords(undefined);
                    }}
                  >
                    <Text size="T300" truncate>
                      {option.label}
                    </Text>
                  </MenuItem>
                ))}
              </Box>
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}

type ProfileFieldsFormProps = {
  fields: ModuleProfileField[];
  values: ProfileFieldValues;
  onChange: (values: ProfileFieldValues) => void;
  idPrefix: string;
};

/** Schema-driven config form rendered from module.profileFields. */
export function ProfileFieldsForm({ fields, values, onChange, idPrefix }: ProfileFieldsFormProps) {
  const set = (key: string, v: string | number | boolean) => onChange({ ...values, [key]: v });

  return (
    <Box direction="Column" gap="300">
      {fields.map((field) => {
        const inputId = `${idPrefix}-${field.key}`;
        return (
          <Box key={field.key} direction="Column" gap="100">
            {field.type === 'boolean' ? (
              <Box alignItems="Center" justifyContent="SpaceBetween" gap="200">
                <Text size="T300">
                  {field.label}
                  {field.required ? ' *' : ''}
                </Text>
                <Switch
                  variant="Primary"
                  value={Boolean(values[field.key])}
                  onChange={(on) => set(field.key, on)}
                />
              </Box>
            ) : (
              <>
                <Text as="label" htmlFor={inputId} size="T300">
                  {field.label}
                  {field.required ? ' *' : ''}
                </Text>
                {field.type === 'select' ? (
                  <SelectField
                    inputId={inputId}
                    field={field}
                    value={String(values[field.key] ?? '')}
                    onChange={(v) => set(field.key, v)}
                  />
                ) : (
                  <Input
                    id={inputId}
                    variant="SurfaceVariant"
                    size="400"
                    radii="300"
                    type={
                      field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text'
                    }
                    placeholder={field.placeholder}
                    value={String(values[field.key] ?? '')}
                    onChange={(e) =>
                      set(
                        field.key,
                        field.type === 'number' && e.currentTarget.value !== ''
                          ? Number(e.currentTarget.value)
                          : e.currentTarget.value
                      )
                    }
                    autoComplete="off"
                  />
                )}
              </>
            )}
            {field.hint && (
              <Text size="T200" priority="300">
                {field.hint}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
