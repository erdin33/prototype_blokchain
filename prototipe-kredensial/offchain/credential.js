// Aktor off-chain: Issuer, Holder, Verifier (Gambar 3, langkah 1-8).
const { keccak256, AbiCoder, getBytes, hexlify, randomBytes, verifyMessage, getAddress } = require("ethers");
const { newSalt, buildTree, getProof, verifyProof } = require("./merkle");

const coder = AbiCoder.defaultAbiCoder();

// Digest yang ditandatangani. Diikat ke alamat registri (deployment) dan cid.
function rootDigest(registryAddress, cid, root) {
  return keccak256(coder.encode(["string", "address", "bytes32", "bytes32"], ["VC-ROOT-V1", registryAddress, cid, root]));
}
function nonceDigest(cid, nonce) {
  return keccak256(coder.encode(["string", "bytes32", "bytes32"], ["VP-NONCE-V1", cid, nonce]));
}

const randomId = () => hexlify(randomBytes(32));

// ---------------------------------------------------------------- ISSUER
class Issuer {
  /** @param wallet penanda tangan (produksi: kunci di HSM)  @param registry CredentialRegistry yang terhubung ke wallet */
  constructor({ wallet, did, registry }) {
    this.wallet = wallet;
    this.did = did;
    this.registry = registry;
  }

  /** Buat paket kredensial: atribut bersalt + Merkle root + tanda tangan penerbit. Belum menyentuh ledger. */
  async _build(attrs, holderAddress, cid) {
    const entries = Object.entries({ ...attrs, holder: getAddress(holderAddress) }).map(([name, value]) => ({
      name,
      value: String(value),
      salt: newSalt(),
    }));
    const tree = buildTree(entries);
    const registryAddress = await this.registry.getAddress();
    const signature = await this.wallet.signMessage(getBytes(rootDigest(registryAddress, cid, tree.root)));
    return {
      vc: {
        cid,
        issuer: { did: this.did, address: this.wallet.address },
        holder: getAddress(holderAddress),
        root: tree.root,
        proof: { type: "EthereumPersonalSign", signature },
      },
      attributes: entries, // dikirim ke holder lewat kanal terenkripsi (VC + salt)
    };
  }

  /** Langkah 1-3: terbitkan kredensial. */
  async issue(attrs, holderAddress, { cid = randomId() } = {}) {
    const pkg = await this._build(attrs, holderAddress, cid);
    const tx = await this.registry.issue(cid, pkg.vc.root);
    await tx.wait();
    return pkg;
  }

  /** Langkah 8: cabut. reasonCode berupa kode, bukan teks bebas (tanpa PII). */
  async revoke(cid, reasonCode = 2) {
    const tx = await this.registry.revoke(cid, reasonCode);
    await tx.wait();
  }

  /** Langkah 8: ganti (koreksi data / pemulihan kunci holder). Kredensial lama menjadi SUPERSEDED. */
  async supersede(oldCid, attrs, holderAddress, { newCid = randomId() } = {}) {
    const pkg = await this._build(attrs, holderAddress, newCid);
    const tx = await this.registry.supersede(oldCid, newCid, pkg.vc.root);
    await tx.wait();
    return pkg;
  }
}

// ---------------------------------------------------------------- HOLDER
class Holder {
  constructor({ wallet }) {
    this.wallet = wallet;
    this.store = new Map(); // cid -> paket kredensial (dompet)
  }

  save(pkg) {
    this.store.set(pkg.vc.cid, pkg);
  }

