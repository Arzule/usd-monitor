import { LIMA_TZ } from "./time";

/**
 * Horario del mercado forex global, calculado en hora de Nueva York para que
 * el cambio de horario (EST/EDT) se aplique solo.
 * Cerrado desde el viernes 17:00 hasta el domingo 17:00 (America/New_York).
 */
const NY_TZ = "America/New_York";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

interface ZonedParts {
  weekday: number; // 0 = domingo
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const weekday = WEEKDAYS.indexOf(get("weekday") as (typeof WEEKDAYS)[number]);
  return { weekday, hour: Number(get("hour")), minute: Number(get("minute")) };
}

/** true si el mercado forex global está abierto en `date`. */
export function isForexOpen(date: Date): boolean {
  const { weekday, hour } = zonedParts(date, NY_TZ);
  if (weekday === 6) return false; // sábado
  if (weekday === 5) return hour < 17; // viernes hasta las 17:00
  if (weekday === 0) return hour >= 17; // domingo desde las 17:00
  return true;
}

/**
 * Horario del mercado cambiario interbancario de Lima (lunes a viernes).
 * Se usa para la banda sombreada y el aviso del dashboard.
 */
export const LIMA_SESSION = { startMinutes: 9 * 60, endMinutes: 13 * 60 + 30 } as const;

export function isLimaSessionOpen(date: Date): boolean {
  const { weekday, hour, minute } = zonedParts(date, LIMA_TZ);
  if (weekday === 0 || weekday === 6) return false;
  const m = hour * 60 + minute;
  return m >= LIMA_SESSION.startMinutes && m < LIMA_SESSION.endMinutes;
}
