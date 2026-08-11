import { describe, expect, it } from "vitest";
import {
  mapPostgresType,
  serializeClickHouseValue,
  type MirrorColumn,
} from "../worker/ClickHouseMirrorService";

describe("ClickHouse mirror type mapping", () => {
  it("keeps analytical scalar types typed", () => {
    expect(mapPostgresType({
      data_type: "bigint",
      udt_name: "int8",
      numeric_precision: 64,
      numeric_scale: 0,
    })).toBe("Int64");
    expect(mapPostgresType({
      data_type: "timestamp with time zone",
      udt_name: "timestamptz",
      numeric_precision: null,
      numeric_scale: null,
    })).toBe("DateTime64(6, 'UTC')");
    expect(mapPostgresType({
      data_type: "numeric",
      udt_name: "numeric",
      numeric_precision: 20,
      numeric_scale: 4,
    })).toBe("Decimal(20, 4)");
    expect(mapPostgresType({
      data_type: "numeric",
      udt_name: "numeric",
      numeric_precision: null,
      numeric_scale: null,
    })).toBe("String");
  });

  it("maps PostgreSQL arrays without losing nullable elements", () => {
    expect(mapPostgresType({
      data_type: "ARRAY",
      udt_name: "_uuid",
      numeric_precision: null,
      numeric_scale: null,
    })).toBe("Array(Nullable(UUID))");
  });
});

describe("ClickHouse mirror value serialization", () => {
  const column = (overrides: Partial<MirrorColumn>): MirrorColumn => ({
    name: "value",
    postgresType: "text",
    clickHouseType: "String",
    nullable: false,
    primaryKeyPosition: 0,
    ...overrides,
  });

  it("preserves binary payloads as reversible base64", () => {
    expect(serializeClickHouseValue(
      column({ postgresType: "bytea" }),
      Buffer.from([0x00, 0xff, 0x10, 0x20]),
    )).toBe("AP8QIA==");
  });

  it("stores JSON values as valid JSON strings", () => {
    expect(serializeClickHouseValue(
      column({ postgresType: "jsonb" }),
      { enabled: true, values: [1, 2] },
    )).toBe('{"enabled":true,"values":[1,2]}');
  });

  it("formats timestamps at ClickHouse microsecond precision", () => {
    expect(serializeClickHouseValue(
      column({ postgresType: "timestamptz", clickHouseType: "DateTime64(6, 'UTC')" }),
      new Date("2026-08-11T09:10:11.123Z"),
    )).toBe("2026-08-11 09:10:11.123000");
  });
});
