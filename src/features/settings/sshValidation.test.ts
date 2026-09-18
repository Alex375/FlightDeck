import { describe, expect, it } from "vitest";
import { firstConnectionFieldError, validateSshHost, validateSshPort, validateSshUser } from "./sshValidation";

// Mirrors `src-tauri/src/store/model.rs`'s `ssh_validation_tests` module — same
// exploit strings, same legitimate shapes. CRM holistic-review blocker #3, chantier A
// `bd7ca709`: a hostile pairing ticket's `user` field must never make it to "Test &
// pair" — see `sshValidation.ts`'s own module doc.
describe("validateSshUser", () => {
  it("rejects the option-injection exploit string", () => {
    expect(validateSshUser("-oProxyCommand=touch /tmp/pwned")).not.toBeNull();
  });

  it("rejects a short option exploit string", () => {
    expect(validateSshUser("-F/etc/x")).not.toBeNull();
  });

  it("rejects a leading space", () => {
    expect(validateSshUser(" user")).not.toBeNull();
  });

  it("rejects an embedded space", () => {
    expect(validateSshUser("a b")).not.toBeNull();
  });

  it("rejects an at sign", () => {
    expect(validateSshUser("root@evil")).not.toBeNull();
  });

  it("rejects empty", () => {
    expect(validateSshUser("")).not.toBeNull();
  });

  it("rejects 65 characters", () => {
    expect(validateSshUser("a".repeat(65))).not.toBeNull();
  });

  it("accepts 64 characters", () => {
    expect(validateSshUser("a".repeat(64))).toBeNull();
  });

  it("rejects unicode", () => {
    expect(validateSshUser("josé")).not.toBeNull();
  });

  it("rejects control characters", () => {
    expect(validateSshUser("user\tname")).not.toBeNull();
    expect(validateSshUser("user\nname")).not.toBeNull();
  });

  it("rejects a colon", () => {
    expect(validateSshUser("user:pw")).not.toBeNull();
  });

  it("rejects a slash", () => {
    expect(validateSshUser("user/name")).not.toBeNull();
  });

  it("accepts ordinary login names", () => {
    for (const u of ["deploy", "josty", "root"]) {
      expect(validateSshUser(u)).toBeNull();
    }
  });

  it("accepts a dotted login name", () => {
    expect(validateSshUser("first.last")).toBeNull();
  });

  it("accepts underscores and hyphens not leading", () => {
    expect(validateSshUser("svc_build-2")).toBeNull();
  });

  it("accepts a trailing dollar machine account", () => {
    expect(validateSshUser("WORKGROUP$")).toBeNull();
  });

  it("rejects a bare dollar sign", () => {
    expect(validateSshUser("$")).not.toBeNull();
  });

  it("rejects a dollar sign in the middle", () => {
    expect(validateSshUser("wo$rk")).not.toBeNull();
  });
});

describe("validateSshHost", () => {
  it("rejects empty", () => {
    expect(validateSshHost("")).not.toBeNull();
  });

  it("rejects a leading dash", () => {
    expect(validateSshHost("-oProxyCommand=touch /tmp/pwned")).not.toBeNull();
  });

  it("rejects whitespace", () => {
    expect(validateSshHost("has space")).not.toBeNull();
    expect(validateSshHost("has\ttab")).not.toBeNull();
  });

  it("accepts ordinary hosts", () => {
    expect(validateSshHost("box.tailnet.ts.net")).toBeNull();
    expect(validateSshHost("192.168.1.5")).toBeNull();
  });
});

describe("validateSshPort", () => {
  it("rejects zero", () => {
    expect(validateSshPort(0)).not.toBeNull();
  });

  it("rejects out of range", () => {
    expect(validateSshPort(65536)).not.toBeNull();
    expect(validateSshPort(-1)).not.toBeNull();
  });

  it("rejects non-integers", () => {
    expect(validateSshPort(22.5)).not.toBeNull();
    expect(validateSshPort(Number.NaN)).not.toBeNull();
  });

  it("accepts ordinary ports", () => {
    expect(validateSshPort(22)).toBeNull();
    expect(validateSshPort(1)).toBeNull();
    expect(validateSshPort(65535)).toBeNull();
  });
});

describe("firstConnectionFieldError", () => {
  it("is null when every field is valid", () => {
    expect(firstConnectionFieldError("deploy", "example.com", 22)).toBeNull();
  });

  it("catches an exploit user even when host/port are fine — the ticket-pre-fill case", () => {
    expect(firstConnectionFieldError("-oProxyCommand=touch /tmp/pwned", "example.com", 22)).not.toBeNull();
  });

  it("catches an exploit host", () => {
    expect(firstConnectionFieldError("deploy", "-oProxyCommand=touch /tmp/pwned", 22)).not.toBeNull();
  });

  it("catches an invalid port", () => {
    expect(firstConnectionFieldError("deploy", "example.com", 0)).not.toBeNull();
  });
});
