import { describe, expect, it } from "vitest";
import { filenameFromDisposition } from "./files.js";

describe("filenameFromDisposition", () => {
  it("reads the quoted filename the export sends", () => {
    expect(
      filenameFromDisposition('attachment; filename="finance-planner-export-2026-08-04.json"'),
    ).toBe("finance-planner-export-2026-08-04.json");
  });

  it("reads an unquoted filename", () => {
    expect(filenameFromDisposition("attachment; filename=export.json")).toBe("export.json");
  });

  it("prefers the RFC 5987 form and decodes it", () => {
    expect(
      filenameFromDisposition(
        "attachment; filename=\"fallback.json\"; filename*=UTF-8''my%20data.json",
      ),
    ).toBe("my data.json");
  });

  it("never lets the header steer where the file lands", () => {
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe("passwd");
  });

  it("returns null when there is nothing usable to read", () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition(undefined)).toBeNull();
    expect(filenameFromDisposition("attachment")).toBeNull();
    expect(filenameFromDisposition('attachment; filename=""')).toBeNull();
  });
});
