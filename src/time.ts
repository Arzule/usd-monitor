export const LIMA_TZ = "America/Lima";

const limaDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: LIMA_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Fecha calendario en Lima, "YYYY-MM-DD". */
export function limaDate(d: Date): string {
  return limaDateFmt.format(d);
}
