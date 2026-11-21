import { describe, expect, it } from "vitest";
import { parseBcrpDate, parseBcrpResponse, parseBcrpValue } from "../src/bcrp/parse";

describe("parseBcrpDate", () => {
  it.each([
    ["20.Nov.26", "2026-11-20"],
    ["02.Ene.26", "2026-01-02"],
    ["15.Set.25", "2025-09-15"], // septiembre del BCRP
    ["15.Sep.25", "2025-09-15"],
    ["1.Dic.25", "2025-12-01"],
    ["29.Feb.24", "2024-02-29"], // bisiesto
    [" 31.Ago.26 ", "2026-08-31"],
  ])("%s → %s", (raw, expected) => {
    expect(parseBcrpDate(raw)).toBe(expected);
  });

  it.each(["29.Feb.25", "31.Abr.26", "00.Ene.26", "20.Xyz.26", "2026-11-20", "20/Nov/26", ""])(
    "%s → null",
    (raw) => {
      expect(parseBcrpDate(raw)).toBeNull();
    },
  );
});

describe("parseBcrpValue", () => {
  it("convierte números en texto", () => {
    expect(parseBcrpValue("3.37071428571429")).toBeCloseTo(3.37071428571429, 12);
    expect(parseBcrpValue("3")).toBe(3);
  });
  it.each(["n.d.", "", "  ", "-3.4", "0", "abc", null, undefined, 3.4])("%s → null", (raw) => {
    expect(parseBcrpValue(raw)).toBeNull();
  });
});

describe("parseBcrpResponse", () => {
  const body = {
    config: { title: "Tipo de cambio", series: [] },
    periods: [
      { name: "19.Nov.26", values: ["3.371", "3.375"] },
      { name: "20.Nov.26", values: ["n.d.", "n.d."] }, // sin publicar → se descarta
      { name: "21.Nov.26", values: ["n.d.", "3.380"] }, // parcial → se conserva con null
      { name: "basura", values: ["3.1", "3.2"] },
      { name: "22.Set.26", values: ["3.4"] }, // falta venta
    ],
  };

  it("parsea filas válidas, descarta n.d. completos y conserva parciales", () => {
    expect(parseBcrpResponse(body)).toEqual([
      { date: "2026-11-19", compra: 3.371, venta: 3.375 },
      { date: "2026-11-21", compra: null, venta: 3.38 },
      { date: "2026-09-22", compra: 3.4, venta: null },
    ]);
  });

  it("lanza si la respuesta no tiene periods", () => {
    expect(() => parseBcrpResponse({ error: "x" })).toThrow(/periods/);
    expect(() => parseBcrpResponse(null)).toThrow(/periods/);
  });

  it("periods vacío → sin filas", () => {
    expect(parseBcrpResponse({ periods: [] })).toEqual([]);
  });
});
