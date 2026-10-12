import assert from "node:assert/strict";
import { test } from "node:test";
import { isPublicIpAddress, resolvePublicTarget } from "../../../src/network/public-address.js";

// Independent IANA registry cases, reviewed 2026-10-11. Do not derive from production rules.
// https://www.iana.org/assignments/iana-ipv4-special-registry
// https://www.iana.org/assignments/iana-ipv6-special-registry
const blockedRanges: Array<[string, string]> = [
  ["0.0.0.0", "0.255.255.255"], ["10.0.0.0", "10.255.255.255"], ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"], ["169.254.0.0", "169.254.255.255"], ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"], ["192.0.2.0", "192.0.2.255"], ["192.31.196.0", "192.31.196.255"],
  ["192.52.193.0", "192.52.193.255"], ["192.88.99.0", "192.88.99.255"], ["192.168.0.0", "192.168.255.255"],
  ["192.175.48.0", "192.175.48.255"], ["198.18.0.0", "198.19.255.255"], ["198.51.100.0", "198.51.100.255"],
  ["203.0.113.0", "203.0.113.255"], ["224.0.0.0", "239.255.255.255"], ["240.0.0.0", "255.255.255.255"],
  ["::", "::1"], ["::ffff:0:0", "::ffff:ffff:ffff"], ["64:ff9b::", "64:ff9b::ffff:ffff"],
  ["64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"], ["100::", "100::ffff:ffff:ffff:ffff"],
  ["100:0:0:1::", "100:0:0:1:ffff:ffff:ffff:ffff"], ["2001::", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"], ["2002::", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["2620:4f:8000::", "2620:4f:8000:ffff:ffff:ffff:ffff:ffff"], ["3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["5f00::", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff"], ["fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"], ["ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
];
test("special-purpose range endpoints and protocol exceptions remain blocked", () => {
  for (const [first, last] of blockedRanges) for (const address of [first, last]) assert.equal(isPublicIpAddress(address), false, address);
  for (const address of ["192.0.0.8", "192.0.0.9", "192.0.0.10", "192.0.0.170", "192.0.0.171", "192.88.99.2", "2001:1::1", "2001:1::2", "2001:1::3", "2001:2::", "2001:3::", "2001:4:112::", "2001:10::", "2001:20::", "2001:30::"]) assert.equal(isPublicIpAddress(address), false, address);
});
test("adjacent global unicast ranges remain usable without widening special-purpose exceptions", () => {
  for (const address of ["1.0.0.0", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255", "128.0.0.0", "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0", "191.255.255.255", "192.0.1.0", "192.0.1.255", "192.0.3.0", "192.31.195.255", "192.31.197.0", "192.52.192.255", "192.52.194.0", "192.88.98.255", "192.88.100.0", "192.167.255.255", "192.169.0.0", "192.175.47.255", "192.175.49.0", "198.17.255.255", "198.20.0.0", "198.51.99.255", "198.51.101.0", "203.0.112.255", "203.0.114.0", "223.255.255.255", "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2001:200::", "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::", "2003::", "2620:4f:7fff:ffff:ffff:ffff:ffff:ffff", "2620:4f:8001::", "3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "3fff:1000::"]) assert.equal(isPublicIpAddress(address), true, address);
});
test("mapped, scoped, malformed and non-standard URL formats cannot bypass public address validation", async () => {
  for (const address of ["::ffff:8.8.8.8", "::ffff:127.0.0.1", "::ffff:c0a8:1", "::8.8.8.8", "2606:4700:4700::1111%eth0", "1.2.3", "010.0.0.1", "0x7f000001", "8.8.8.8 "]) assert.equal(isPublicIpAddress(address), false, address);
  for (const address of ["127.1", "2130706433", "0x7f000001", "0177.0.0.1", "[::ffff:7f00:1]", "[::ffff:8.8.8.8]"]) await assert.rejects(resolvePublicTarget(new URL(`http://${address}/`)), { code: "non_public_address" });
});
