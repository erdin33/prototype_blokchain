// Pohon Merkle atas atribut bersalt (pengungkapan selektif).
//   leaf_i = H(0x00 || salt_i || nama_i || nilai_i)
//   node   = H(0x01 || kiri || kanan)
// Daun diurutkan menurut nama atribut agar root deterministik, lalu dipadatkan
// (padding) sampai pangkat dua supaya bukti hanya berupa daftar sibling + indeks.
const { keccak256, AbiCoder, getBytes, concat, randomBytes, hexlify } = require("ethers");

const coder = AbiCoder.defaultAbiCoder();
const PAD = keccak256("0x02");

function newSalt() {
  return hexlify(randomBytes(32)); // salt acak 32 byte (S-07)
}

function leafHash(salt, name, value) {
  return keccak256(concat(["0x00", coder.encode(["bytes32", "string", "string"], [salt, name, String(value)])]));
}

function nodeHash(l, r) {
  return keccak256(concat(["0x01", getBytes(l), getBytes(r)]));
}

/** @param entries [{name, value, salt}] @returns {root, order, levels} */
function buildTree(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].name === sorted[i - 1].name) throw new Error("nama atribut ganda: " + sorted[i].name);
  }
  let level = sorted.map((e) => leafHash(e.salt, e.name, e.value));
  let size = 1;
  while (size < level.length) size *= 2;
  while (level.length < size) level.push(PAD);
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(nodeHash(level[i], level[i + 1]));
    levels.push(next);
    level = next;
  }
  return { root: level[0], order: sorted.map((e) => e.name), levels };
}

/** Bukti keanggotaan satu atribut: sibling dari daun sampai tepat di bawah root. */
function getProof(tree, name) {
  let index = tree.order.indexOf(name);
  if (index < 0) throw new Error("atribut tidak ada: " + name);
  const proof = [];
  const start = index;
  for (let l = 0; l < tree.levels.length - 1; l++) {
    proof.push(tree.levels[l][index ^ 1]);
    index >>= 1;
  }
  return { index: start, siblings: proof };
}

function verifyProof(root, { salt, name, value }, { index, siblings }) {
  let h = leafHash(salt, name, value);
  let i = index;
  for (const s of siblings) {
    h = i % 2 === 0 ? nodeHash(h, s) : nodeHash(s, h);
    i >>= 1;
  }
  return h === root;
}

module.exports = { newSalt, leafHash, nodeHash, buildTree, getProof, verifyProof };
