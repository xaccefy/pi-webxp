import assert from "node:assert";
import { describe, it } from "node:test";
import { isPublicIpAddress } from "@xaccefy/pi-shared";

describe("network-safety: isPublicIpAddress", () => {
  it("rejects private and reserved IPv4 ranges", () => {
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "192.168.1.1",
      "172.16.0.1",
      "169.254.1.1",
      "0.0.0.0",
    ]) {
      assert.strictEqual(isPublicIpAddress(ip), false, ip);
    }
  });

  it("accepts public IPv4 and IPv6", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111", "2a00:1450::1"]) {
      assert.strictEqual(isPublicIpAddress(ip), true, ip);
    }
  });

  it("rejects loopback, link-local, unique-local, and mapped-private IPv6", () => {
    for (const ip of ["::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.2"]) {
      assert.strictEqual(isPublicIpAddress(ip), false, ip);
    }
  });

  it("rejects 6to4 and Teredo transition addresses", () => {
    for (const ip of [
      "2002:c0a8:0101::1",
      "2002:0808:0808::1",
      "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
      "2001:0:53aa:64c:0:3f4d:5994:bb8",
    ]) {
      assert.strictEqual(isPublicIpAddress(ip), false, ip);
    }
  });
});
