import { describe, expect, it } from "vitest";
import {
  displayStations,
  stationDepartment,
} from "@/lib/production-displays";

describe("existing hotel production station compatibility", () => {
  const stations = [
    {
      id: "mawimbi-coffee",
      name: "Coffee Station",
      code: "coffee-station",
      station_type: "beverage",
      department_key: "food-and-beverage",
    },
    {
      id: "mawimbi-pastry",
      name: "Pastry",
      code: "pastry",
      station_type: "production",
      department_key: "pastry-and-bakery",
    },
    {
      id: "mombasa-coffee",
      name: "Coffee Station",
      code: "scm-coffee",
      station_type: "beverage",
      department_key: "bar",
    },
    {
      id: "mombasa-pastry",
      name: "Pastry",
      code: "scm--pastry",
      station_type: "production",
      department_key: "pastry-and-bakery",
    },
  ];

  it("recognizes Mawimbi Jiko coffee station", () => {
    expect(stationDepartment(stations[0]!)).toBe("coffee");
  });

  it("recognizes Mawimbi Jiko pastry station", () => {
    expect(stationDepartment(stations[1]!)).toBe("pastry");
  });

  it("recognizes Savanna Crown Mombasa coffee station", () => {
    expect(stationDepartment(stations[2]!)).toBe("coffee");
  });

  it("recognizes Savanna Crown Mombasa pastry station", () => {
    expect(stationDepartment(stations[3]!)).toBe("pastry");
  });

  it("keeps coffee separate from bar", () => {
    expect(displayStations(stations, "coffee").map(s => s.id))
      .toEqual(["mawimbi-coffee", "mombasa-coffee"]);

    expect(displayStations(stations, "bar")).toEqual([]);
  });

  it("recognizes existing pastry stations", () => {
    expect(displayStations(stations, "pastry").map(s => s.id))
      .toEqual(["mawimbi-pastry", "mombasa-pastry"]);
  });

  it("never exposes service stations as production displays", () => {
    const service = {
      id: "service",
      name: "Coffee Station",
      station_type: "service",
      department_key: "food-and-beverage",
    };

    expect(stationDepartment(service)).toBeNull();
    expect(displayStations([service], "coffee")).toEqual([]);
  });

  it("does not infer production access from unrelated departments", () => {
    expect(stationDepartment({
      id: "front-office",
      name: "Coffee Lobby",
      station_type: "production",
      department_key: "front-office",
    })).toBeNull();
  });
});
