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

describe("buildAbility — projects", () => {
  const mine = { id: "proj-1", ownerUserId: "u1" };
  const theirs = { id: "proj-2", ownerUserId: "u2" };

  it("the owner may do everything with their own project", () => {
    const ability = buildAbility({ userId: "u1", accountAccess: [], households: [] });
    expect(ability.can("view", subject("Project", mine))).toBe(true);
    expect(ability.can("edit", subject("Project", mine))).toBe(true);
    expect(ability.can("delete", subject("Project", mine))).toBe(true);
    expect(ability.hasAnyAccess(subject("Project", mine))).toBe(true);
  });

  it("someone else's project is not there at all — which is the 404", () => {
    const ability = buildAbility({ userId: "u1", accountAccess: [], households: [] });
    expect(ability.hasAnyAccess(subject("Project", theirs))).toBe(false);
    expect(ability.can("view", subject("Project", theirs))).toBe(false);
    // `file_payment` is what filing a payment into a project asks for.
    expect(ability.cannot("file_payment", subject("Project", theirs))).toBe(true);
  });

  /**
   * The second arm (MINE-AND-OURS decision 22). A **shared** project belongs to
   * its owner and is readable by everybody in their household — and the split
   * between `file_payment` and `edit` is what keeps "put your payment in it"
   * apart from "rename it, retarget it, un-share it".
   */
  it("a co-member may read a shared project and put payments in it, and nothing more", () => {
    const theirShared = { id: "proj-2", ownerUserId: "u2", visibility: "shared" as const };
    const ability = buildAbility({
      userId: "u1",
      accountAccess: [],
      households: [],
      householdMemberIds: ["u2"],
    });
    expect(ability.hasAnyAccess(subject("Project", theirShared))).toBe(true);
    expect(ability.can("view", subject("Project", theirShared))).toBe(true);
    expect(ability.can("file_payment", subject("Project", theirShared))).toBe(true);
    // These three are the 403 a co-member meets on PATCH and DELETE.
    expect(ability.can("edit", subject("Project", theirShared))).toBe(false);
    expect(ability.can("delete", subject("Project", theirShared))).toBe(false);
    expect(ability.can("share", subject("Project", theirShared))).toBe(false);
  });

  it("neither half of the shared arm grants anything on its own", () => {
    const theirShared = { id: "proj-2", ownerUserId: "u2", visibility: "shared" as const };
    // Shared, but by somebody you share no household with.
    expect(
      buildAbility({
        userId: "u1",
        accountAccess: [],
        households: [],
        householdMemberIds: ["u3"],
      }).hasAnyAccess(subject("Project", theirShared)),
    ).toBe(false);
    // A co-member's project that is not shared.
    expect(
      buildAbility({
        userId: "u1",
        accountAccess: [],
        households: [],
        householdMemberIds: ["u2"],
      }).hasAnyAccess(subject("Project", theirs)),
    ).toBe(false);
    // And an omitted roster reads as an empty one, which is what a user with no
    // household has: a shared project reaching nobody but its owner.
    expect(
      buildAbility({ userId: "u1", accountAccess: [], households: [] }).hasAnyAccess(
        subject("Project", theirShared),
      ),
    ).toBe(false);
  });

  it("defaults an unstated visibility to personal rather than to shared", () => {
    // `subject` fills it in, so a caller that has never heard of sharing cannot
    // accidentally widen a project by omitting the field.
    expect(subject("Project", theirs).visibility).toBe("personal");
  });

  it("a project id does not borrow an account's access, or the other way round", () => {
    const ability = buildAbility({
      userId: "u1",
      accountAccess: [{ id: "shared-id", isOwner: true, permission: "edit" }],
      households: [{ id: "shared-id", role: "owner" }],
    });
    // Same id, three kinds: the project arm reads the ref's owner and nothing
    // else, so owning an account that happens to share an id grants nothing.
    expect(ability.can("view", subject("Project", { id: "shared-id", ownerUserId: "u2" }))).toBe(
      false,
    );
    expect(ability.can("view", subject("Account", { id: "shared-id" }))).toBe(true);
  });
});
