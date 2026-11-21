import { describe, expect, it } from "vitest";
import { isForexOpen, isLimaSessionOpen } from "../src/market";

// Horario de Nueva York: EST = UTC-5 (invierno), EDT = UTC-4 (verano).
describe("isForexOpen", () => {
  it.each([
    // Invierno (EST): viernes 17:00 NY = 22:00 UTC
    ["2026-11-20T21:59:00Z", true, "viernes 16:59 EST"],
    ["2026-11-20T22:00:00Z", false, "viernes 17:00 EST"],
    ["2026-11-21T15:00:00Z", false, "sábado"],
    ["2026-11-22T21:59:00Z", false, "domingo 16:59 EST"],
    ["2026-11-22T22:00:00Z", true, "domingo 17:00 EST"],
    ["2026-11-23T12:00:00Z", true, "lunes"],
    ["2026-11-25T03:00:00Z", true, "martes de noche en NY"],
    // Verano (EDT): viernes 17:00 NY = 21:00 UTC
    ["2026-07-10T20:59:00Z", true, "viernes 16:59 EDT"],
    ["2026-07-10T21:00:00Z", false, "viernes 17:00 EDT"],
    ["2026-07-12T20:59:00Z", false, "domingo 16:59 EDT"],
    ["2026-07-12T21:00:00Z", true, "domingo 17:00 EDT"],
    // Días de cambio de horario (domingos): 2026-03-08 entra EDT, 2026-11-01 sale
    ["2026-03-08T20:59:00Z", false, "domingo cambio a EDT 16:59"],
    ["2026-03-08T21:00:00Z", true, "domingo cambio a EDT 17:00"],
    ["2026-11-01T21:59:00Z", false, "domingo cambio a EST 16:59"],
    ["2026-11-01T22:00:00Z", true, "domingo cambio a EST 17:00"],
    // Viernes en UTC pero aún jueves en NY
    ["2026-11-20T03:00:00Z", true, "jueves 22:00 EST"],
    // Sábado en UTC pero aún viernes en NY (cerrado igual: ya pasó de 17:00)
    ["2026-11-21T02:00:00Z", false, "viernes 21:00 EST"],
  ])("%s → %s (%s)", (iso, expected) => {
    expect(isForexOpen(new Date(iso))).toBe(expected);
  });
});

describe("isLimaSessionOpen", () => {
  it.each([
    ["2026-11-20T13:59:00Z", false, "viernes 08:59 Lima"],
    ["2026-11-20T14:00:00Z", true, "viernes 09:00 Lima"],
    ["2026-11-20T18:29:00Z", true, "viernes 13:29 Lima"],
    ["2026-11-20T18:30:00Z", false, "viernes 13:30 Lima"],
    ["2026-11-21T15:00:00Z", false, "sábado 10:00 Lima"],
  ])("%s → %s (%s)", (iso, expected) => {
    expect(isLimaSessionOpen(new Date(iso))).toBe(expected);
  });
});
