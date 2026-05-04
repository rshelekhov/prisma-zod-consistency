import { describe, expect, it } from "vitest";
import { parsePrismaRegistry } from "../src/schema/prisma-models.js";

describe("PrismaModelRegistry — attribute parsing", () => {
  it("strips quotes from positional string args (e.g. @map, @@map)", () => {
    const source = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Booking {
  id          String @id @default(cuid())
  referenceId String @map("reference_id")
  clientId    String @map("client_id")

  @@map("bookings")
}
`;
    const registry = parsePrismaRegistry(source);
    const model = registry.models.get("Booking");
    expect(model).toBeDefined();
    expect(model?.tableName).toBe("bookings"); // @@map respected, no quotes

    const referenceField = model?.fields.find((f) => f.name === "referenceId");
    expect(referenceField).toBeDefined();
    const mapAttr = referenceField?.attributes.find((a) => a.name === "map");
    expect(mapAttr).toBeDefined();
    const arg = mapAttr?.args[0];
    expect(arg?.kind).toBe("literal");
    if (arg?.kind === "literal") {
      // Critical regression: must be 'reference_id', NOT '"reference_id"'.
      expect(arg.value).toBe("reference_id");
    }
  });
});
