import ssh2 from "ssh2";
const { Client, utils } = ssh2;
const k = utils.generateKeyPairSync("ed25519");
const fp = utils.parseKey(k.private);
console.log("keygen ok:", typeof k.private === "string", "parseKey ok:", !(fp instanceof Error));
const c = new Client();
console.log("client ok:", typeof c.connect, typeof c.exec, typeof c.forwardIn, typeof c.forwardOut, typeof c.shell);
console.log("node:", process.versions.node, "electron:", process.versions.electron);
// hash used for TOFU fingerprints - sha256 base64 no padding
const h = (await import("node:crypto")).createHash("sha256").update(Buffer.from("probe")).digest("base64").replace(/=+$/, "");
console.log("fp fmt:", "SHA256:" + h);
