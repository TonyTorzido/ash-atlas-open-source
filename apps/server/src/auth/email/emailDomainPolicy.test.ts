import { describe, expect, it } from "vitest";

import { loadConfig } from "../../config.js";
import { canonicalEmail, isEmailDomainAllowed, normalizeEmailAddress } from "./emailDomainPolicy.js";

const blocklist = { mode: "blocklist" as const, allowlist: [], blocklistExtra: ["spam.example"] };
const allowlist = { mode: "allowlist" as const, allowlist: [], blocklistExtra: [] };

describe("email address normalization", () => {
  it.each([
    [" Player.Name+tag@Example.COM ", "player.name+tag@example.com"],
    ["a@b.co", "a@b.co"],
    ["user@sub.school.edu", "user@sub.school.edu"]
  ])("accepts %j", (input, expected) => {
    expect(normalizeEmailAddress(input)).toBe(expected);
  });

  it.each([
    "no-at-sign",
    "two@@example.com",
    "a@b@example.com",
    ".lead@example.com",
    "trail.@example.com",
    "dou..ble@example.com",
    "user@localhost",
    "user@-bad.example",
    "user@example.c0m",
    "user@exa_mple.com",
    "user name@example.com",
    "user@example.com\r\nbcc:x@example.com",
    `${"a".repeat(65)}@example.com`
  ])("rejects %j", (input) => {
    expect(normalizeEmailAddress(input)).toBeNull();
  });
});

const CANONICAL_EMAIL_CASES: ReadonlyArray<readonly [string, string]> = [
  ["player@gmail.com", "player@gmail.com"],
  ["Player+Alt@Gmail.com", "player@gmail.com"],
  ["p.l.a.y.e.r@gmail.com", "player@gmail.com"],
  ["p.layer+x+y@googlemail.com", "player@gmail.com"],
  ["player@googlemail.com", "player@gmail.com"],
  ["first.last@outlook.com", "first.last@outlook.com"],
  ["first.last+game@outlook.com", "first.last@outlook.com"],
  ["first.last+game@hotmail.co.uk", "first.last@hotmail.co.uk"],
  ["a.b+c@yahoo.com", "a.b@yahoo.com"],
  ["x.y@mail.gmail.com", "x.y@mail.gmail.com"],
  ["x.y+z@gmail.com.evil.com", "x.y@gmail.com.evil.com"],
  ["+only@gmail.com", "@gmail.com"],
  ["no-at-sign", "no-at-sign"]
];

describe("canonical email", () => {
  it.each(CANONICAL_EMAIL_CASES)("%j -> %j", (input, expected) => {
    expect(canonicalEmail(input)).toBe(expected);
  });
});

describe("email domain policy", () => {
  it.each([
    "x@gmail.com",
    "x@googlemail.com",
    "x@outlook.com",
    "x@hotmail.co.uk",
    "x@live.com.au",
    "x@msn.com",
    "x@yahoo.co.jp",
    "x@ymail.com",
    "x@icloud.com",
    "x@me.com",
    "x@aol.com",
    "x@gmx.de"
  ])("default allowlist accepts %j", (email) => {
    expect(isEmailDomainAllowed(email, allowlist)).toBe(true);
  });

  it.each([
    "x@privaterelay.appleid.com",
    "x@duck.com",
    "x@mozmail.com",
    "x@simplelogin.com",
    "x@addy.io",
    "x@passmail.net",
    "x@proton.me",
    "x@protonmail.com",
    "x@pm.me",
    "x@tuta.io",
    "x@mailinator.com",
    "x@mycompany.com",
    "x@mail.gmail.com",
    "x@gmail.com.evil.com",
    "x@mail.gmail.com.evil.com",
    "x@gmail.co"
  ])("default allowlist rejects %j", (email) => {
    expect(isEmailDomainAllowed(email, allowlist)).toBe(false);
  });

  it("adds AUTH_EMAIL_DOMAIN_ALLOWLIST domains to the built-in list, exact match only", () => {
    const config = loadConfig({ NODE_ENV: "test", AUTH_EMAIL_DOMAIN_ALLOWLIST: " School.edu, @fastmail.com " });
    expect(config.AUTH_EMAIL_DOMAIN_POLICY).toBe("allowlist");
    const policy = {
      mode: config.AUTH_EMAIL_DOMAIN_POLICY,
      allowlist: config.AUTH_EMAIL_DOMAIN_ALLOWLIST,
      blocklistExtra: config.AUTH_EMAIL_DOMAIN_BLOCKLIST_EXTRA
    };
    expect(isEmailDomainAllowed("x@school.edu", policy)).toBe(true);
    expect(isEmailDomainAllowed("x@fastmail.com", policy)).toBe(true);
    expect(isEmailDomainAllowed("x@gmail.com", policy)).toBe(true);
    expect(isEmailDomainAllowed("x@evil.school.edu", policy)).toBe(false);
    expect(isEmailDomainAllowed("x@proton.me", policy)).toBe(false);
  });

  it("blocklist mode blocks disposable and relay domains, their subdomains, and extra domains", () => {
    expect(isEmailDomainAllowed("x@mailinator.com", blocklist)).toBe(false);
    expect(isEmailDomainAllowed("x@inbox.mailinator.com", blocklist)).toBe(false);
    expect(isEmailDomainAllowed("x@spam.example", blocklist)).toBe(false);
    expect(isEmailDomainAllowed("x@abc.privaterelay.appleid.com", blocklist)).toBe(false);
    expect(isEmailDomainAllowed("x@proton.me", blocklist)).toBe(false);
    expect(isEmailDomainAllowed("x@duck.com", blocklist)).toBe(false);
    expect(isEmailDomainAllowed("x@gmail.com", blocklist)).toBe(true);
    expect(isEmailDomainAllowed("x@mycompany.com", blocklist)).toBe(true);
    expect(isEmailDomainAllowed("x@notmailinator.com", blocklist)).toBe(true);
  });
});
