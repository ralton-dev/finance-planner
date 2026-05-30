import { describe, expect, it } from "vitest";
import { buildAbility, subject } from "./ability.js";

const accountA = { id: "acc-A" };
const accountB = { id: "acc-B" };
const householdH = { id: "hh-H" };

describe("buildAbility — accounts", () => {
  it("owner can view/edit/delete/share their own account", () => {
    const ability = buildAbility({
      userId: "u1",
      accountAccess: [{ id: "acc-A", isOwner: true, permission: "edit" }],
      households: [],
    });
    expect(ability.can("view", subject("Account", accountA))).toBe(true);
    expect(ability.can("edit", subject("Account", accountA))).toBe(true);
    expect(ability.can("delete", subject("Account", accountA))).toBe(true);
    expect(ability.can("share", subject("Account", accountA))).toBe(true);
  });

  it("edit-share can view + edit but not delete or share", () => {
    const ability = buildAbility({
      userId: "u2",
      accountAccess: [{ id: "acc-A", isOwner: false, permission: "edit" }],
      households: [],
    });
    expect(ability.can("view", subject("Account", accountA))).toBe(true);
    expect(ability.can("edit", subject("Account", accountA))).toBe(true);
    expect(ability.can("delete", subject("Account", accountA))).toBe(false);
    expect(ability.can("share", subject("Account", accountA))).toBe(false);
  });

  it("view-share can view but not edit", () => {
    const ability = buildAbility({
      userId: "u3",
      accountAccess: [{ id: "acc-A", isOwner: false, permission: "view" }],
      households: [],
    });
    expect(ability.can("view", subject("Account", accountA))).toBe(true);
    expect(ability.can("edit", subject("Account", accountA))).toBe(false);
  });

  it("a stranger cannot do anything on an account they don't have access to", () => {
    const ability = buildAbility({
      userId: "u4",
      accountAccess: [{ id: "acc-A", isOwner: true, permission: "edit" }],
      households: [],
    });
    expect(ability.can("view", subject("Account", accountB))).toBe(false);
    expect(ability.can("edit", subject("Account", accountB))).toBe(false);
  });

  it("hasAnyAccess distinguishes no-access from insufficient-access (drives the 404 vs 403 rule)", () => {
    const ability = buildAbility({
      userId: "u5",
      accountAccess: [{ id: "acc-A", isOwner: false, permission: "view" }],
      households: [],
    });
    // Has access, but only view → cannot edit.
    expect(ability.hasAnyAccess(subject("Account", accountA))).toBe(true);
    expect(ability.can("edit", subject("Account", accountA))).toBe(false);
    // No access at all → hasAnyAccess returns false → caller raises 404.
    expect(ability.hasAnyAccess(subject("Account", accountB))).toBe(false);
  });
});

describe("buildAbility — households", () => {
  it("owner can manage members, change roles, and delete the household", () => {
    const ability = buildAbility({
      userId: "u1",
      accountAccess: [],
      households: [{ id: "hh-H", role: "owner" }],
    });
    expect(ability.can("view", subject("Household", householdH))).toBe(true);
    expect(ability.can("manage_members", subject("Household", householdH))).toBe(true);
    expect(ability.can("change_roles", subject("Household", householdH))).toBe(true);
    expect(ability.can("delete_household", subject("Household", householdH))).toBe(true);
  });

  it("admin can manage members but not change roles or delete the household", () => {
    const ability = buildAbility({
      userId: "u2",
      accountAccess: [],
      households: [{ id: "hh-H", role: "admin" }],
    });
    expect(ability.can("manage_members", subject("Household", householdH))).toBe(true);
    expect(ability.can("change_roles", subject("Household", householdH))).toBe(false);
    expect(ability.can("delete_household", subject("Household", householdH))).toBe(false);
  });

  it("member can only view", () => {
    const ability = buildAbility({
      userId: "u3",
      accountAccess: [],
      households: [{ id: "hh-H", role: "member" }],
    });
    expect(ability.can("view", subject("Household", householdH))).toBe(true);
    expect(ability.can("manage_members", subject("Household", householdH))).toBe(false);
    expect(ability.can("change_roles", subject("Household", householdH))).toBe(false);
    expect(ability.can("delete_household", subject("Household", householdH))).toBe(false);
  });

  it("non-member cannot see the household at all", () => {
    const ability = buildAbility({
      userId: "u4",
      accountAccess: [],
      households: [{ id: "hh-OTHER", role: "owner" }],
    });
    expect(ability.can("view", subject("Household", householdH))).toBe(false);
  });
});
