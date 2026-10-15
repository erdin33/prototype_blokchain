const { ethers } = require("hardhat");
const { Issuer, Holder, Verifier } = require("../offchain/credential");
const { createGateway } = require("../offchain/gateway");

// Data fiktif (tanpa data pribadi nyata)
const DATA_LULUSAN = {
  nama: "Budi Santoso",
  nim: "2210511099",
  gelar: "S.Kom.",
  tahunLulus: "2026",
  nilai: "3.78",
};

/**
 * Menyiapkan jaringan uji: dewan 4 anggota (= 4 validator), guardian, dua penerbit, holder.
 * Alamat penerbit didaftarkan lewat proposal Governance (3 dari 4 suara).
 */
async function deployAll({ timelockDelay = 3600, gatewayLimit } = {}) {
  const [m0, m1, m2, m3, guardian, uniA, uniB, holderW, holder2W, outsider] = await ethers.getSigners();
  const members = [m0, m1, m2, m3];

  const gov = await (await ethers.getContractFactory("Governance")).deploy(members.map((m) => m.address), timelockDelay);
  const issuerReg = await (await ethers.getContractFactory("IssuerRegistry")).deploy(await gov.getAddress(), guardian.address);
  const credReg = await (
    await ethers.getContractFactory("CredentialRegistry")
  ).deploy(await gov.getAddress(), await issuerReg.getAddress());

  /** Ajukan proposal dan beri suara dari `voters` anggota pertama. Mengembalikan id proposal. */
  async function govern(target, fn, args, { votes = 3, timelocked = false } = {}) {
    const data = target.interface.encodeFunctionData(fn, args);
    const targetAddr = await target.getAddress();
    const id = await gov.connect(m0).propose.staticCall(targetAddr, data, timelocked);
    await (await gov.connect(m0).propose(targetAddr, data, timelocked)).wait();
    for (let i = 0; i < votes; i++) await (await gov.connect(members[i]).vote(id)).wait();
    return id;
  }

  const addIssuer = (signer, did, opts) => govern(issuerReg, "addIssuer", [signer.address, did], opts);

  const gateway = createGateway({ credentialRegistry: credReg.connect(ethers.provider), issuerRegistry: issuerReg.connect(ethers.provider), rateLimit: gatewayLimit });
  const registryAddress = await credReg.getAddress();
  const verifier = new Verifier({ gateway, registryAddress });
  const mkIssuer = (signer, did) => new Issuer({ wallet: signer, did, registry: credReg.connect(signer) });

  return {
    members, guardian, uniA, uniB, holderW, holder2W, outsider,
    gov, issuerReg, credReg, govern, addIssuer, gateway, verifier, registryAddress,
    mkIssuer, holder: new Holder({ wallet: holderW }), holder2: new Holder({ wallet: holder2W }),
  };
}

/** Fixture umum: penerbit A (Univ. Siliwangi) sudah terdaftar dan aktif. */
async function deployWithIssuerA(opts) {
  const env = await deployAll(opts);
  await env.addIssuer(env.uniA, "did:web:unsil.ac.id");
  env.issuerA = env.mkIssuer(env.uniA, "did:web:unsil.ac.id");
  return env;
}

/** Terbitkan, simpan di dompet, dan sajikan: pintasan untuk skenario uji. */
async function issueAndPresent(env, names = ["gelar", "tahunLulus"], data = DATA_LULUSAN) {
  const pkg = await env.issuerA.issue(data, env.holderW.address);
  env.holder.save(pkg);
  const nonce = env.verifier.challenge();
  const presentation = await env.holder.present(pkg.vc.cid, names, nonce);
  return { pkg, nonce, presentation };
}

module.exports = { deployAll, deployWithIssuerA, issueAndPresent, DATA_LULUSAN };
