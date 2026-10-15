const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { keccak256, toUtf8Bytes, hexlify } = require("ethers");
const { deployAll, deployWithIssuerA, issueAndPresent, DATA_LULUSAN } = require("./helpers");
const { Holder, randomId } = require("../offchain/credential");
const { createGateway, startHttpGateway, HttpGatewayClient, RateLimitError } = require("../offchain/gateway");
const { leafHash } = require("../offchain/merkle");

describe("Keamanan (S-01 s.d. S-14)", () => {
  it("S-01 penerbit tidak terdaftar ditolak", async () => {
    const env = await deployWithIssuerA();
    await expect(env.credReg.connect(env.outsider).issue(randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "IssuerNotActive");
  });

  it("S-02 pencabutan oleh pihak lain ditolak", async () => {
    const env = await deployWithIssuerA();
    await env.addIssuer(env.uniB, "did:web:kampus-b.ac.id");
    const { pkg } = await issueAndPresent(env);
    await expect(env.credReg.connect(env.uniB).revoke(pkg.vc.cid, 1)).to.be.revertedWithCustomError(env.credReg, "NotOriginalIssuer");
    await expect(env.credReg.connect(env.uniB).supersede(pkg.vc.cid, randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "NotOriginalIssuer");
    expect((await env.gateway.getStatus(pkg.vc.cid)).status).to.equal("VALID");
  });

  it("S-03 penerbit ditangguhkan atau dihapus tidak bisa menerbitkan", async () => {
    const env = await deployWithIssuerA();
    await env.issuerReg.connect(env.guardian).suspend(env.uniA.address);
    await expect(env.credReg.connect(env.uniA).issue(randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "IssuerNotActive");
    await env.govern(env.issuerReg, "removeIssuer", [env.uniA.address]);
    await expect(env.credReg.connect(env.uniA).issue(randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "IssuerNotActive");
  });

  it("S-04 pemalsuan isi kredensial: TIDAK COCOK", async () => {
    const env = await deployWithIssuerA();
    const { nonce, presentation } = await issueAndPresent(env, ["gelar", "tahunLulus"]);

    // (a) ubah satu atribut yang diungkap
    const a = structuredClone(presentation);
    a.disclosed.find((d) => d.name === "gelar").value = "S.T.";
    expect((await env.verifier.verify(a, nonce)).result).to.equal("TIDAK COCOK");

    // (b) ganti root dengan root buatan sendiri
    const b = structuredClone(presentation);
    b.vc.root = randomId();
    expect((await env.verifier.verify(b, nonce)).result).to.equal("TIDAK COCOK");

    // (c) tukar cid dengan cid milik kredensial lain (valid di ledger)
    const other = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
    const c = structuredClone(presentation);
    c.vc.cid = other.vc.cid;
    expect((await env.verifier.verify(c, nonce)).result).to.equal("TIDAK COCOK");
  });

  it("S-05 replay presentasi lama dengan nonce baru: gagal", async () => {
    const env = await deployWithIssuerA();
    const { nonce, presentation } = await issueAndPresent(env);
    expect((await env.verifier.verify(presentation, nonce)).result).to.equal("VALID");
    const nonceBaru = env.verifier.challenge();
    const r = await env.verifier.verify(presentation, nonceBaru);
    expect(r.result).to.equal("TIDAK COCOK");
  });

  it("S-06 pencurian presentasi: tanpa kunci holder tidak bisa menyajikan", async () => {
    const env = await deployWithIssuerA();
    const { pkg } = await issueAndPresent(env);
    // pencuri punya salinan paket (VC + salt) tetapi bukan kunci holder
    const pencuri = new Holder({ wallet: env.outsider });
    pencuri.save(pkg);
    const nonce = env.verifier.challenge();
    const p = await pencuri.present(pkg.vc.cid, ["gelar"], nonce);
    const r = await env.verifier.verify(p, nonce);
    expect(r.result).to.equal("TIDAK COCOK");
    expect(r.reason).to.match(/bukan dari holder/);
  });

  it("S-07 tebakan nilai dari komitmen gagal: salt acak 32 byte", async () => {
    const env = await deployWithIssuerA();
    const a = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
    const b = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
    expect(a.vc.root).to.not.equal(b.vc.root); // data sama, root beda

    // serangan kamus atas "nilai" (IPK 0.00 s.d. 4.00) tanpa salt tidak cocok dengan daun mana pun
    const daunNilai = new Set(a.attributes.map((x) => leafHash(x.salt, x.name, x.value)));
    for (let i = 0; i <= 400; i++) {
      const v = (i / 100).toFixed(2);
      const kandidat = [keccak256(toUtf8Bytes(v)), keccak256(toUtf8Bytes("nilai" + v)), leafHash(ethers.ZeroHash, "nilai", v)];
      for (const k of kandidat) {
        expect(daunNilai.has(k)).to.equal(false);
        expect(a.vc.root).to.not.equal(k);
      }
    }
    for (const x of a.attributes) expect(ethers.getBytes(x.salt)).to.have.length(32);
  });

  it("S-08 tidak ada data pribadi di ledger (transaksi, event, log gateway)", async () => {
    const env = await deployWithIssuerA();
    const { pkg } = await issueAndPresent(env);
    await env.issuerA.revoke(pkg.vc.cid, 2);
    const baru = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
    await env.issuerA.supersede(baru.vc.cid, DATA_LULUSAN, env.holderW.address);

    const rahasia = Object.entries(DATA_LULUSAN)
      .filter(([k]) => ["nama", "nim", "nilai"].includes(k))
      .map(([, v]) => ({ v, hex: hexlify(toUtf8Bytes(v)).slice(2) }));

    const latest = await ethers.provider.getBlockNumber();
    let diperiksa = 0;
    for (let n = 0; n <= latest; n++) {
      const block = await ethers.provider.getBlock(n, true);
      for (const tx of block.prefetchedTransactions) {
        const rc = await ethers.provider.getTransactionReceipt(tx.hash);
        const isi = (tx.data + rc.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
        for (const r of rahasia) expect(isi.includes(r.hex), `${r.v} muncul di tx ${tx.hash}`).to.equal(false);
        diperiksa++;
      }
    }
    expect(diperiksa).to.be.greaterThan(5);

    // keluaran gateway juga bersih
    const out = JSON.stringify([await env.gateway.getStatus(pkg.vc.cid), await env.gateway.getIssuer(env.uniA.address)]);
    for (const r of rahasia) expect(out).to.not.include(r.v);
  });

  it("S-09 / S-10 validator Bizantin (f = 1) dan melebihi toleransi", function () {
    // Perilaku konsensus QBFT tidak bisa diuji di jaringan Hardhat (satu node). Uji ini dijalankan
    // di jaringan Besu 4 validator: lihat besu/README.md bagian "S-09 dan S-10".
    this.skip();
  });

  it("S-11 akses tulis lewat gateway ditolak (in-process dan REST)", async () => {
    const env = await deployWithIssuerA();
    let galat;
    try {
      await env.gateway.sendTransaction({ to: env.registryAddress, data: "0x" });
    } catch (e) {
      galat = e;
    }
    expect(galat).to.be.instanceOf(Error);
    expect(galat.message).to.match(/baca-saja/);

    const { server, url } = await startHttpGateway(env.gateway);
    try {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const r = await fetch(url + "/status/" + randomId(), { method, body: "{}" });
        expect(r.status, method).to.equal(405);
      }
      // klien REST membaca status dengan benar
      const { pkg } = await issueAndPresent(env);
      const s = await new HttpGatewayClient(url).getStatus(pkg.vc.cid);
      expect(s.status).to.equal("VALID");
    } finally {
      server.close();
    }
  });

  it("S-12 banjir permintaan dibatasi rate limit (in-process dan REST)", async () => {
    const env = await deployWithIssuerA({ gatewayLimit: { max: 5, windowMs: 10_000 } });
    let ditolak = 0;
    for (let i = 0; i < 20; i++) {
      try {
        await env.gateway.getStatus(randomId());
      } catch (e) {
        if (e instanceof RateLimitError) ditolak++;
      }
    }
    expect(ditolak).to.equal(15);

    const gw = createGateway({
      credentialRegistry: env.credReg.connect(ethers.provider),
      issuerRegistry: env.issuerReg.connect(ethers.provider),
      rateLimit: { max: 5, windowMs: 10_000 },
    });
    const { server, url } = await startHttpGateway(gw);
    try {
      const kode = [];
      for (let i = 0; i < 12; i++) kode.push((await fetch(url + "/status/" + randomId())).status);
      expect(kode.filter((k) => k === 200)).to.have.length(5);
      expect(kode.filter((k) => k === 429)).to.have.length(7);
    } finally {
      server.close();
    }
  });

  it("S-13 upgrade kontrak tanpa persetujuan atau sebelum time-lock selesai ditolak", async function () {
    if (network.name !== "hardhat") this.skip(); // butuh pemajuan waktu
    const env = await deployWithIssuerA({ timelockDelay: 3600 });
    const baru = await (await ethers.getContractFactory("IssuerRegistry")).deploy(await env.gov.getAddress(), env.guardian.address);

    // tanpa lewat tata kelola
    await expect(env.credReg.connect(env.members[0]).setIssuerRegistry(await baru.getAddress())).to.be.revertedWithCustomError(env.credReg, "OnlyGovernance");
    // bukan anggota dewan
    await expect(env.gov.connect(env.outsider).propose(env.registryAddress, "0x", true)).to.be.revertedWithCustomError(env.gov, "NotMember");

    // suara kurang dari 2/3: tidak disetujui
    const kurang = await env.govern(env.credReg, "setIssuerRegistry", [await baru.getAddress()], { votes: 2, timelocked: true });
    await expect(env.gov.connect(env.members[0]).execute(kurang)).to.be.revertedWithCustomError(env.gov, "NotApproved");

    // suara cukup, tetapi time-lock belum lewat
    const id = await env.govern(env.credReg, "setIssuerRegistry", [await baru.getAddress()], { votes: 3, timelocked: true });
    await expect(env.gov.connect(env.members[0]).execute(id)).to.be.revertedWithCustomError(env.gov, "TimelockActive");
    expect(await env.credReg.issuerRegistry()).to.equal(await env.issuerReg.getAddress());

    // setelah time-lock lewat: berlaku, dan tercatat sebagai event
    await time.increase(3601);
    await expect(env.gov.connect(env.members[0]).execute(id)).to.emit(env.gov, "ProposalExecuted").withArgs(id);
    expect(await env.credReg.issuerRegistry()).to.equal(await baru.getAddress());
    // eksekusi ulang ditolak
    await expect(env.gov.connect(env.members[0]).execute(id)).to.be.revertedWithCustomError(env.gov, "AlreadyExecuted");
  });

  it("S-14 kunci penerbit bocor: setelah dicabut lewat voting, kunci itu tidak bisa dipakai", async () => {
    const env = await deployWithIssuerA();
    // penyerang memegang kunci uniA dan masih bisa menerbitkan sebelum pencabutan
    await expect(env.credReg.connect(env.uniA).issue(randomId(), randomId())).to.not.be.reverted;
    await env.govern(env.issuerReg, "removeIssuer", [env.uniA.address]);
    await expect(env.credReg.connect(env.uniA).issue(randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "IssuerNotActive");
    // penyerang juga tidak bisa mencabut/mengganti kredensial lama
    const lama = await env.credReg.queryFilter("CredentialIssued");
    await expect(env.credReg.connect(env.uniA).revoke(lama[0].args.cid, 1)).to.be.revertedWithCustomError(env.credReg, "IssuerNotActive");
  });
});