  /** Langkah 5: sajikan hanya atribut yang diminta + bukti Merkle + tanda tangan atas nonce. */
  async present(cid, requestedNames, nonce) {
    const pkg = this.store.get(cid);
    if (!pkg) throw new Error("kredensial tidak ada di dompet");
    const tree = buildTree(pkg.attributes);
    if (tree.root !== pkg.vc.root) throw new Error("dompet rusak: root tidak cocok");
    // atribut "holder" selalu disertakan agar verifier bisa mengikat tanda tangan nonce ke kunci holder
    const names = [...new Set([...requestedNames, "holder"])];
    const disclosed = names.map((name) => {
      const a = pkg.attributes.find((x) => x.name === name);
      if (!a) throw new Error("atribut tidak ada: " + name);
      return { name, value: a.value, salt: a.salt, proof: getProof(tree, name) };
    });
    const nonceSig = await this.wallet.signMessage(getBytes(nonceDigest(cid, nonce)));
    return { vc: pkg.vc, disclosed, nonceSig };
  }
}

// ---------------------------------------------------------------- VERIFIER
const TIDAK_COCOK = "TIDAK COCOK";

class Verifier {
  /** @param gateway antarmuka baca-saja (getStatus, getIssuer) @param registryAddress alamat CredentialRegistry */
  constructor({ gateway, registryAddress }) {
    this.gateway = gateway;
    this.registryAddress = registryAddress;
  }

  /** Langkah 4: tantangan nonce acak, sekali pakai per sesi verifikasi. */
  challenge() {
    return randomId();
  }

  /** Langkah 6-7. Hasil: VALID / REVOKED / TIDAK COCOK, beserta alasan. */
  async verify(presentation, nonce, { required = [] } = {}) {
    const fail = (reason) => ({ result: TIDAK_COCOK, reason });
    try {
      const { vc, disclosed, nonceSig } = presentation;

      // 1. Tanda tangan nonce harus berasal dari holder yang tercantum di dalam kredensial
      const holderAttr = disclosed.find((d) => d.name === "holder");
      if (!holderAttr) return fail("atribut holder tidak disertakan");
      let nonceSigner;
      try {
        nonceSigner = verifyMessage(getBytes(nonceDigest(vc.cid, nonce)), nonceSig);
      } catch {
        return fail("tanda tangan nonce tidak valid");
      }
      if (nonceSigner !== getAddress(holderAttr.value)) return fail("tanda tangan nonce bukan dari holder");

      // 2. Tanda tangan penerbit atas (cid, root)
      let issuerSigner;
      try {
        issuerSigner = verifyMessage(getBytes(rootDigest(this.registryAddress, vc.cid, vc.root)), vc.proof.signature);
      } catch {
        return fail("tanda tangan penerbit tidak valid");
      }

      // 3. Setiap atribut yang diungkap harus terbukti anggota Merkle root
      for (const d of disclosed) {
        if (!verifyProof(vc.root, d, d.proof)) return fail(`bukti Merkle gagal untuk atribut "${d.name}"`);
      }
      for (const name of required) {
        if (!disclosed.some((d) => d.name === name)) return fail(`atribut wajib tidak diungkap: ${name}`);
      }

      // 4. Status dan komitmen dari ledger (lewat gateway)
      const onchain = await this.gateway.getStatus(vc.cid);
      if (onchain.status === "NONE") return fail("cid tidak terdaftar di ledger");
      if (onchain.commitment !== vc.root) return fail("komitmen on-chain tidak sama dengan root");
      if (getAddress(onchain.issuer) !== issuerSigner) return fail("penandatangan bukan penerbit kredensial");
      const issuer = await this.gateway.getIssuer(onchain.issuer);
      if (issuer.status === "NONE") return fail("penerbit tidak terdaftar");

      const attributes = Object.fromEntries(disclosed.filter((d) => d.name !== "holder").map((d) => [d.name, d.value]));
      const base = { attributes, issuerDid: issuer.did, issuerStatus: issuer.status };
      if (onchain.status === "VALID") return { result: "VALID", ...base };
      return { result: "REVOKED", reason: onchain.status, newCid: onchain.newCid, ...base };
    } catch (e) {
      return fail("galat verifikasi: " + e.message);
    }
  }
}

module.exports = { Issuer, Holder, Verifier, rootDigest, nonceDigest, randomId, TIDAK_COCOK };
