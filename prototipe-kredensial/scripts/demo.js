// Demo alur Gambar 3: penerbitan -> kepemilikan -> verifikasi -> pencabutan.
//   npx hardhat run scripts/demo.js
const { deployWithIssuerA, DATA_LULUSAN } = require("../test/helpers");

const garis = (t) => console.log(`\n=== ${t} ===`);

async function main() {
  const env = await deployWithIssuerA();

  garis("A. PENERBITAN (langkah 1-2)");
  const pkg = await env.issuerA.issue(DATA_LULUSAN, env.holderW.address);
  console.log("cid       :", pkg.vc.cid);
  console.log("komitmen  :", pkg.vc.root, "(Merkle root; satu-satunya yang masuk ledger bersama cid)");
  console.log("status    :", (await env.gateway.getStatus(pkg.vc.cid)).status);

  garis("B. KEPEMILIKAN (langkah 3)");
  env.holder.save(pkg);
  console.log("VC + salt disimpan di dompet lulusan:", pkg.attributes.length, "atribut");

  garis("C. VERIFIKASI (langkah 4-7), pengungkapan selektif: gelar dan tahun lulus");
  const nonce = env.verifier.challenge();
  const presentasi = await env.holder.present(pkg.vc.cid, ["gelar", "tahunLulus"], nonce);
  console.log("atribut diungkap:", presentasi.disclosed.map((d) => d.name).join(", "), "(nilai, NIM, nama tidak ikut)");
  console.log("hasil           :", await env.verifier.verify(presentasi, nonce, { required: ["gelar", "tahunLulus"] }));

  garis("C'. Percobaan menyajikan ulang dengan nonce baru (replay)");
  console.log("hasil           :", await env.verifier.verify(presentasi, env.verifier.challenge()));

  garis("D. PENCABUTAN (langkah 8)");
  await env.issuerA.revoke(pkg.vc.cid, 2);
  const nonce2 = env.verifier.challenge();
  const p2 = await env.holder.present(pkg.vc.cid, ["gelar"], nonce2);
  console.log("hasil           :", await env.verifier.verify(p2, nonce2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
