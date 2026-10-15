const { expect } = require("chai");
const { deployAll, deployWithIssuerA, issueAndPresent, DATA_LULUSAN } = require("./helpers");
const { randomId } = require("../offchain/credential");

describe("Fungsional (F-01 s.d. F-11)", () => {
  it("F-01 penerbitan normal: status VALID dan event CredentialIssued", async () => {
    const env = await deployWithIssuerA();
    const cid = randomId();
    const root = randomId();
    await expect(env.credReg.connect(env.uniA).issue(cid, root))
      .to.emit(env.credReg, "CredentialIssued")
      .withArgs(cid, env.uniA.address);
    const s = await env.gateway.getStatus(cid);
    expect(s.status).to.equal("VALID");
    expect(s.commitment).to.equal(root);
    expect(s.issuer).to.equal(env.uniA.address);
  });

  it("F-02 cid ganda ditolak", async () => {
    const env = await deployWithIssuerA();
    const cid = randomId();
    await env.credReg.connect(env.uniA).issue(cid, randomId());
    await expect(env.credReg.connect(env.uniA).issue(cid, randomId())).to.be.revertedWithCustomError(env.credReg, "CidAlreadyUsed");
  });

  it("F-03 verifikasi kredensial valid (alur lengkap)", async () => {
    const env = await deployWithIssuerA();
    const { nonce, presentation } = await issueAndPresent(env);
    const r = await env.verifier.verify(presentation, nonce, { required: ["gelar", "tahunLulus"] });
    expect(r.result).to.equal("VALID");
    expect(r.issuerDid).to.equal("did:web:unsil.ac.id");
    expect(r.attributes).to.deep.equal({ gelar: "S.Kom.", tahunLulus: "2026" });
  });

  it("F-04 pengungkapan selektif: nilai dan NIM tidak terungkap, bukti Merkle sah", async () => {
    const env = await deployWithIssuerA();
    const { nonce, presentation } = await issueAndPresent(env, ["gelar", "tahunLulus"]);
    const names = presentation.disclosed.map((d) => d.name).sort();
    expect(names).to.deep.equal(["gelar", "holder", "tahunLulus"]);
    const raw = JSON.stringify(presentation);
    expect(raw).to.not.include(DATA_LULUSAN.nilai);
    expect(raw).to.not.include(DATA_LULUSAN.nim);
    expect(raw).to.not.include(DATA_LULUSAN.nama);
    expect((await env.verifier.verify(presentation, nonce)).result).to.equal("VALID");
  });

  it("F-05 pencabutan: status REVOKED dan verifikasi gagal", async () => {
    const env = await deployWithIssuerA();
    const { pkg } = await issueAndPresent(env);
    await expect(env.credReg.connect(env.uniA).revoke(pkg.vc.cid, 2)).to.emit(env.credReg, "CredentialRevoked").withArgs(pkg.vc.cid, 2);
    const nonce = env.verifier.challenge();
    const p = await env.holder.present(pkg.vc.cid, ["gelar"], nonce);
    const r = await env.verifier.verify(p, nonce);
    expect(r.result).to.equal("REVOKED");
    expect(r.reason).to.equal("REVOKED");
  });

  it("F-06 penggantian: lama SUPERSEDED, baru VALID", async () => {
    const env = await deployWithIssuerA();
    const { pkg: lama } = await issueAndPresent(env);
    const baru = await env.issuerA.supersede(lama.vc.cid, { ...DATA_LULUSAN, nama: "Budi Santoso Putra" }, env.holderW.address);
    env.holder.save(baru);

    expect((await env.gateway.getStatus(lama.vc.cid)).status).to.equal("SUPERSEDED");
    expect((await env.gateway.getStatus(lama.vc.cid)).newCid).to.equal(baru.vc.cid);
    expect((await env.gateway.getStatus(baru.vc.cid)).status).to.equal("VALID");

    const n1 = env.verifier.challenge();
    expect((await env.verifier.verify(await env.holder.present(lama.vc.cid, ["gelar"], n1), n1)).result).to.equal("REVOKED");
    const n2 = env.verifier.challenge();
    expect((await env.verifier.verify(await env.holder.present(baru.vc.cid, ["gelar"], n2), n2)).result).to.equal("VALID");
  });

  it("F-07 status final: REVOKED/SUPERSEDED tidak bisa kembali ke VALID atau diubah lagi", async () => {
    const env = await deployWithIssuerA();
    const a = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
    const b = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
    await env.issuerA.revoke(a.vc.cid);
    await env.issuerA.supersede(b.vc.cid, DATA_LULUSAN, env.holderW.address);

    for (const c of [a, b]) {
      await expect(env.credReg.connect(env.uniA).revoke(c.vc.cid, 1)).to.be.revertedWithCustomError(env.credReg, "NotValid");
      await expect(env.credReg.connect(env.uniA).supersede(c.vc.cid, randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "NotValid");
      await expect(env.credReg.connect(env.uniA).issue(c.vc.cid, randomId())).to.be.revertedWithCustomError(env.credReg, "CidAlreadyUsed");
    }
  });

  it("F-08 tata kelola: penerbit ditambah dengan 3 dari 4 suara, jejak audit tercatat", async () => {
    const env = await deployAll();
    expect(await env.gov.threshold()).to.equal(3n);
    await env.addIssuer(env.uniB, "did:web:kampus-b.ac.id", { votes: 3 });
    expect(await env.issuerReg.isActive(env.uniB.address)).to.equal(true);
    expect(await env.issuerReg.queryFilter("IssuerAdded")).to.have.length(1);
    for (const ev of ["ProposalCreated", "Voted", "ProposalApproved", "ProposalExecuted"]) {
      expect((await env.gov.queryFilter(ev)).length, ev).to.be.greaterThan(0);
    }
  });

  it("F-09 suara tidak cukup (1 dari 4): usul tidak berlaku", async () => {
    const env = await deployAll();
    const id = await env.addIssuer(env.uniB, "did:web:kampus-b.ac.id", { votes: 1 });
    const p = await env.gov.getProposal(id);
    expect(p.approvedAt).to.equal(0n);
    expect(p.executed).to.equal(false);
    expect(await env.issuerReg.isActive(env.uniB.address)).to.equal(false);
    await expect(env.gov.connect(env.members[3]).execute(id)).to.be.revertedWithCustomError(env.gov, "NotApproved");
  });

  it("F-10 penangguhan guardian: issue ditolak; guardian tidak bisa menerbitkan atau mencabut", async () => {
    const env = await deployWithIssuerA();
    const pkg = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);

    await expect(env.issuerReg.connect(env.guardian).suspend(env.uniA.address)).to.emit(env.issuerReg, "IssuerSuspended");
    await expect(env.credReg.connect(env.uniA).issue(randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "IssuerNotActive");

    // guardian bukan penerbit: tidak bisa menerbitkan dan tidak bisa mencabut kredensial orang lain
    await expect(env.credReg.connect(env.guardian).issue(randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "IssuerNotActive");
    await expect(env.credReg.connect(env.guardian).revoke(pkg.vc.cid, 1)).to.be.revertedWithCustomError(env.credReg, "NotOriginalIssuer");
    // guardian juga tidak bisa menambah/menghapus penerbit
    await expect(env.issuerReg.connect(env.guardian).removeIssuer(env.uniA.address)).to.be.revertedWithCustomError(env.issuerReg, "OnlyGovernance");

    // dewan meninjau, lalu memulihkan
    await env.govern(env.issuerReg, "reinstate", [env.uniA.address]);
    await expect(env.credReg.connect(env.uniA).issue(randomId(), randomId())).to.not.be.reverted;
  });

  it("F-11 offboarding: kredensial lama tetap terverifikasi, penerbitan baru ditolak", async () => {
    const env = await deployWithIssuerA();
    const { nonce, presentation } = await issueAndPresent(env);
    await env.govern(env.issuerReg, "removeIssuer", [env.uniA.address]);

    const r = await env.verifier.verify(presentation, nonce);
    expect(r.result).to.equal("VALID");
    expect(r.issuerStatus).to.equal("REMOVED"); // verifier diberi tahu bahwa penerbit sudah dikeluarkan

    await expect(env.credReg.connect(env.uniA).issue(randomId(), randomId())).to.be.revertedWithCustomError(env.credReg, "IssuerNotActive");
  });
});
