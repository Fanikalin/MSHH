import dayjs from 'dayjs';
import 'dayjs/locale/ru';

dayjs.locale('ru');

/** Time in the chat list rows: HH:mm today, otherwise a short date. */
export const formatListTime = (ts: number): string => {
  const date = dayjs(ts);
  if (!ts || !date.isValid()) return '';
  return date.isSame(dayjs(), 'day') ? date.format('HH:mm') : date.format('DD.MM.YYYY');
};

/** HH:mm for message bubbles. */
export const formatMessageTime = (ts: number): string => dayjs(ts).format('HH:mm');

/** Day separator label: Сегодня / Вчера / «19 ноября 2026». */
export const formatDaySeparator = (ts: number): string => {
  const date = dayjs(ts);
  const now = dayjs();
  if (date.isSame(now, 'day')) return 'Сегодня';
  if (date.isSame(now.subtract(1, 'day'), 'day')) return 'Вчера';
  return date.format('D MMMM YYYY');
};

export const isSameDay = (a: number, b: number): boolean => dayjs(a).isSame(dayjs(b), 'day');

/** Human-readable byte size, «1,5 МБ»-style suffixes in Russian. */
export const formatBytes = (size?: number): string => {
  if (!size || size < 0) return '';
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / 1024 / 1024).toFixed(1)} МБ`;
};
