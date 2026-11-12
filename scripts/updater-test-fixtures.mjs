// THROWAWAY test fixtures for scripts/updater-signature.test.mjs and
// scripts/updater-key.test.mjs — two key pairs made by `tauri signer generate --ci`
// (tauri-cli 2.11.2, no passphrase, like the release key) and one signature made by
// `tauri signer sign` with key A. No app trusts these keys; the release key is not here.

export const KEY_A = {
  id: "72D6831D2093C167",
  privateKey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5VFpKdDErMkYwMGlUNWl1cWR6azFjUE40TDhSODJJRDFjTWZYOGMybEJWY0FBQkFBQUFBQUFBQUFBQUlBQUFBQUtCZ1ZNUDRlTDFybVFSWkxkTXlxZE90YTZrOVVPR01EOWRtQmh2dFFrQmdqb0dBd2tLTExYckcxVzhCYUp2RHN6T3dOcmZhNGErUVhTajNIV0ZMZTh6dit1WEtpSGdhUVd2NXRGREFSUGtSNkNhWkRCV2FjeWFweVIvQ1NkTW54VmxURXB0eFR6UzA9Cg==",
  publicKey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDcyRDY4MzFEMjA5M0MxNjcKUldSbndaTWdIWVBXY2xEcW1BcjdhM0ZmRlA4RUQyZjFqSXE0WE40OWQ0eVRvODNjSnFQTWtJMzMK",
};

export const KEY_B = {
  id: "19B8440893A97AC6",
  privateKey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5TlMzZlpyYnFXT04xbFNuRWVhb29FRGFNRG04NVZGbUx4SDVrWUtGR3A0NEFBQkFBQUFBQUFBQUFBQUlBQUFBQVlBR1lxWVlZMnJvcjNFSmxZZEs4YlZmK3Urbk0rT1RsY1N3SmJ4RXpwb0V4UUFOQStaWXhCeFBUUHZPTlh6QXE5MnFwUUVleExNdHlLTDBFbTZUT1g3Y3hkSE9KaEZBVzRJdHYrZjFFdWxoR3kySHNFcmNsRnhGSENNb2VDK05wbVhXZVgzUEpmcXM9Cg==",
  publicKey:
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE5Qjg0NDA4OTNBOTdBQzYKUldUR2VxbVRDRVM0R1J0TVlPZjkxRGlyb1psMGhXYW5VR01XVk9JV3RSem85WUxTdWVzR1pRNzQK",
};

export const PAYLOAD = Buffer.from("Flight Deck updater signature fixture\n", "utf8");

/** `tauri signer sign -f a.key payload.txt` → payload.txt.sig (a prehashed signature). */
export const PAYLOAD_SIGNATURE_BY_A =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSbndaTWdIWVBXY2hIUFNmelVScUREOVFwUVFkU0cxK2hKd0FWVUpqWFRad1NtSFhVNEZza1p1N1MxWlhGVXhTandrV2M2UlZDNjhkYW9GTjlPaTR5b1o2N0FIdlVVdHcwPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyMzM0NTUzCWZpbGU6cGF5bG9hZC50eHQKNkxYbW9YWnczSGVZbWhiRkJVYVZZOUpraUhhc0p6YnNETklHbkxoQ0dFWlQrT3p3a1ZlUTNuVFczNEszNU44dHpPK2xIMGF3dUxtRCt5RldNK2hEQkE9PQo=";
